import {getApiBaseUrl} from '@/helpers/apiUrl'
import {canonicalApiBaseUrl} from '@/client/requestContext'
import {authRefreshToken} from '@/client/generated'
import {publicClient} from '@/client/publicClient'
import {ApiError} from '@/client/problem'
import {isDesktopApp, refreshDesktopToken} from '@/helpers/desktopAuth'
import {clearServerClock, recordServerClock, serverNowSeconds} from '@/helpers/serverClock'
import {MILLISECONDS_A_MINUTE, MILLISECONDS_A_SECOND} from '@/constants/date'
import {isNativeAndroid, nativeAndroidSession, onNativeAndroidEvent, requestNativeAndroid} from '@/helpers/nativeAndroid'

let savedToken: string | null = null
let savedTokenPersists = true
let savedTokenInitialized = false

const identityListeners = new Set<() => void>()

/** A cookie-backed account selection is shared by all tabs on this origin. */
export function onAuthIdentityChanged(listener: () => void) {
	identityListeners.add(listener)
	return () => identityListeners.delete(listener)
}

export async function withAuthSessionLock<T>(action: () => Promise<T>): Promise<T> {
	return navigator.locks ? navigator.locks.request('vikunja-token-refresh', action) : action()
}

function adoptExternalToken(next: string | null, previous: string | null) {
	savedTokenInitialized = true
	if (next === savedToken) return
	const before = getTokenPayload(previous)
	const after = getTokenPayload(next)
	savedToken = next
	savedTokenPersists = true
	if (before?.id === after?.id && before?.type === after?.type && before?.sid === after?.sid) {
		if (next) { recordServerClock(after?.iat, false); notifyRefreshListeners() }
		return
	}
	nativeAndroidSession(null)
	authEpoch++
	inFlightRefresh = null
	clearServerClock()
	if (next) {
		recordServerClock(after?.iat, false)
		if (isNativeAndroid() && canonicalApiBaseUrl(getApiBaseUrl()) === 'https://task.tcymc.space/api/v2') nativeAndroidSession(after?.type === 1 ? next : null)
	}
	for (const listener of identityListeners) listener()
}

window.addEventListener('storage', event => {
	if (event.storageArea !== localStorage || (event.key !== 'token' && event.key !== null)) return
	// Link-share tokens deliberately belong to one tab and are never persisted.
	if (savedToken !== null && !savedTokenPersists) return
	adoptExternalToken(localStorage.getItem('token'), savedToken ?? event.oldValue)
})

/**
 * Saves a token while optionally saving it to lacal storage. This is used when viewing a link share:
 * It enables viewing multiple link shares indipendently from each in multiple tabs other without overriding any other open ones.
 */
export const saveToken = (token: string, persist: boolean) => {
	savedToken = token
	savedTokenPersists = persist
	savedTokenInitialized = true
	if (persist) {
		localStorage.setItem('token', token)
	}
	recordServerClock(getTokenPayload(token)?.iat, persist)
	if (isNativeAndroid() && canonicalApiBaseUrl(getApiBaseUrl()) === 'https://task.tcymc.space/api/v2') {
		nativeAndroidSession(getTokenType(token) === 1 ? token : null)
	}
}

/**
 * Returns a saved token. If there is one saved in memory it will use that before anything else.
 */
export const getToken = (): string | null => {
	if (savedToken !== null) {
		// Read the shared identity at the actual request boundary too: a storage
		// event may still be queued when another tab already changed its cookies.
		if (savedTokenPersists && getTokenType(savedToken) === 1) {
			const persisted = localStorage.getItem('token')
			if (persisted !== savedToken) adoptExternalToken(persisted, savedToken)
		}
		return savedToken
	}

	const persisted = localStorage.getItem('token')
	if (savedTokenInitialized) {
		// A switch intentionally clears the previous identity first. Requests may
		// observe the replacement before its storage event, including while this
		// tab is logged out; notify the auth store instead of silently hydrating it.
		adoptExternalToken(persisted, savedToken)
	} else {
		// The first application boot is already being authenticated by its caller.
		savedToken = persisted
		savedTokenPersists = true
		savedTokenInitialized = true
	}
	return savedToken
}

