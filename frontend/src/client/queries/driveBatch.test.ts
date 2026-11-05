import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'
import {captureClientRequestContext} from '@/client/requestContext'
import {removeToken, saveToken} from '@/helpers/auth'
import {client as sdkClient} from '@/client/generated/client.gen'
import {
	driveBatchChangeMutationOptions,
	driveBatchPreviewMutationOptions,
	type DriveBatchRow,
} from './driveBatch'
import type {DriveEntry} from './drive'

const sdk = vi.hoisted(() => ({driveChange: vi.fn(), driveUsages: vi.fn()}))
const transport = vi.hoisted(() => ({send: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/client/generated/client.gen', async original => {
	const actual = await original<typeof import('@/client/generated/client.gen')>()
	actual.client.setConfig({fetch: transport.send})
	return actual
})
vi.mock('@/message', () => ({
	error: vi.fn(), success: vi.fn(), translatedError: (key: string) => new Error(key),
}))

function file(id: number): DriveEntry {
	return {
		file_id: id, revision: id + 10, pinned: false, category: 'Original category',
		file: {id, name: `source-${id}.txt`, size: 10, mime: 'text/plain'},
	}
}
function row(id: number): DriveBatchRow {
	return {file: file(id), allowed: true, reason: '', usages: []}
}
function login(id = 1, marker = 'initial') {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1, marker}))}.fixture`, false)
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(yes => { resolve = yes })
	return {promise, resolve}
}

describe('Drive batch safety and exact snapshots', () => {
	let client: QueryClient
	beforeEach(() => {
		vi.resetAllMocks()
		removeToken()
		login()
		window.API_URL = ''
		client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})
	})
	afterEach(() => {
		client.clear()
		sdkClient.interceptors.request.clear()
		removeToken()
		window.API_URL = ''
		vi.restoreAllMocks()
	})

	it('keeps the selected name/category/revision, records partial and unknown outcomes and invalidates once per batch', async () => {
		sdk.driveChange
			.mockResolvedValueOnce({data: {file_id: 1}})
			.mockRejectedValueOnce({status: 409, detail: 'drive_changed'})
			.mockRejectedValueOnce(new TypeError('Network lost'))
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const progress = vi.fn()
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		const result = await mutation.execute({
			rows: [row(1), row(2), row(3)], action: 'pin', category: '',
			owner: captureClientRequestContext(), isActive: () => true, onProgress: progress,
		})
		expect(result).toEqual([
			{id: 1, status: 'completed', reason: ''},
			{id: 2, status: 'blocked', reason: 'changed'},
			{id: 3, status: 'unknown', reason: 'unknown'},
		])
		expect(progress.mock.calls.map(([value]) => value.length)).toEqual([1, 2, 3])
		expect(sdk.driveChange).toHaveBeenCalledTimes(3)
		for (let index = 0; index < 3; index++) {
			expect(sdk.driveChange.mock.calls[index][0]).toEqual({
				path: {file: index + 1},
				body: {
					action: 'edit', revision: index + 11, name: `source-${index + 1}.txt`,
					category: 'Original category', pinned: true, confirm: false, confirm_name: '',
				},
				fetch: expect.any(Function),
			})
		}
		expect(invalidate).toHaveBeenCalledTimes(2)
		expect(invalidate).toHaveBeenCalledWith({queryKey: ['personal-storage']})
	})

	it('protects used, unverified and purging files without sending a destructive request during review', async () => {
		sdk.driveUsages
			.mockResolvedValueOnce({data: [{kind: 'attachment', title: 'Shared task'}]})
			.mockRejectedValueOnce({status: 500})
			.mockResolvedValueOnce({data: []})
		const mutation = client.getMutationCache().build(client, driveBatchPreviewMutationOptions())
		const result = await mutation.execute({
			files: [file(1), file(2), file(3), {...file(4), purging: true}], action: 'trash',
			owner: captureClientRequestContext(), isActive: () => true,
		})
		expect(result.map(value => [value.file.file_id, value.allowed, value.reason])).toEqual([
			[1, false, 'in_use'], [2, false, 'references_unavailable'], [3, true, ''], [4, false, 'purging'],
		])
		expect(result[0].usages).toEqual([{kind: 'attachment', title: 'Shared task'}])
		expect(sdk.driveUsages).toHaveBeenCalledTimes(3)
		expect(sdk.driveChange).not.toHaveBeenCalled()
	})

	it('never authorizes a reference added after the batch review and does not send protected rows', async () => {
		sdk.driveChange.mockRejectedValueOnce({status: 409, detail: 'drive_confirm'})
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		const result = await mutation.execute({
			rows: [row(1), {...row(2), allowed: false, reason: 'in_use'}], action: 'trash', category: '',
			owner: captureClientRequestContext(), isActive: () => true,
		})
		expect(result).toEqual([{id: 1, status: 'blocked', reason: 'in_use'}])
		expect(sdk.driveChange).toHaveBeenCalledTimes(1)
		expect(sdk.driveChange.mock.calls[0][0].body).toMatchObject({action: 'trash', revision: 11, confirm: false})
	})

	it('changes only the category and retains pinned state when clearing a category', async () => {
		sdk.driveChange.mockResolvedValue({data: {file_id: 1}})
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		await mutation.execute({
			rows: [{...row(1), file: {...file(1), pinned: true}}], action: 'category', category: '  ',
			owner: captureClientRequestContext(), isActive: () => true,
		})
		expect(sdk.driveChange.mock.calls[0][0].body)
			.toMatchObject({action: 'edit', revision: 11, name: 'source-1.txt', category: '', pinned: true})
	})

	it('treats a transport AbortError with unchanged owner and selection as unknown rather than leaving a running batch', async () => {
		sdk.driveChange.mockRejectedValueOnce(new DOMException('Transport aborted', 'AbortError'))
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		await expect(mutation.execute({
			rows: [row(1)], action: 'pin', category: '',
			owner: captureClientRequestContext(), isActive: () => true,
		})).resolves.toEqual([{id: 1, status: 'unknown', reason: 'unknown'}])
		expect(sdk.driveChange).toHaveBeenCalledTimes(1)
		expect(invalidate).toHaveBeenCalledTimes(2)
	})

	it.each(['identity', 'session', 'api', 'route'] as const)('fences actual dispatch after SDK preparation when %s changes', async mode => {
		const entered = deferred<void>()
		const prepared = deferred<void>()
		let active = true
		const actual = await vi.importActual<typeof import('@/client/generated')>('@/client/generated')
		sdkClient.setConfig({baseUrl: 'https://task.example/api/v2'})
		sdk.driveChange.mockImplementationOnce(actual.driveChange)
		const interceptor = sdkClient.interceptors.request.use(async request => {
			entered.resolve()
			await prepared.promise
			return request
		})
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		const request = mutation.execute({
			rows: [row(1), row(2)], action: 'pin', category: '',
			owner: captureClientRequestContext(), isActive: () => active,
		})
		const outcome = request.catch(cause => cause)
		await entered.promise
		if (mode === 'identity') login(2)
		if (mode === 'session') { removeToken(); login() }
		if (mode === 'api') window.API_URL = 'https://other.example'
		if (mode === 'route') active = false
		prepared.resolve()
		try {
			const result = await outcome
			if (mode === 'route') expect(result).toEqual([])
			else expect(result).toMatchObject({name: 'AbortError'})
			expect(transport.send).not.toHaveBeenCalled()
			expect(sdk.driveChange).toHaveBeenCalledTimes(1)
		} finally {
			sdkClient.interceptors.request.eject(interceptor)
		}
	})

	it('stops dispatching remaining files when the page unmounts and still invalidates already changed files', async () => {
		let active = true
		sdk.driveChange.mockImplementationOnce(async () => {
			active = false
			return {data: {file_id: 1}}
		})
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const mutation = client.getMutationCache().build(client, driveBatchChangeMutationOptions())
		await mutation.execute({
			rows: [row(1), row(2)], action: 'pin', category: '',
			owner: captureClientRequestContext(), isActive: () => active,
		})
		expect(sdk.driveChange).toHaveBeenCalledTimes(1)
		expect(invalidate).toHaveBeenCalledTimes(2)
	})

	it('rejects duplicate or over-limit selections before sending requests', async () => {
		for (const files of [[file(1), file(1)], Array.from({length: 61}, (_, index) => file(index + 1))]) {
			const mutation = client.getMutationCache().build(client, driveBatchPreviewMutationOptions())
			await expect(mutation.execute({
				files, action: 'trash', owner: captureClientRequestContext(), isActive: () => true,
			})).rejects.toThrow('Invalid Drive selection')
		}
		expect(sdk.driveUsages).not.toHaveBeenCalled()
		expect(sdk.driveChange).not.toHaveBeenCalled()
	})
})
