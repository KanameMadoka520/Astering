import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'

import {client as sdkClient} from '@/client/generated/client.gen'
import {configureApiClient} from '@/client/http'
import {captureClientRequestContext} from '@/client/requestContext'
import {createTaskMutationOptions} from './taskMutations'

const auth = vi.hoisted(() => ({
	token: 'owner-token',
	id: 1,
	epoch: 1,
}))

vi.mock('@/helpers/auth', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/auth')>(),
	getAuthSessionEpoch: () => auth.epoch,
	getToken: () => auth.token,
	getTokenIdentity: () => ({
		id: auth.id,
		type: 1,
	}),
	refreshToken: vi.fn(),
}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (message: string) => new Error(message),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise })
	return {
		promise,
		resolve,
	}
}

describe('create task request ownership through the real SDK', () => {
	let queryClient: QueryClient
	let requests: Request[]

	beforeEach(() => {
		auth.token = 'owner-token'
		auth.id = 1
		auth.epoch = 1
		window.API_URL = 'https://calendar.example'
		queryClient = new QueryClient()
		requests = []
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request && !init ? input : new Request(input, init)
			requests.push(request)
			return new Response(JSON.stringify({
				id: 12,
				project_id: 2,
				title: 'Calendar draft',
			}), {
				status: 200,
				headers: {'Content-Type': 'application/json'},
			})
		}))
		sdkClient.setConfig({requestValidator: undefined})
		configureApiClient()
	})

	afterEach(() => {
		queryClient.clear()
		sdkClient.setConfig({requestValidator: undefined})
		sdkClient.interceptors.request.clear()
		vi.unstubAllGlobals()
		window.API_URL = ''
	})

	function pauseAt(boundary: 'before-credentials' | 'after-credentials') {
		const entered = deferred()
		const release = deferred()
		const pause = async () => {
			entered.resolve()
			await release.promise
		}
		if (boundary === 'before-credentials') {
			sdkClient.setConfig({requestValidator: pause})
		} else {
			sdkClient.interceptors.request.use(async request => {
				await pause()
				return request
			})
		}
		return {
			entered,
			release,
		}
	}

	function execute() {
		return queryClient.getMutationCache()
			.build(queryClient, createTaskMutationOptions(captureClientRequestContext()))
			.execute({
				title: 'Calendar draft',
				project_id: 2,
			})
	}

	for (const boundary of ['before-credentials', 'after-credentials'] as const) {
		it.each(['account', 'api', 'session'] as const)(`does not send after %s changes ${boundary}`, async changed => {
			const {entered, release} = pauseAt(boundary)
			const result = execute()
			const rejection = expect(result).rejects.toMatchObject({name: 'AbortError'})
			await entered.promise
			if (changed === 'account') {
				auth.id = 2
				auth.token = 'replacement-account-token'
			} else if (changed === 'api') {
				window.API_URL = 'https://replacement.example'
			} else {
				auth.epoch++
			}
			release.resolve()
			await rejection
			expect(requests).toHaveLength(0)
		})
	}

	it('preserves a same-identity token refresh and the configured SDK transport', async () => {
		const {entered, release} = pauseAt('before-credentials')
		const result = execute()
		await entered.promise
		auth.token = 'refreshed-owner-token'
		release.resolve()
		await expect(result).resolves.toMatchObject({
			id: 12,
			project_id: 2,
		})
		expect(requests).toHaveLength(1)
		expect(requests[0].url).toBe('https://calendar.example/api/v2/projects/2/tasks')
		expect(requests[0].credentials).toBe('include')
		expect(requests[0].headers.get('Authorization')).toBe('Bearer refreshed-owner-token')
		expect(await requests[0].json()).toMatchObject({
			title: 'Calendar draft',
			project_id: 2,
		})
	})
})
