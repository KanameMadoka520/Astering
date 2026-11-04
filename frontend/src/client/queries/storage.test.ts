import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'
import {captureClientRequestContext} from '@/client/requestContext'
import {
	currentStorageData,
	storageCleanupMutationOptions,
	storageFilesQuery,
	storageKeys,
	storagePreviewMutationOptions,
	storageSummaryQuery,
	type StoragePreviewItem,
} from './storage'

const sdk = vi.hoisted(() => ({
	userStorageSummary: vi.fn(),
	userStorageFiles: vi.fn(),
	userStorageConversations: vi.fn(),
	userStorageCleanupPreview: vi.fn(),
	userStorageCleanupExecute: vi.fn(),
}))
const requestContext = vi.hoisted(() => ({
	identity: {id: 1, type: 1} as {id: number, type: number} | null,
	sessionEpoch: 1,
	apiBaseUrl: '/api/v2',
}))
const transport = vi.hoisted(() => ({send: vi.fn()}))
const deleted = vi.hoisted(() => vi.fn())
vi.mock('@/client/generated', () => sdk)
vi.mock('@/client/generated/client.gen', () => ({client: {getConfig: () => ({fetch: transport.send})}}))
vi.mock('@/helpers/auth', () => ({
	getAuthSessionEpoch: () => requestContext.sessionEpoch,
	getToken: () => null,
	getTokenIdentity: () => requestContext.identity,
}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => requestContext.apiBaseUrl}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('./drive', () => ({invalidateDrive: (client: QueryClient) => client.invalidateQueries({queryKey: ['drive']})}))
vi.mock('./tcyConversations', () => ({
	conversationKeys: {lists: () => ['conversations', 'list']},
	markConversationDeleted: deleted,
}))

const clients: QueryClient[] = []
function client() {
	const value = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})
	clients.push(value)
	return value
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(yes => { resolve = yes })
	return {promise, resolve}
}
function previewItem(id: string, kind: 'file' | 'conversation' = 'file'): StoragePreviewItem {
	return {
		kind,
		id,
		revision: `revision-${id}`,
		action: kind === 'conversation' ? 'delete' : 'purge',
		name: `private-${id}`,
		allowed: true,
		reason: '',
		bytes: 100,
		expected_freed_bytes: 100,
		usages: [],
		token: `confirmation-${id}`,
	}
}

beforeEach(() => {
	vi.resetAllMocks()
	requestContext.identity = {id: 1, type: 1}
	requestContext.sessionEpoch = 1
	requestContext.apiBaseUrl = '/api/v2'
})
afterEach(() => {
	for (const value of clients) value.clear()
	clients.length = 0
})

describe('personal storage query boundaries', () => {
	it('passes the real paging/filter fields to the SDK without collecting other pages', async () => {
		const query = {page: 3, category: 'previews' as const, scope: 'all' as const, sort_by: 'preview_bytes' as const}
		sdk.userStorageFiles.mockResolvedValue({data: {items: [], total: 75, total_pages: 3, page: 3}})
		const result = await client().fetchQuery(storageFilesQuery(query))
		expect(currentStorageData(result)?.page).toBe(3)
		expect(sdk.userStorageFiles).toHaveBeenCalledExactlyOnceWith({
			query,
			signal: expect.any(AbortSignal),
			fetch: expect.any(Function),
		})
	})

	it('hides a retained mounted value immediately after identity, session or API changes', async () => {
		sdk.userStorageSummary.mockResolvedValue({data: {total_bytes: 1234}})
		const options = storageSummaryQuery()
		const result = await client().fetchQuery(options)
		expect(currentStorageData(result)?.total_bytes).toBe(1234)
		requestContext.sessionEpoch++
		expect(currentStorageData(result)).toBeUndefined()
		expect(storageSummaryQuery().queryKey).not.toEqual(options.queryKey)
		requestContext.sessionEpoch--
		requestContext.identity = {id: 2, type: 1}
		expect(currentStorageData(result)).toBeUndefined()
		requestContext.identity = {id: 1, type: 1}
		requestContext.apiBaseUrl = 'https://other.example/api/v2'
		expect(currentStorageData(result)).toBeUndefined()
	})

	it('rejects a late inventory response belonging to a previous login', async () => {
		const pending = deferred<{data: {total_bytes: number}}>()
		sdk.userStorageSummary.mockReturnValue(pending.promise)
		const request = client().fetchQuery(storageSummaryQuery())
		requestContext.sessionEpoch++
		pending.resolve({data: {total_bytes: 1234}})
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
	})

	it('rechecks the owner at dispatch after asynchronous SDK preparation', async () => {
		const prepared = deferred<void>()
		const entered = deferred<void>()
		sdk.userStorageCleanupPreview.mockImplementation(async (options: {fetch: typeof fetch}) => {
			entered.resolve()
			await prepared.promise
			return options.fetch('https://astering.example/api/v2/user/storage/cleanup/preview')
		})
		const value = client()
		const mutation = value.getMutationCache().build(value, storagePreviewMutationOptions())
		const request = mutation.execute({
			owner: captureClientRequestContext(),
			items: [{kind: 'file', id: '1', revision: 'a', action: 'purge'}],
		})
		await entered.promise
		requestContext.identity = {id: 2, type: 1}
		prepared.resolve()
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
		expect(transport.send).not.toHaveBeenCalled()
	})
})

