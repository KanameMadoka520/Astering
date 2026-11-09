import {CancelledError, useQuery} from '@tanstack/vue-query'
import {currentUserQuery, normalizeUserSettings, refreshCurrentUser, type UserInfoResponse} from '@/client/queries/account'
import {computed, onScopeDispose, readonly, ref, watch} from 'vue'
import {acceptHMRUpdate, defineStore} from 'pinia'

import {
	authLogin,
	authRegister,
	authOpenidCallback,
	authLinkShare as authenticateLinkShare,
	authLogout,
	authConfirmEmail,
	tokenRenew,
} from '@/client/generated'
import {getBrowserLanguage, i18n, setLanguage, type SupportedLocale} from '@/i18n'
import {getDisplayName} from '@/helpers/user'
import {invalidateAvatarQueries} from '@/client/queries/avatars'
import type {RegisterUserRequestWritable, UserInfoBody, VikunjaErrorModel} from '@/client/generated'
import {registerViaInviteLink} from '@/client/inviteLink'
import {parseValidationErrors} from '@/helpers/parseValidationErrors'
import {
	getAuthSessionEpoch,
	isTokenExpired,
	onAuthIdentityChanged,
	withAuthSessionLock,
	getToken,
	refreshToken,
	RefreshTokenError,
	removeToken,
	saveToken,
} from '@/helpers/auth'
import {MILLISECONDS_A_SECOND} from '@/constants/date'
import {serverNowSeconds} from '@/helpers/serverClock'
import {useWebSocket} from '@/composables/useWebSocket'
import {redirectToLastVisited} from '@/composables/useRedirectToLastVisited'
import {setModuleLoading} from '@/stores/helper'
import {
	getRedirectUrlFromCurrentFrontendPath,
	redirectToProvider,
	redirectToProviderOnLogout,
} from '@/helpers/redirectToProvider'
import {
	AUTH_TYPES,
	ERROR_CODE_ACCOUNT_DISABLED,
	ERROR_CODE_ACCOUNT_LOCKED,
	ERROR_CODE_TOTP_REQUIRED,
	ERROR_CODE_USER_DOES_NOT_EXIST,
	type AuthType,
} from '@/constants/auth'

import router from '@/router'
import {navigableUrl, useConfigStore} from '@/stores/config'
import type {IProvider} from '@/types/IProvider'
import {queryClient} from '@/client/queryClient'
import {
	captureClientRequestContext,
	assertClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
	type ClientRequestContext,
} from '@/client/requestContext'
import {clearStorageKeepingScopedDrafts} from '@/helpers/localDrafts'
import {clearDeviceAccounts, deviceAccountKeys, forgetDeviceAccount, logoutCurrentDeviceAccount, rememberCurrentDeviceAccount, selectDeviceAccount} from '@/client/queries/accountSessions'
import {error as showError} from '@/message'

const ACCOUNT_GONE_ERROR_CODES: readonly number[] = [
	ERROR_CODE_USER_DOES_NOT_EXIST,
	ERROR_CODE_ACCOUNT_DISABLED,
	ERROR_CODE_ACCOUNT_LOCKED,
]

export type SessionClaims = {
	id: number,
	type: AuthType,
	exp: number,
}

type JwtClaims = SessionClaims & {
	username?: string,
	is_admin?: boolean,
	sid?: string,
}

type UserInfoScope = {
	context: ClientRequestContext
	id: number
	type: AuthType
	sid: string | null
}

const USER_INFO_REFRESH_MS = 60_000
const MAX_USER_INFO_RETRY_MS = 10 * USER_INFO_REFRESH_MS

// is_admin is deliberately absent: it comes from GET /user, never from the unverified JWT.
function userFromClaims({id, username}: JwtClaims): UserInfoBody {
	return {
		id,
		username,
	}
}

// Set on explicit logout so the login page won't immediately bounce the user
// back to the OIDC provider. Lives in sessionStorage so it survives the
// round-trip to the IdP within the tab and isn't wiped by localStorage.clear().
export const JUST_LOGGED_OUT_KEY = 'justLoggedOut'