function getTokenPayload(token: string | null): Record<string, unknown> | null {
	if (!token) return null
	try {
		const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
		return JSON.parse(atob(base64))
	} catch {
		return null
	}
}

export function getTokenType(token: string | null): number | null {
	const payload = getTokenPayload(token)
	return typeof payload?.type === 'number' ? payload.type : null
}

export function isTokenExpired(token: string | null, marginSeconds = 0): boolean {
	const exp = getTokenPayload(token)?.exp
	return typeof exp !== 'number' || exp <= serverNowSeconds() + marginSeconds
}

export function getTokenIdentity(token: string | null): {id: number; type: number} | null {
	const payload = getTokenPayload(token)
	if (typeof payload?.id !== 'number' || typeof payload.type !== 'number') {
		return null
	}

	return {id: payload.id, type: payload.type}
}

export function getTokenSessionID(token: string | null): string | null {
	const sid = getTokenPayload(token)?.sid
	return typeof sid === 'string' && sid ? sid : null
}

/**
 * Removes all tokens everywhere.
 */
export const removeToken = () => {
	nativeAndroidSession(null)
	savedToken = null
	savedTokenPersists = true
	savedTokenInitialized = true
	localStorage.removeItem('token')
	localStorage.removeItem('desktopOAuthRefreshToken')
	clearServerClock()

	// Bump the epoch and drop the in-flight refresh so a refresh that started
	// before this logout can't re-persist a token after we cleared it.
	authEpoch++
	inFlightRefresh = null
}

// Coalesces concurrent same-tab refreshes into one POST. Web Locks (below) is
// secure-context-only, so on insecure HTTP there's no cross-tab coordination —
// without this guard, refreshes firing close together each spend the single-use
// cookie and all but one get a 401.
let inFlightRefresh: Promise<void> | null = null

const refreshListeners: (() => void)[] = []

onNativeAndroidEvent(event => {
	if (event.event !== 'token' || typeof event.token !== 'string' ||
		canonicalApiBaseUrl(getApiBaseUrl()) !== 'https://task.tcymc.space/api/v2') return
	const current = getTokenPayload(getToken())
	const next = getTokenPayload(event.token)
	if (!current || !next || !current.sid || current.sid !== next.sid || current.id !== next.id ||
		current.type !== 1 || next.type !== 1 || typeof current.exp !== 'number' ||
		typeof next.exp !== 'number' || next.exp < current.exp) return
	saveToken(event.token, true)
	if (!inFlightRefresh) notifyRefreshListeners()
})

function notifyRefreshListeners() {
	for (const listener of [...refreshListeners]) {
		try {
			listener()
		} catch (error) {
			console.error('Token refresh listener failed', error)
		}
	}
}

export function onTokenRefreshed(listener: () => void) {
	refreshListeners.push(listener)
	return () => {
		const index = refreshListeners.indexOf(listener)
		if (index !== -1) {
			refreshListeners.splice(index, 1)
		}
	}
}

// Incremented on every removeToken()/logout. A refresh captures the epoch when
// it starts and only persists its result if the epoch is unchanged, so a
// refresh that resolves after a logout can't undo it.
let authEpoch = 0

export function getAuthSessionEpoch(): number {
	return authEpoch
}

// The backend's refresh limit window is a minute; this caps a bogus Retry-After.
export const MAX_RETRY_AFTER_MS = 10 * MILLISECONDS_A_MINUTE

export type RefreshFailure =
	| {kind: 'network'}
	| {kind: 'server', status: number}
	| {kind: 'rate-limited', retryAt?: number}
	| {kind: 'rejected', status: number, code?: number}