describe('confirmed cleanup batches', () => {
	it('records only acknowledged results, preserves uncertain outcomes and invalidates related lists once', async () => {
		const value = client()
		const owner = captureClientRequestContext()
		value.setQueryData(storageKeys.summary(owner), {context: owner, data: {total_bytes: 1000}})
		value.setQueryData(['drive', 'list', {}], {files: []})
		value.setQueryData(['conversations', 'list'], {items: []})
		const completed = {
			kind: 'conversation',
			id: '1',
			action: 'delete',
			status: 'completed',
			reason: '',
			freed_bytes: 80,
			bytes_complete: true,
		}
		sdk.userStorageCleanupExecute
			.mockResolvedValueOnce({data: {items: [completed]}})
			.mockRejectedValueOnce(new TypeError('connection reset'))
			.mockResolvedValueOnce({data: {items: [{
				...completed,
				kind: 'file',
				id: '3',
				action: 'purge',
				status: 'blocked',
				reason: 'in_use',
				freed_bytes: 0,
			}]}})
		const onProgress = vi.fn()
		const mutation = value.getMutationCache().build(value, storageCleanupMutationOptions())
		const outcome = await mutation.execute({
			items: [previewItem('1', 'conversation'), previewItem('2'), previewItem('3')],
			owner,
			onProgress,
		})
		expect(outcome.results.map(item => item.status)).toEqual(['completed', 'unknown', 'blocked'])
		expect(outcome.results.map(item => item.freed_bytes)).toEqual([80, 0, 0])
		expect(onProgress.mock.calls.map(call => call[0].processed)).toEqual([1, 2, 3])
		expect(sdk.userStorageCleanupExecute).toHaveBeenCalledTimes(3)
		expect(sdk.userStorageCleanupExecute.mock.calls.map(call => call[0].body)).toEqual([
			{tokens: ['confirmation-1'], confirm: true},
			{tokens: ['confirmation-2'], confirm: true},
			{tokens: ['confirmation-3'], confirm: true},
		])
		expect(deleted).toHaveBeenCalledExactlyOnceWith(value, '1')
		expect(value.getQueryState(storageKeys.summary(owner))?.isInvalidated).toBe(true)
		expect(value.getQueryState(['drive', 'list', {}])?.isInvalidated).toBe(true)
		expect(value.getQueryState(['conversations', 'list'])?.isInvalidated).toBe(true)
	})

	it('does not send the next confirmed item or publish progress after a session changes', async () => {
		const waiting = deferred<{data: {items: unknown[]}}>()
		const entered = deferred<void>()
		sdk.userStorageCleanupExecute.mockImplementation(() => {
			entered.resolve()
			return waiting.promise
		})
		const value = client()
		const onProgress = vi.fn()
		const mutation = value.getMutationCache().build(value, storageCleanupMutationOptions())
		const request = mutation.execute({
			items: [previewItem('1'), previewItem('2')],
			owner: captureClientRequestContext(),
			onProgress,
		})
		await entered.promise
		requestContext.sessionEpoch++
		waiting.resolve({data: {items: []}})
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
		expect(sdk.userStorageCleanupExecute).toHaveBeenCalledTimes(1)
		expect(onProgress).not.toHaveBeenCalled()
		expect(deleted).not.toHaveBeenCalled()
	})
})
