import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'
import {applyProjectVersionRestoreResult} from './projectVersions'
import {
	failTaskDetails,
	isTaskDeleted,
} from './taskCache'
import {
	normalizeTask,
	taskKeys,
} from './tasks'

const sdk = vi.hoisted(() => ({
	projectVersionsList: vi.fn(),
	projectVersionsCreate: vi.fn(),
	projectVersionsRead: vi.fn(),
	projectVersionsPreview: vi.fn(),
	projectVersionsRestore: vi.fn(),
	projectVersionsDelete: vi.fn(),
	projectVersionEntityRead: vi.fn(),
	projectVersionEntitiesList: vi.fn(),
	tasksRead: vi.fn(),
}))
const request = vi.hoisted(() => ({epoch: 1}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (message: string) => new Error(message),
}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => request.epoch,
	assertClientRequestContext: (owner: number) => {
		if (owner !== request.epoch) throw new DOMException('Context changed', 'AbortError')
	},
	isClientRequestContextCurrent: (owner: number) => owner === request.epoch,
	isRequestContextAbort: (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError',
}))

const clients: QueryClient[] = []
function queryClient() {
	const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	clients.push(client)
	return client
}
beforeEach(() => {
	vi.clearAllMocks()
	request.epoch = 1
})
afterEach(() => clients.splice(0).forEach(client => client.clear()))

describe('project restore cache reconciliation', () => {
	it('refreshes a loaded task list without individually fetching every cached card', async () => {
		const client = queryClient()
		const ids = Array.from({length: 80}, (_, index) => index + 1)
		const key = taskKeys.list({project: 1})
		client.setQueryData(key, {
			items: ids.map(id => normalizeTask({
				id,
				project_id: 1,
				title: `Task ${id}`,
			})),
			total: ids.length,
			page: 1,
			per_page: ids.length,
			total_pages: 1,
		})
		await applyProjectVersionRestoreResult(client, {
			project_id: 1,
			changed_task_ids: ids,
			removed_task_ids: [],
		})
		expect(sdk.tasksRead).not.toHaveBeenCalled()
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
	})

	it('does not treat a stale removal receipt as deletion when the current task is active again', async () => {
		const client = queryClient()
		const key = taskKeys.detail(7)
		client.setQueryData(key, normalizeTask({
			id: 7,
			project_id: 1,
			title: 'Cached restored task',
		}))
		sdk.tasksRead.mockResolvedValueOnce({
			data: {
				id: 7,
				project_id: 1,
				title: 'Current task restored in another tab',
			},
		})
		await applyProjectVersionRestoreResult(client, {
			project_id: 1,
			changed_task_ids: [],
			removed_task_ids: [7],
		})
		expect(client.getQueryData(key)).toMatchObject({title: 'Current task restored in another tab'})
		expect(isTaskDeleted(client, 7)).toBe(false)
	})

	it('does not clear a deleted-task guard until an authoritative live read confirms the same ID is active', async () => {
		const client = queryClient()
		failTaskDetails(client, 7)
		sdk.tasksRead.mockRejectedValueOnce(new Error('Missing task'))
		await applyProjectVersionRestoreResult(client, {
			project_id: 1,
			changed_task_ids: [7],
			removed_task_ids: [],
		})
		expect(isTaskDeleted(client, 7)).toBe(true)
		sdk.tasksRead.mockResolvedValueOnce({
			data: {
				id: 7,
				title: 'Restored',
				project_id: 1,
			},
		})
		await applyProjectVersionRestoreResult(client, {
			project_id: 1,
			changed_task_ids: [7],
			removed_task_ids: [],
		})
		expect(sdk.tasksRead).toHaveBeenLastCalledWith({path: {task: 7}})
		expect(isTaskDeleted(client, 7)).toBe(false)
	})

	it('rejects a late task read after the account context changed without patching the new owner’s cache', async () => {
		const client = queryClient()
		const key = taskKeys.detail(7)
		client.setQueryData(key, normalizeTask({
			id: 7,
			project_id: 1,
			title: 'Original owner',
		}))
		let finish!: (value: unknown) => void
		sdk.tasksRead.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
		const pending = applyProjectVersionRestoreResult(client, {
			project_id: 1,
			changed_task_ids: [7],
			removed_task_ids: [],
		})
		await vi.waitFor(() => expect(sdk.tasksRead).toHaveBeenCalledOnce())
		request.epoch++
		client.clear()
		client.setQueryData(key, normalizeTask({
			id: 7,
			project_id: 2,
			title: 'New owner’s task',
		}))
		const revision = client.getQueryState(key)?.dataUpdateCount
		finish({
			data: {
				id: 7,
				project_id: 1,
				title: 'Late old restore',
			},
		})
		await expect(pending).rejects.toMatchObject({name: 'AbortError'})
		expect(client.getQueryData(key)).toMatchObject({
			title: 'New owner’s task',
			project_id: 2,
		})
		expect(client.getQueryState(key)?.dataUpdateCount).toBe(revision)
	})
})