// Desktop IPC failures and unusable 200 responses stay plain Errors: no HTTP status to classify.
export class RefreshTokenError extends Error {
	readonly failure: RefreshFailure

	constructor(failure: RefreshFailure, cause: unknown) {
		super('Error renewing token: ', {cause})
		this.failure = failure
	}
}

type TimedRateLimitError = RefreshTokenError & {readonly failure: {kind: 'rate-limited', retryAt: number}}

function isTimedRateLimit(e: RefreshTokenError): e is TimedRateLimitError {
	return e.failure.kind === 'rate-limited' && e.failure.retryAt !== undefined
}

// Not cleared on logout: the backend limits refreshes per IP, not per session.
let rateLimit: {error: TimedRateLimitError, apiBase: string} | null = null

function retryAtFromHeader(value: string | null): number | undefined {
	if (value === null || !/^\d+$/.test(value)) {
		return undefined
	}
	return Date.now() + Math.min(Number(value) * MILLISECONDS_A_SECOND, MAX_RETRY_AFTER_MS)
}

function httpRefreshFailure({status, code}: {status: number, code?: unknown}, headers: Headers): RefreshFailure {
	if (status >= 500) {
		return {kind: 'server', status}
	}
	if (status === 429) {
		return {kind: 'rate-limited', retryAt: retryAtFromHeader(headers.get('Retry-After'))}
	}
	return {
		kind: 'rejected',
		status,
		code: typeof code === 'number' ? code : undefined,
	}
}

/**
 * Refreshes an auth token while ensuring it is updated everywhere.
 * The refresh token is sent automatically as an HttpOnly cookie.
 * The server rotates the cookie on every call.
 *
 * Same-tab concurrent calls share one in-flight refresh (always-on dedup); the
 * Web Locks API inside adds cross-tab coordination only in secure contexts.
 */
export async function refreshToken(persist: boolean): Promise<void> {
	if (inFlightRefresh) {
		return inFlightRefresh
	}
	if (rateLimit?.apiBase === getApiBaseUrl() && Date.now() < rateLimit.error.failure.retryAt) {
		throw rateLimit.error
	}
	const p = doRefresh(persist)
	inFlightRefresh = p
	// Only clear if it still points to this promise — a logout (or a newer
	// refresh started after it) may have replaced inFlightRefresh meanwhile.
	// .catch: callers get the rejection through p; avoid a second unhandled one.
	p.finally(() => {
		if (inFlightRefresh === p) {
			inFlightRefresh = null
		}
	}).catch(() => {})
	p.then(notifyRefreshListeners, () => {})
	return p
}

