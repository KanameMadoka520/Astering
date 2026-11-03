import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPinia, setActivePinia} from 'pinia'
import {flushPromises} from '@vue/test-utils'

import {useAuthStore} from './auth'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {removeToken, saveToken} from '@/helpers/auth'

const sdk = vi.hoisted(() => ({
	userShow: vi.fn(),
	authLogout: vi.fn(),
	authRefreshToken: vi.fn(),
	routerPush: vi.fn(),
}))

vi.mock('@/client/generated', async (importOriginal) => ({
	...await importOriginal<typeof import('@/client/generated')>(),
	userShow: sdk.userShow,
	authLogout: sdk.authLogout,
	authRefreshToken: sdk.authRefreshToken,
}))

vi.mock('@/client/queryClient', async () => {
	const {QueryClient} = await import('@tanstack/vue-query')
	return {
		queryClient: new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: 60_000,
				},
			},
		}),
	}
})

vi.mock('@/router', () => ({
	default: {
		push: sdk.routerPush,
		currentRoute: {value: {name: 'home'}},
	},
}))

vi.mock('@/composables/useWebSocket', () => ({
	useWebSocket: () => ({
		disconnect: vi.fn(),
		closeStaleConnection: vi.fn(),
	}),
}))

vi.mock('@/helpers/redirectToProvider', () => ({
	getRedirectUrlFromCurrentFrontendPath: vi.fn(),
	redirectToProvider: vi.fn(),
	redirectToProviderOnLogout: vi.fn(),
}))

type UserResponse = {
	data: {
		id: number
		username: string
		is_admin?: boolean
	}
}

function user(id = 1): UserResponse {
	return {
		data: {
			id,
			username: `user-${id}`,
		},
	}
}

function token(id = 1, sid = 'session-1', ttl = 3600) {
	return `header.${btoa(JSON.stringify({
		id,
		type: AUTH_TYPES.USER,
		exp: Math.floor(Date.now() / 1000) + ttl,
		sid,
	}))}.signature`
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return {
		promise,
		resolve,
		reject,
	}
}

let store: ReturnType<typeof useAuthStore>

async function establish(ttl = 3600) {
	saveToken(token(1, 'session-1', ttl), true)
	sdk.userShow.mockResolvedValue(user())
	await store.checkAuth()
	await flushPromises()
	expect(store.authenticated).toBe(true)
	sdk.userShow.mockClear()
}