function redirectToSpecifiedProvider() {

	const {auth} = useConfigStore()
	const searchParams = new URLSearchParams(window.location.search)
	if (searchParams.has('redirectToProvider')) {

		const redirectToProviderValue = searchParams.get('redirectToProvider')

		if (
			auth.openid_connect.providers?.length === 1
			&& (window.location.pathname.startsWith('/login') || window.location.pathname === '/') // Kinda hacky, but prevents an endless loop.
			&& (redirectToProviderValue === null
				|| redirectToProviderValue === 'true'
				|| redirectToProviderValue === '1')
 		) {
			redirectToProvider(auth.openid_connect.providers[0])
		}

		// let's try to find the provider to logon to !
		const wantedProvider = auth.openid_connect.providers?.find(p => p.key === redirectToProviderValue)
		if (wantedProvider) {
			redirectToProvider(wantedProvider)
		}
		console.warn(`Could not find provider to redirect to.\nWanted: ${wantedProvider}\nAvailable: ${auth.openid_connect.providers?.map(p => p.key)}`)
	}
}

// pkg/models ErrCodeNoRefreshToken
const ERROR_CODE_NO_REFRESH_TOKEN = 16005

function refreshFailure(e: unknown) {
	return e instanceof RefreshTokenError ? e.failure : undefined
}

// A race-loser's rotated cookie makes a second attempt succeed, and a one-off 5xx
// often clears too. Exactly one retry so a dead session still logs out; network
// errors, rate limits and a missing cookie won't clear in milliseconds.
async function refreshTokenWithRetry(persist: boolean): Promise<void> {
	try {
		await refreshToken(persist)
	} catch (e) {
		const failure = refreshFailure(e)
		const retryable = !failure
			|| failure.kind === 'server'
			|| (failure.kind === 'rejected' && failure.code !== ERROR_CODE_NO_REFRESH_TOKEN)
		if (!retryable) {
			throw e
		}
		await refreshToken(persist)
	}
}

function getLoggedInVia(): string | null {
	return localStorage.getItem('loggedInViaProvider')
}

function setLoggedInVia(provider: string | null): void {
	if (provider) {
		localStorage.setItem('loggedInViaProvider', provider)
	} else {
		localStorage.removeItem('loggedInViaProvider')
	}
}

