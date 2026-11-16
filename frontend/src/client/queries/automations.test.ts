import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {hashKey, QueryClient} from '@tanstack/vue-query'

const scope = vi.hoisted(() => ({
	id: 1,
	type: 1,
	epoch: 1,
	token: 'first-token',
	api: 'https://one.example/api/v2',
}))
const sdk = vi.hoisted(() => ({
	automationList: vi.fn(),
	automationRead: vi.fn(),
	automationRuns: vi.fn(),
	automationCreate: vi.fn(),
	automationUpdate: vi.fn(),
	automationDelete: vi.fn(),
	automationRun: vi.fn(),
}))
const transport = vi.hoisted(() => vi.fn(async () => new Response('{}')))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/client/generated/client.gen', () => ({client: {getConfig: () => ({fetch: transport})}}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => scope.token,
	getTokenIdentity: () => ({
		id: scope.id,
		type: scope.type,
	}),
	getAuthSessionEpoch: () => scope.epoch,
}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => scope.api}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))

import {
	automationsQuery,
	automationQuery,
	automationRunsQuery,
	saveAutomationMutationOptions,
	type Automation,
	type AutomationDraft,
} from './automations'
import {profileOptions} from '@/helpers/assistantProfiles'

let client: QueryClient

const cases = [
	{
		name: 'list',
		sdk: sdk.automationList,
		prepare: () => {
			const options = automationsQuery(1)
			return {
				key: options.queryKey,
				read: () => client.fetchQuery(options),
			}
		},
		wire: (marker: string) => ({data: {
			items: [{id: marker}],
			total: 1,
			total_pages: 1,
		}}),
	},
	{
		name: 'detail',
		sdk: sdk.automationRead,
		prepare: () => {
			const options = automationQuery('same-id')
			return {
				key: options.queryKey,
				read: () => client.fetchQuery(options),
			}
		},
		wire: (marker: string) => ({data: {id: marker}}),
	},
	{
		name: 'history',
		sdk: sdk.automationRuns,
		prepare: () => {
			const options = automationRunsQuery('same-id', 1)
			return {
				key: options.queryKey,
				read: () => client.fetchQuery(options),
			}
		},
		wire: (marker: string) => ({data: {
			items: [{id: marker}],
			total: 1,
			total_pages: 1,
		}}),
	},
] as const

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {
		promise,
		resolve,
	}
}

beforeEach(() => {
	Object.assign(scope, {
		id: 1,
		type: 1,
		epoch: 1,
		token: 'first-token',
		api: 'https://one.example/api/v2',
	})
	client = new QueryClient({defaultOptions: {
		queries: {
			retry: false,
			staleTime: Infinity,
		},
	}})
	for (const spec of cases) spec.sdk.mockReset().mockResolvedValue(spec.wire('first-account'))
	transport.mockClear()
})
afterEach(() => client.clear())

describe.each(cases)('automation $name request ownership', spec => {
	it('keeps renewed JWTs in the same cache and isolates identity, server and session changes', async () => {
		const first = spec.prepare()
		await first.read()
		scope.token = 'renewed-token'
		expect(hashKey(spec.prepare().key)).toBe(hashKey(first.key))
		for (const change of [() => {scope.id++}, () => {scope.api += '/other'}, () => {scope.epoch++}]) {
			change()
			expect(client.getQueryData(spec.prepare().key)).toBeUndefined()
		}
		if (spec.name !== 'detail') expect(first.key.at(-1)).toBe(1)
	})

	it('does not dispatch query options captured by a previous session', async () => {
		const first = spec.prepare()
		scope.epoch++
		await expect(first.read()).rejects.toMatchObject({name: 'AbortError'})
		expect(spec.sdk).not.toHaveBeenCalled()
	})

	it('rejects a late response and does not deduplicate another account onto its request', async () => {
		const firstReply = deferred<ReturnType<typeof spec.wire>>()
		spec.sdk.mockReturnValueOnce(firstReply.promise).mockResolvedValueOnce(spec.wire('second-account'))
		const first = spec.prepare()
		const oldRequest = first.read()
		void oldRequest.catch(() => {})
		scope.id++
		scope.epoch++
		const second = spec.prepare()
		const newRequest = second.read()
		void newRequest.catch(() => {})
		firstReply.resolve(spec.wire('first-account'))
		const [oldResult, newResult] = await Promise.allSettled([oldRequest, newRequest])

		expect(oldResult).toMatchObject({status: 'rejected', reason: {name: 'AbortError'}})
		expect(newResult.status).toBe('fulfilled')
		expect(spec.sdk).toHaveBeenCalledTimes(2)
		if (newResult.status === 'fulfilled') expect(client.getQueryData(second.key)).toEqual(newResult.value)
		expect(client.getQueryData(first.key)).toBeUndefined()
	})

	it('fences the actual network dispatch after asynchronous SDK preparation', async () => {
		const prepared = deferred<void>()
		spec.sdk.mockImplementationOnce(async (options: {fetch?: typeof fetch}) => {
			await prepared.promise
			await (options.fetch ?? transport)(new Request('https://one.example/api/v2/ai/automations'))
			return spec.wire('first-account')
		})
		const request = spec.prepare().read()
		void request.catch(() => {})
		scope.epoch++
		prepared.resolve()
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
		expect(transport).not.toHaveBeenCalled()
	})
})

describe('automation writable request boundary', () => {
	it.each(['create', 'update'] as const)('sends only spec fields when %s receives a previously read record', async action => {
		const spec: AutomationDraft = {
			title: 'Daily reminder',
			prompt: 'Review the day',
			kind: 'reminder',
			enabled: false,
			timezone: 'Asia/Shanghai',
			schedule: {
				kind: 'daily',
				time: '09:00',
			},
			options: profileOptions('ask'),
			notify_on_success: true,
			notify_on_failure: true,
			max_runtime_seconds: 3600,
		}
		const readRecord: Automation & {$schema: string} = {
			...spec,
			$schema: 'https://one.example/api/v2/schemas/Automation.json',
			id: 'existing-automation',
			revision: 7,
			created: '2026-11-01T01:00:00Z',
			updated: '2026-11-02T01:00:00Z',
			next_run: '2026-11-17T01:00:00Z',
			last_run_at: '2026-11-16T01:00:00Z',
			last_status: 'succeeded',
		}
		const request = action === 'update' ? sdk.automationUpdate : sdk.automationCreate
		request.mockReset().mockResolvedValue({data: readRecord})
		const input = action === 'update'
			? {id: readRecord.id, expected_revision: readRecord.revision, body: readRecord}
			: {body: readRecord}
		await client.getMutationCache().build(client, saveAutomationMutationOptions()).execute(input)

		expect(request).toHaveBeenCalledTimes(1)
		const sent = request.mock.calls[0][0]
		expect(sent.body).toEqual(action === 'update' ? {...spec, expected_revision: 7} : spec)
		if (action === 'update') expect(sent.path).toEqual({id: readRecord.id})
		expect(sent.fetch).toBeTypeOf('function')
	})
})