describe('auth navigation and periodic account refresh', () => {
	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']})
		vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
		window.API_URL = ''
		removeToken()
		localStorage.clear()
		queryClient.clear()
		setActivePinia(createPinia())
		for (const operation of Object.values(sdk)) operation.mockReset()
		sdk.authLogout.mockResolvedValue({data: {}})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		store = useAuthStore()
	})

	afterEach(async () => {
		store.$dispose()
		queryClient.clear()
		removeToken()
		window.API_URL = ''
		await flushPromises()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('waits for the first /user response before authenticating', async () => {
		const response = deferred<UserResponse>()
		saveToken(token(), true)
		sdk.userShow.mockReturnValue(response.promise)
		let completed = false
		const checking = store.checkAuth().then(() => {completed = true})
		await flushPromises()
		expect(completed).toBe(false)
		expect(store.authenticated).toBe(false)
		response.resolve(user())
		await checking
		expect(store.authenticated).toBe(true)
	})

	it('does not hold established navigation for a periodic /user GET and shares the in-flight query', async () => {
		await establish()
		vi.setSystemTime(Date.now() + 61_000)
		const response = deferred<UserResponse>()
		sdk.userShow.mockReturnValue(response.promise)
		let completed = false
		const checking = store.checkAuth().then(() => {completed = true})
		await flushPromises()
		const completedBeforeResponse = completed
		const another = store.checkAuth()
		await flushPromises()
		expect(sdk.userShow).toHaveBeenCalledTimes(1)
		response.resolve(user())
		await Promise.all([checking, another])
		expect(completedBeforeResponse).toBe(true)
	})

	it('catches background network failures and backs off repeated navigation attempts', async () => {
		await establish()
		vi.setSystemTime(Date.now() + 61_000)
		sdk.userShow.mockRejectedValue(new TypeError('Failed to fetch'))
		let rejected = false
		await store.checkAuth().catch(() => {rejected = true})
		await flushPromises()
		for (let index = 0; index < 4; index++) await store.checkAuth().catch(() => {})
		expect(sdk.userShow).toHaveBeenCalledTimes(1)
		expect(rejected).toBe(false)
		expect(store.authenticated).toBe(true)

		vi.setSystemTime(Date.now() + 60_000)
		await store.checkAuth().catch(() => {})
		await flushPromises()
		expect(sdk.userShow).toHaveBeenCalledTimes(2)
		vi.setSystemTime(Date.now() + 61_000)
		await store.checkAuth().catch(() => {})
		expect(sdk.userShow).toHaveBeenCalledTimes(2)
		vi.setSystemTime(Date.now() + 59_000)
		sdk.userShow.mockResolvedValue(user())
		await store.checkAuth()
		await flushPromises()
		expect(sdk.userShow).toHaveBeenCalledTimes(3)
	})

	it('revokes the established account when a background /user GET returns 403', async () => {
		await establish()
		vi.setSystemTime(Date.now() + 61_000)
		sdk.userShow.mockRejectedValue({status: 403})
		await store.checkAuth()
		await flushPromises()
		expect(store.authenticated).toBe(false)
		expect(sdk.routerPush).toHaveBeenCalledWith({name: 'user.login'})
	})

	it.each(['identity', 'api', 'epoch', 'session'] as const)('awaits /user when the %s changes inside the refresh interval', async (change) => {
		await establish()
		const expectedId = change === 'identity' ? 2 : 1
		if (change === 'identity') saveToken(token(2, 'session-2'), true)
		if (change === 'api') window.API_URL = 'https://another.example'
		if (change === 'epoch') {
			removeToken()
			saveToken(token(), true)
		}
		if (change === 'session') saveToken(token(1, 'session-2'), true)
		const response = deferred<UserResponse>()
		sdk.userShow.mockReturnValue(response.promise)
		let completed = false
		const checking = store.checkAuth().then(() => {completed = true})
		await flushPromises()
		const completedBeforeResponse = completed
		const requests = sdk.userShow.mock.calls.length
		response.resolve(user(expectedId))
		await checking
		expect(requests).toBe(1)
		expect(completedBeforeResponse).toBe(false)
		expect(store.info?.id).toBe(expectedId)
	})

	it('does not debounce an expired JWT merely because /user was recently verified', async () => {
		await establish(30)
		vi.setSystemTime(Date.now() + 31_000)
		sdk.authRefreshToken.mockResolvedValue({data: {token: token()}})
		const response = deferred<UserResponse>()
		sdk.userShow.mockReturnValue(response.promise)
		let completed = false
		const checking = store.checkAuth().then(() => {completed = true})
		await flushPromises()
		const completedBeforeResponse = completed
		response.resolve(user())
		await checking
		expect(sdk.authRefreshToken).toHaveBeenCalledTimes(1)
		expect(completedBeforeResponse).toBe(false)
	})

	it('awaits a forced administrator check even when account information is fresh', async () => {
		await establish()
		const response = deferred<UserResponse>()
		sdk.userShow.mockReturnValue(response.promise)
		let completed = false
		const checking = store.checkAuth({forceUserInfo: true}).then(() => {completed = true})
		await flushPromises()
		const completedBeforeResponse = completed
		const requests = sdk.userShow.mock.calls.length
		response.resolve({
			data: {
				...user().data,
				is_admin: false,
			},
		})
		await checking
		expect(requests).toBe(1)
		expect(completedBeforeResponse).toBe(false)
		expect(store.info?.is_admin).toBe(false)
	})

	it('joins an in-flight background GET for a forced administrator check', async () => {
		await establish()
		vi.setSystemTime(Date.now() + 61_000)
		const response = deferred<UserResponse>()
		sdk.userShow.mockReturnValue(response.promise)
		const navigation = store.checkAuth()
		await flushPromises()
		let completed = false
		const privileged = store.checkAuth({forceUserInfo: true}).then(() => {completed = true})
		await flushPromises()
		const completedBeforeResponse = completed
		response.resolve({
			data: {
				...user().data,
				is_admin: false,
			},
		})
		await Promise.all([navigation, privileged])
		expect(sdk.userShow).toHaveBeenCalledTimes(1)
		expect(completedBeforeResponse).toBe(false)
		expect(store.info?.is_admin).toBe(false)
	})

	it('revokes locally before a slow logout and does not clear a replacement login when it finishes', async () => {
		await establish()
		queryClient.setQueryData(['private-account-data'], 'fixture')
		vi.setSystemTime(Date.now() + 61_000)
		const logout = deferred<{data: object}>()
		sdk.authLogout.mockReturnValue(logout.promise)
		sdk.userShow.mockRejectedValueOnce({status: 403})
		const checking = store.checkAuth()
		await flushPromises()
		const revokedBeforeLogout = !store.authenticated
		const privateDataBeforeLogout = queryClient.getQueryData(['private-account-data'])
		saveToken(token(2, 'session-2'), true)
		sdk.userShow.mockResolvedValue(user(2))
		await store.checkAuth()
		logout.resolve({data: {}})
		await checking
		await flushPromises()
		expect(revokedBeforeLogout).toBe(true)
		expect(privateDataBeforeLogout).toBeUndefined()
		expect(store.authenticated).toBe(true)
		expect(store.info?.id).toBe(2)
		expect(sdk.routerPush).not.toHaveBeenCalled()
	})

	it('does not let a cancelled old account 403 log out the replacement account', async () => {
		await establish()
		vi.setSystemTime(Date.now() + 61_000)
		const oldResponse = deferred<UserResponse>()
		sdk.userShow.mockReturnValueOnce(oldResponse.promise)
		const oldCheck = store.checkAuth()
		await flushPromises()
		saveToken(token(2, 'session-2'), true)
		sdk.userShow.mockResolvedValue(user(2))
		await store.checkAuth()
		oldResponse.reject({status: 403})
		await oldCheck
		await flushPromises()
		expect(store.authenticated).toBe(true)
		expect(store.info?.id).toBe(2)
		expect(sdk.authLogout).not.toHaveBeenCalled()
	})
})