export const useAuthStore = defineStore('auth', () => {
	const configStore = useConfigStore()
	
	const authenticated = ref(false)
	const needsTotpPasscode = ref(false)
	
	const session = ref<JwtClaims | null>(null)
	// The query key carries the identity and setSession() clears the cache, so a cached account
	// always belongs to the current session.
	const account = useQuery(computed(() => ({
		...currentUserQuery(session.value?.id ?? 0, session.value?.type ?? AUTH_TYPES.USER),
		enabled: authenticated.value && session.value?.type === AUTH_TYPES.USER,
	})), queryClient)
	const currentAccount = computed(() => account.data.value ?? null)
	// The JWT carries id and username, so the header renders before GET /user answers.
	const info = computed(() => currentAccount.value ?? (session.value ? userFromClaims(session.value) : null))
	const settings = computed(() => normalizeUserSettings(account.data.value?.settings))
	watch(() => settings.value.frontend_settings.desktop_quick_entry_shortcut, shortcut => {
		window.vikunjaDesktop?.updateQuickEntryShortcut(shortcut || '')
	}, {immediate: true})
	
	const currentSessionId = ref<string | null>(null)
	const lastUserInfoRefresh = ref<Date | null>(null)
	let verifiedUserInfoScope: UserInfoScope | null = null
	let userInfoFailures = 0
	let nextUserInfoRetryAt = 0
	let userInfoRefresh: {
		scope: UserInfoScope
		promise: Promise<UserInfoResponse | undefined>
	} | null = null
	// The JWT whose refresh failed for good this boot.
	let failedRefresh: string | null = null
	let refreshRetryTimer: ReturnType<typeof setTimeout> | undefined
	const isLoading = ref(false)

	const authUser = computed(() => authenticated.value && session.value?.type === AUTH_TYPES.USER)

	const authLinkShare = computed(() => authenticated.value && session.value?.type === AUTH_TYPES.LINK_SHARE)

	const userDisplayName = computed(() => info.value ? getDisplayName(info.value) : undefined)
	
	const isLinkShareAuth = computed(() => session.value?.type === AUTH_TYPES.LINK_SHARE)

	const identityKey = computed(() => `${session.value?.id ?? ''}:${session.value?.type ?? ''}`)

	function setIsLoading(newIsLoading: boolean) {
		isLoading.value = newIsLoading 
	}

	function setSession(claims: JwtClaims | null) {
		const identityChanged = session.value?.id !== claims?.id || session.value?.type !== claims?.type
		if (identityChanged) {
			queryClient.clear()
			resetUserInfoVerification()
		}
		const usernameChanged = session.value?.username !== claims?.username
		session.value = claims
		currentSessionId.value = claims?.sid ?? null
		if (identityChanged) useWebSocket().closeStaleConnection()
		if (usernameChanged && claims) invalidateAvatar()
		return identityChanged
	}

	function setAuthenticated(newAuthenticated: boolean) {
		authenticated.value = newAuthenticated
	}


	function setNeedsTotpPasscode(newNeedsTotpPasscode: boolean) {
		needsTotpPasscode.value = newNeedsTotpPasscode
	}

	function invalidateAvatar() {
		if (!info.value?.username) {
			return
		}
		invalidateAvatarQueries(info.value.username)
	}

	function updateLastUserRefresh() {
		lastUserInfoRefresh.value = new Date()
	}

	function resetUserInfoVerification() {
		verifiedUserInfoScope = null
		userInfoFailures = 0
		nextUserInfoRetryAt = 0
	}

	function userInfoScope(): UserInfoScope {
		return {
			context: captureClientRequestContext(),
			id: session.value?.id ?? 0,
			type: session.value?.type ?? AUTH_TYPES.USER,
			sid: session.value?.sid ?? null,
		}
	}

	function isUserInfoScopeCurrent(scope: UserInfoScope): boolean {
		return isClientRequestContextCurrent(scope.context)
			&& scope.id === (session.value?.id ?? 0)
			&& scope.type === (session.value?.type ?? AUTH_TYPES.USER)
			&& scope.sid === (session.value?.sid ?? null)
	}

	function cancelRefreshRetry() {
		clearTimeout(refreshRetryTimer)
		refreshRetryTimer = undefined
	}

	function scheduleRefreshRetry(retryAt: number, epoch: number, retry: () => Promise<unknown>) {
		if (getAuthSessionEpoch() !== epoch) {
			return
		}
		cancelRefreshRetry()
		refreshRetryTimer = setTimeout(() => {
			if (getAuthSessionEpoch() !== epoch) {
				return
			}
			retry().catch(error => console.error('Scheduled token refresh failed:', error))
		}, Math.max(retryAt - Date.now(), MILLISECONDS_A_SECOND))
	}

	// Every attempt replaces the pending retry, so a success leaves none behind.
	async function refreshUserToken(retry: () => Promise<unknown>) {
		cancelRefreshRetry()
		const epoch = getAuthSessionEpoch()
		try {
			await refreshTokenWithRetry(true)
		} catch (e) {
			const failure = refreshFailure(e)
			if (failure?.kind === 'rate-limited' && failure.retryAt !== undefined) {
				scheduleRefreshRetry(failure.retryAt, epoch, retry)
			}
			throw e
		}
	}

	// Explicit login must verify this account before navigation can reuse its metadata.
	function adoptSession(token: string | undefined, persist: boolean) {
		if (!token) throw new Error('Authentication response has no token')
		saveToken(token, persist)
		lastUserInfoRefresh.value = null
		resetUserInfoVerification()
	}

	// Logs a user in with a set of credentials.
	async function login(credentials: {
		username?: string,
		password?: string,
		totpPasscode?: string,
		longToken?: boolean,
 rememberAccount?: boolean,
	}) {
		setIsLoading(true)

		// Delete an eventually preexisting old token
		removeToken()

		const loginContext = captureClientRequestContext()
		try {
			const response = await withAuthSessionLock(async () => {
				assertClientRequestContext(loginContext)
				const response = await authLogin({
					body: {
						username: credentials.username,
						password: credentials.password,
						totp_passcode: credentials.totpPasscode,
						long_token: credentials.longToken,
					},
				})
				assertClientRequestContext(loginContext)
				adoptSession(response.data.token, true)
				return response
			})
			if (!response.data.token) throw new Error('Authentication response has no token')

			// Tell others the user is authenticated
			await checkAuth()
			if (credentials.rememberAccount) {
				try { await rememberAccount() } catch { showError(i18n.global.t('accountSwitch.rememberFailed')) }
			}
		} catch (e) {
			if (
				(e as VikunjaErrorModel)?.code === ERROR_CODE_TOTP_REQUIRED &&
				!credentials.totpPasscode
			) {
				setNeedsTotpPasscode(true)
			}

			throw e
		} finally {
			setIsLoading(false)
		}
	}

	/**
	 * Registers a new user and logs them in.
	 * Not sure if this is the right place to put the logic in, maybe a separate js component would be better suited. 
	 */
	async function register(credentials: RegisterUserRequestWritable, language: string|null = null, viaInvite = false) {
		setIsLoading(true)
		
		if (!language) {
			language = i18n.global.locale.value ?? getBrowserLanguage()
		}
		
		try {
			if (viaInvite) {
				await registerViaInviteLink({...credentials, language})
			} else {
				await authRegister({body: {...credentials, language}})
			}
			return await login(credentials)
		} catch (e) {
			const problem = e as VikunjaErrorModel & {message?: string}
			if (problem.code === 2002 && parseValidationErrors(problem).language) {
				return register(credentials, 'en', viaInvite)
			}

			if (problem.detail) {
				throw {...problem, message: problem.detail}
			}
			if (problem.message) {
				throw problem
			}

			throw e
		} finally {
			setIsLoading(false)
		}
	}

	function registerWithInvite(credentials: RegisterUserRequestWritable) {
		return register(credentials, null, true)
	}

	async function openIdAuth({provider, code, totpPasscode}: {provider: string, code: string, totpPasscode?: string}) {
		setIsLoading(true)
		setLoggedInVia(null)

		const fullProvider = configStore.auth.openid_connect.providers.find((p: IProvider) => p.key === provider)

		if (!fullProvider) {
			setIsLoading(false)
			throw new Error(`Unknown OpenID provider: ${provider}`)
		}

		const data: Record<string, string> = {
			code: code,
			redirect_url: getRedirectUrlFromCurrentFrontendPath(fullProvider),
		}
		if (totpPasscode) {
			data.totp_passcode = totpPasscode
		}

		// Delete an eventually preexisting old token
		removeToken()
		try {
			const response = await authOpenidCallback({path: {provider}, body: data})
			adoptSession(response.data.token, true)
			setLoggedInVia(provider)

			// Tell others the user is authenticated
			await checkAuth()
		} finally {
			setIsLoading(false)
		}
	}

	async function handleDesktopOAuthTokens(tokens: {access_token: string, refresh_token: string, expires_in: number}) {
		setIsLoading(true)
		try {
			removeToken()
			adoptSession(tokens.access_token, true)
			localStorage.setItem('desktopOAuthRefreshToken', tokens.refresh_token)
			await checkAuth()
		} finally {
			setIsLoading(false)
		}
	}

	async function linkShareAuth({hash, password}: {hash: string, password?: string}) {
		const response = await authenticateLinkShare({path: {share: hash}, body: {password}})
		if (!response.data.project_id) throw new Error('Link share response has no project')
		adoptSession(response.data.token, false)
		await checkAuth()
		return {...response.data, project_id: response.data.project_id}
	}

	// The guard sent the user to the login page when the original check failed.
	// A login meanwhile does its own redirect.
	async function retryCheckAuth() {
		const epoch = getAuthSessionEpoch()
		await checkAuth()
		if (
			getAuthSessionEpoch() === epoch
			&& authenticated.value
			&& router.currentRoute.value.name === 'user.login'
		) {
			await redirectToLastVisited(router)
		}
	}

	/**
	 * Populates user information from jwt token saved in local storage in store
	 */
	async function checkAuth({forceUserInfo = false}: {forceUserInfo?: boolean} = {}) {
		const jwt = getToken()
		let isAuthenticated = false
		let jwtUserType: number | undefined
		let refreshedToken = false
		if (jwt) {
			try {
				const base64 = jwt
					.split('.')[1]
					.replace(/-/g, '+')
					.replace(/_/g, '/')
				const payload = JSON.parse(atob(base64)) as JwtClaims
				jwtUserType = payload.type
				isAuthenticated = payload.exp >= serverNowSeconds()
				currentSessionId.value = payload.sid ?? null

				if (isAuthenticated) {
					// Only set user from JWT if we don't already have a fully loaded
					// user with the same ID *and* type. The JWT lacks fields like
					// `name`, so overwriting a complete user object causes a visible
					// flash where the display name briefly reverts to the username.
					// Comparing on type as well is essential: regular users and link
					// shares share the same numeric ID space, so a USER and a
					// LINK_SHARE can have the same `id`. Without the type check, a
					// logged-in user opening a link share whose id collides with
					// their user id would keep the USER session and never flip
					// `authLinkShare` to true, causing the router guard to bounce
					// between /share/:hash/auth and the project view forever.
					setSession(payload)
				} else if (payload.type === AUTH_TYPES.USER && failedRefresh !== jwt) {
					// JWT expired but this is a user session — attempt a cookie-based
					// refresh before giving up. This lets users who reopen the app
					// after the short JWT TTL seamlessly resume their session.
					try {
						await refreshUserToken(retryCheckAuth)
						const freshJwt = getToken()
						if (freshJwt) {
							const b64 = freshJwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
							const p = JSON.parse(atob(b64)) as JwtClaims
							// The server just issued it, so it's valid even if our clock disagrees.
							isAuthenticated = true
							refreshedToken = true
							currentSessionId.value = p.sid ?? null
							setSession(p)
						}
					} catch (e) {
						const failure = refreshFailure(e)
						// Outages may clear by the next navigation; refreshToken() gates a timed rate limit.
						const retriesLater = failure?.kind === 'network'
							|| failure?.kind === 'server'
							|| (failure?.kind === 'rate-limited' && failure.retryAt !== undefined)
						if (!retriesLater) {
							failedRefresh = jwt
						}
						// A kept stale JWT makes every later page load refresh again.
						// Skip the removal if another tab stored a fresh token meanwhile.
						const rejected401 = failure?.kind === 'rejected' && failure.status === 401
						if (rejected401 && localStorage.getItem('token') === jwt) {
							removeToken()
						}
					}
				}
			} catch (_) {
				await logout()
				return
			}

			if (isAuthenticated && jwtUserType !== AUTH_TYPES.LINK_SHARE) {
				// A changed API, auth epoch or login session needs a fresh account even
				// when its numeric user ID matches. Do not reuse that scope's query.
				if (verifiedUserInfoScope && !isUserInfoScopeCurrent(verifiedUserInfoScope)) {
					queryClient.clear()
					resetUserInfoVerification()
				}
				const established = authenticated.value
					&& verifiedUserInfoScope !== null
					&& isUserInfoScopeCurrent(verifiedUserInfoScope)
					&& !refreshedToken
				if (established && !forceUserInfo) {
					const lastRefresh = lastUserInfoRefresh.value?.getTime() ?? 0
					if (Date.now() >= Math.max(lastRefresh + USER_INFO_REFRESH_MS, nextUserInfoRetryAt)) {
						// Only account metadata is refreshed in the background. The JWT and
						// owner scope above are still checked on every navigation; API
						// authorization continues to be enforced by the server.
						void refreshUserInfo().catch(() => {})
					}
					return authenticated.value
				}
				const user = await refreshUserInfo()
				if (!user) {
					// refreshUserInfo() bailed (logout, cancelled query or vanished token) — don't override the auth state it left behind.
					return
				}
			}
		}

		setAuthenticated(isAuthenticated)
		if (!isAuthenticated) {
			setSession(null)
			redirectToSpecifiedProvider()
		}
		
		return Promise.resolve(authenticated)
	}

	function refreshUserInfo(): Promise<UserInfoResponse | undefined> {
		const jwt = getToken()
		if (!jwt) {
			return Promise.resolve(undefined)
		}
		if (userInfoRefresh && isUserInfoScopeCurrent(userInfoRefresh.scope)) {
			return userInfoRefresh.promise
		}
		const scope = userInfoScope()
		const promise = fetchUserInfo(scope)
		userInfoRefresh = {
			scope,
			promise,
		}
		promise.finally(() => {
			if (userInfoRefresh?.promise === promise) userInfoRefresh = null
		}).catch(() => {})
		return promise
	}

	async function fetchUserInfo(scope: UserInfoScope): Promise<UserInfoResponse | undefined> {
		try {
			const newUser = await refreshCurrentUser(scope.id, scope.type)
			if (!isUserInfoScopeCurrent(scope)) return

			if (newUser.settings?.language) {
				await setLanguage(newUser.settings.language as SupportedLocale)
			}
			if (!isUserInfoScopeCurrent(scope)) return

			verifiedUserInfoScope = scope
			userInfoFailures = 0
			nextUserInfoRetryAt = 0
			updateLastUserRefresh()

			return newUser
		} catch (e) {
			if (e instanceof CancelledError || isRequestContextAbort(e) || !isUserInfoScopeCurrent(scope)) return

			const problem = e as VikunjaErrorModel
			if (
				problem?.status === 401 ||
				problem?.status === 403 ||
				(problem?.code !== undefined && ACCOUNT_GONE_ERROR_CODES.includes(problem.code))
			) {
				// Stop exposing authenticated UI and private cached data immediately;
				// the best-effort server logout may be slow on the same weak network.
				setAuthenticated(false)
				queryClient.clear()
				await logoutCurrentScope(scope)
				return
			}
			userInfoFailures = Math.min(userInfoFailures + 1, 5)
			nextUserInfoRetryAt = Date.now() + Math.min(
				USER_INFO_REFRESH_MS * 2 ** (userInfoFailures - 1),
				MAX_USER_INFO_RETRY_MS,
			)
			
			console.error('Error refreshing user info:', e)

			throw new Error('Error while refreshing user info:', {cause: e})
		}
	}

	/**
	 * Try to verify the email
	 */
	async function verifyEmail(token = localStorage.getItem('emailConfirmToken')): Promise<boolean> {
		if (token) {
			const stopLoading = setModuleLoading(setIsLoading)
			try {
				await authConfirmEmail({body: {token}})
				return true
			} catch(e) {
				const problem = e as {detail?: string, message?: string}
				throw new Error(problem?.detail ?? problem?.message ?? 'Error confirming email', {cause: e})
			} finally {
				localStorage.removeItem('emailConfirmToken')
				stopLoading()
			}
		}
		return false
	}


	/**
	 * Renews the api token and saves it to local storage
	 */
	async function renewToken() {
		if (!authenticated.value) {
			return
		}

		try {
			if (isLinkShareAuth.value) {
				// Link shares renew via the dedicated link-share endpoint (JWT-based).
				const response = await tokenRenew()
				if (!response.data.token) throw new Error('Authentication response has no token')
				saveToken(response.data.token, false)
			} else {
				// User sessions renew via the refresh-token cookie.
				await refreshUserToken(renewToken)
			}
			await checkAuth()
		} catch (e) {
			// Only logout if the JWT has actually expired and we can't refresh.
			// If the JWT is still valid, the proactive refresh failure is harmless
			// — the 401 interceptor will handle it when the token really expires.
			const isExpired = !session.value?.exp || session.value.exp < serverNowSeconds()
			if (isExpired && refreshFailure(e)?.kind === 'rejected') {
				await logout()
			}
		}
	}

	// Account-scoped writing stays in its own namespace; its mounted view and
	// all old queries/subscriptions lose their identity before a cookie changes.
	function releaseLocalAccount() {
		useWebSocket().disconnect()
		cancelRefreshRetry()
		removeToken()
		setAuthenticated(false)
		setSession(null)
		queryClient.clear()
		lastUserInfoRefresh.value = null
		clearStorageKeepingScopedDrafts()
	}

	async function rememberAccount() {
		if (isTokenExpired(getToken(), 10)) await refreshUserToken(retryCheckAuth)
		const owner = captureClientRequestContext()
		return withAuthSessionLock(async () => {
			assertClientRequestContext(owner)
			const token = getToken()
			if (!token) throw new Error('Authentication required')
			const data = await rememberCurrentDeviceAccount(token)
			assertClientRequestContext(owner)
			queryClient.setQueryData(deviceAccountKeys.list(), data)
			return data
		})
	}

	async function addAccount() {
		const owner = captureClientRequestContext()
		await rememberAccount()
		assertClientRequestContext(owner)
		releaseLocalAccount()
		sessionStorage.setItem(JUST_LOGGED_OUT_KEY, 'true')
		await router.push({name: 'user.login', query: {addAccount: '1'}})
	}

	async function switchAccount(sessionId: string) {
		if (isLoading.value) return
		setIsLoading(true)
		releaseLocalAccount()
		const epoch = getAuthSessionEpoch()
		const api = window.API_URL
		await router.replace({name: 'user.login', query: {switchingAccount: '1'}})
		try {
			await withAuthSessionLock(async () => {
				if (epoch !== getAuthSessionEpoch() || api !== window.API_URL) return
				const data = await selectDeviceAccount(sessionId)
				if (epoch !== getAuthSessionEpoch() || api !== window.API_URL) return
				adoptSession(data.token, true)
			})
			if (epoch !== getAuthSessionEpoch() || api !== window.API_URL) return
			await checkAuth()
			if (authenticated.value) await router.replace({name: 'home'})
		} catch (cause) {
			if (epoch === getAuthSessionEpoch()) {
				await router.replace({name: 'user.login', query: {accountError: '1'}})
			}
			throw cause
		} finally {
			setIsLoading(false)
		}
	}

	async function removeRememberedAccount(sessionId: string) {
		const owner = captureClientRequestContext()
		const current = session.value?.sid === sessionId
		await withAuthSessionLock(async () => {
			assertClientRequestContext(owner)
			await forgetDeviceAccount(sessionId)
		})
		assertClientRequestContext(owner)
		if (current) {
			releaseLocalAccount()
			await router.replace({name: 'user.login'})
		} else {
			await queryClient.invalidateQueries({queryKey: deviceAccountKeys.all})
		}
	}

	async function logoutAllAccounts() {
		// Include an active account even when it wasn't previously remembered.
		if (authUser.value && isTokenExpired(getToken(), 10)) {
			try { await refreshUserToken(retryCheckAuth) } catch (cause) {
				if (refreshFailure(cause)?.kind !== 'rejected') throw cause
			}
		}
		const owner = captureClientRequestContext()
		await withAuthSessionLock(async () => {
			assertClientRequestContext(owner)
			const token = getToken()
			if (authUser.value && token) {
				try { await logoutCurrentDeviceAccount(token) } catch (cause) {
					// A prior attempt may have revoked this SID before the device-clear
					// request lost its connection. Retrying must still clear the other SIDs.
					const status = (cause as {status?: number})?.status
					if (status !== 401 && status !== 403) throw cause
				}
			}
			await clearDeviceAccounts()
		})
		assertClientRequestContext(owner)
		releaseLocalAccount()
		sessionStorage.setItem(JUST_LOGGED_OUT_KEY, 'true')
		await router.replace({name: 'user.login'})
	}

	let crossTabChange = 0
	onScopeDispose(onAuthIdentityChanged(() => {
		const change = ++crossTabChange
		useWebSocket().disconnect()
		cancelRefreshRetry()
		setAuthenticated(false)
		setSession(null)
		queryClient.clear()
		lastUserInfoRefresh.value = null
		void checkAuth().then(async () => {
			if (change !== crossTabChange) return
			await router.replace({name: authenticated.value ? 'home' : 'user.login'})
		}).catch(() => {})
	}))

	function logout() {
		return logoutCurrentScope()
	}

	async function logoutCurrentScope(expectedScope?: UserInfoScope) {
		if (expectedScope && !isUserInfoScopeCurrent(expectedScope)) return
		const {disconnect} = useWebSocket()
		disconnect()
		cancelRefreshRetry()

		// Revoke the server session so the refresh token can't be reused.
		// Best-effort: if the network call fails, still clean up locally.
		let oidcLogoutUrl = ''
		try {
			const {data} = await authLogout()
			oidcLogoutUrl = navigableUrl(data?.oidc_logout_url)
		} catch (_e) {
			// Ignore — session will expire naturally
		}
		// A background rejection can finish its best-effort logout after another
		// login has already established a replacement session in this tab.
		if (expectedScope && !isUserInfoScopeCurrent(expectedScope)) return

		removeToken()
		const loggedInVia = getLoggedInVia()
		lastUserInfoRefresh.value = null
		setAuthenticated(false)
		// setSession clears the cache when an identity ends; without readable claims there was none to end, but a
		// cache may still be left behind.
		const clearedIdentity = setSession(null)
		if (!clearedIdentity) queryClient.clear()
		// Clear settings and history, but keep account-scoped drafts: an expired or revoked session must not take
		// unsaved writing with it. The header asks whether to remove them on an explicit logout.
		clearStorageKeepingScopedDrafts()

		sessionStorage.setItem(JUST_LOGGED_OUT_KEY, 'true')

		// Redirect to the OIDC provider to end its session too. Prefer the
		// server-built RP-Initiated Logout URL, falling back to the static one.
		// These full-page redirects return the user to the login page, so we
		// must not router.push there first — that would consume
		// JUST_LOGGED_OUT_KEY before the round-trip lands.
		if (oidcLogoutUrl) {
			window.location.href = oidcLogoutUrl
			return
		}
		const fullProvider: IProvider|undefined = configStore.auth.openid_connect.providers?.find((p: IProvider) => p.key === loggedInVia)
		if (fullProvider && redirectToProviderOnLogout(fullProvider)) {
			return
		}

		await router.push({name: 'user.login'})
		await checkAuth()
	}

	return {
		// state
		authenticated: readonly(authenticated),
		needsTotpPasscode: readonly(needsTotpPasscode),

		session: readonly(session),
		currentAccount,
		info: readonly(info),
		settings: readonly(settings),

		currentSessionId: readonly(currentSessionId),
		lastUserInfoRefresh: readonly(lastUserInfoRefresh),

		authUser,
		authLinkShare,
		userDisplayName,
		isLinkShareAuth,
		identityKey,

		isLoading: readonly(isLoading),
		setIsLoading,


		setSession,
		setAuthenticated,
		setNeedsTotpPasscode,

		updateLastUserRefresh,

		login,
		register,
		registerWithInvite,
		openIdAuth,
		handleDesktopOAuthTokens,
		linkShareAuth,
		checkAuth,
		refreshUserInfo,
		verifyEmail,
		renewToken,
		logout,
		rememberAccount,
		addAccount,
		switchAccount,
		removeRememberedAccount,
		logoutAllAccounts,
	}
})

// support hot reloading
if (import.meta.hot) {
	import.meta.hot.accept(acceptHMRUpdate(useAuthStore, import.meta.hot))
}