async function doRefresh(persist: boolean): Promise<void> {
	// Snapshot the epoch so we can tell if a logout happened while we awaited.
	const epochAtStart = authEpoch
	const serverAtStart = getApiBaseUrl()
	const loggedOutSinceStart = () => authEpoch !== epochAtStart || getApiBaseUrl() !== serverAtStart

	// Capture the tokens before waiting for the lock so we can detect
	// if another tab refreshed while we were queued.
	const tokenBeforeLock = localStorage.getItem('token')
	const desktopRefreshTokenBeforeLock = localStorage.getItem('desktopOAuthRefreshToken')

	const refreshUnderLock = async () => {
		// A logout may have happened while we waited for the lock — don't
		// re-adopt or re-fetch a token after the user signed out.
		if (loggedOutSinceStart()) {
			return
		}

		// The native recorder and WebView share one rotating refresh cookie and one coordinator.
		if (isNativeAndroid() && canonicalApiBaseUrl(serverAtStart) === 'https://task.tcymc.space/api/v2') {
			const before = getTokenPayload(getToken())
			try {
				const result = await requestNativeAndroid<{token: string}>('refresh', {token: getToken()})
				if (loggedOutSinceStart()) return
				const next = getTokenPayload(result?.token)
				if (!before || !next || before.id !== next.id || before.sid !== next.sid || next.type !== 1) {
					throw new Error('native_authentication')
				}
				const current = getTokenPayload(getToken())
				if (!current || current.sid !== before.sid || current.id !== before.id) return
				if (typeof next.exp !== 'number') throw new Error('native_authentication')
				if (typeof current.exp !== 'number' || next.exp >= current.exp) saveToken(result.token, persist)
			} catch (cause) {
				if (loggedOutSinceStart()) return
				const code = cause instanceof Error ? cause.message : ''
				if (code.includes('authentication') || code === 'unauthorized') {
					throw new RefreshTokenError({kind: 'rejected', status: 401}, cause)
				}
				if (code === 'rate_limited') throw new RefreshTokenError({kind: 'rate-limited'}, cause)
				if (code === 'server') throw new RefreshTokenError({kind: 'server', status: 503}, cause)
				throw new RefreshTokenError({kind: 'network'}, cause)
			}
			return
		}

		// In desktop mode, refresh via IPC to the Electron main process
		if (isDesktopApp()) {
			const storedRefreshToken = localStorage.getItem('desktopOAuthRefreshToken')

			if (storedRefreshToken !== desktopRefreshTokenBeforeLock) {
				const currentToken = localStorage.getItem('token')
				if (currentToken) {
					savedToken = currentToken
					return
				}
			}

			if (!storedRefreshToken) {
				throw new Error('No desktop OAuth refresh token available')
			}

			try {
				const tokens = await refreshDesktopToken(window.API_URL, storedRefreshToken)
				if (loggedOutSinceStart()) {
					return
				}
				saveToken(tokens.access_token, persist)
				localStorage.setItem('desktopOAuthRefreshToken', tokens.refresh_token)
			} catch (e) {
				throw new Error('Error renewing token: ', {cause: e})
			}
			return
		}

		// If the token in localStorage changed while waiting for the lock,
		// another tab already refreshed. Just adopt the new token.
		const currentToken = localStorage.getItem('token')
		if (currentToken && currentToken !== tokenBeforeLock) {
			savedToken = currentToken
			return
		}

		// We hold the lock and no one else refreshed — make the API call.
		try {
			const baseUrl = canonicalApiBaseUrl(getApiBaseUrl())
			const {data, error, response} = await authRefreshToken({client: publicClient, baseUrl, throwOnError: false})
			if (error) {
				const body: unknown = error
				// fetch and body reads reject with a TypeError when the connection drops.
				if (body instanceof TypeError) {
					throw new RefreshTokenError({kind: 'network'}, body)
				}
				// hey-api sets `response` before reading the body, so body read/parse errors arrive with a 200 status.
				if (!response || (body instanceof Error && !(body instanceof ApiError))) {
					throw body
				}
				// Proxy error pages aren't JSON, so the status comes from the response.
				const problem = typeof body === 'object'
					? {...body, status: response.status}
					: {status: response.status, detail: String(body)}
				const failure = httpRefreshFailure(problem, response.headers)
				const refreshError = new RefreshTokenError(failure, problem)
				if (isTimedRateLimit(refreshError)) {
					rateLimit = {error: refreshError, apiBase: serverAtStart}
				}
				throw refreshError
			}
			if (loggedOutSinceStart()) {
				return
			}
			if (!data?.token) throw new Error('Refresh response has no token')
			saveToken(data.token, persist)
		} catch (e) {
			// Another tab's refresh can land while our POST is in flight.
			const storedToken = localStorage.getItem('token')
			if (!loggedOutSinceStart() && storedToken && storedToken !== tokenBeforeLock) {
				savedToken = storedToken
				return
			}
			throw e instanceof RefreshTokenError ? e : new Error('Error renewing token: ', {cause: e})
		}
	}

	await withAuthSessionLock(refreshUnderLock)
}
