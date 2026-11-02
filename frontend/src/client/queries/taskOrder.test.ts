import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver, type QueryKey} from '@tanstack/vue-query'
import type {Task} from '@/client/generated'
import {removeToken, saveToken} from '@/helpers/auth'
import {agentReceipt, agentRefreshMutationOptions, planAgentRefresh} from './tcyConversations'
import {kanbanKeys, kanbanQuery, normalizeBucket, type BoardData} from './kanban'
import {normalizeTask, taskKeys, tasksQuery, type PaginatedTaskResponse} from './tasks'

const sdk = vi.hoisted(() => ({
	projectViewBucketsTasksList: vi.fn(),
	projectViewTasksList: vi.fn(),
}))
vi.mock('@/client/generated', async importOriginal => ({
	...await importOriginal<typeof import('@/client/generated')>(),
	...sdk,
}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))

const clients: QueryClient[] = []
const stops: (() => void)[] = []
const version = 'a'.repeat(64)
const card = (id: number, position: number) => normalizeTask({
	id,
	project_id: 1,
	title: `Task ${id}`,
	position,
	positions: [{task_id: id, project_view_id: 4, position}],
})

function client() {
	const value = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	clients.push(value)
	return value
}

function observe(value: QueryClient, queryKey: QueryKey, queryFn: () => Promise<unknown> = vi.fn(async () => undefined)) {
	stops.push(new QueryObserver(value, {queryKey, queryFn, staleTime: Infinity}).subscribe(() => {}))
	return queryFn
}

function result(extra: Record<string, unknown> = {}) {
	return {
		project_id: 1,
		view_id: 4,
		view_kind: 'kanban',
		bucket_id: 8,
		task_ids: [3],
		changed_positions: [{task_id: 3, project_view_id: 4, position: 50}],
		order_version: version,
		position_recalculated: false,
		manual_order_saved: true,
		verified: true,
		...extra,
	}
}

async function apply(value: QueryClient, output = result()) {
	const receipt = agentReceipt('turn:1', {
		tool: 'reorder_view_tasks',
		arguments: JSON.stringify({
			project_id: 1,
			view_id: 4,
			bucket_id: output.bucket_id,
			task_ids: output.task_ids,
			after_task_id: 0,
			before_task_id: 1,
			order_version: version,
		}),
		result: JSON.stringify(output),
		success: true,
	})!
	await value.getMutationCache().build(value, agentRefreshMutationOptions()).execute(planAgentRefresh([receipt]))
}

beforeEach(() => vi.resetAllMocks())
afterEach(() => {
	stops.splice(0).forEach(stop => stop())
	clients.splice(0).forEach(value => value.clear())
	removeToken()
})

describe('view-order receipts through the real query lifecycle', () => {
	it('reorders a fully loaded board without refetching and preserves another view and detail position', async () => {
		const value = client()
		const key = kanbanKeys.board(1, 4)
		const other = kanbanKeys.board(1, 5)
		value.setQueryData<BoardData>(key, {
			buckets: [normalizeBucket({id: 8, count: 3, tasks: [card(1, 100), card(2, 250), card(3, 300)]})],
			pages: {8: 1},
		})
		const otherBoard: BoardData = {
			buckets: [normalizeBucket({id: 9, count: 1, tasks: [{...card(3, 900), positions: []}]})],
			pages: {9: 1},
		}
		value.setQueryData(other, otherBoard)
		value.setQueryData(taskKeys.detail(3), {
			...card(3, 0),
			positions: [
				{task_id: 3, project_view_id: 4, position: 300},
				{task_id: 3, project_view_id: 5, position: 900},
			],
		})
		const fetch = observe(value, key)

		await apply(value)

		expect(value.getQueryData<BoardData>(key)!.buckets[0].tasks.map(task => task.id)).toEqual([3, 1, 2])
		expect(value.getQueryData<BoardData>(key)!.pages).toEqual({8: 1})
		expect(value.getQueryData<BoardData>(other)!.buckets[0].tasks[0].position).toBe(900)
		expect(value.getQueryData<Task>(taskKeys.detail(3))).toMatchObject({
			position: 0,
			positions: [
				{project_view_id: 4, position: 50},
				{project_view_id: 5, position: 900},
			],
		})
		expect(fetch).not.toHaveBeenCalled()
		expect(sdk.projectViewBucketsTasksList).not.toHaveBeenCalled()
	})

	it('brings an unloaded card into a partial board while preserving its two loaded pages', async () => {
		const value = client()
		const key = kanbanKeys.board(1, 4, {q: 'matching'})
		value.setQueryData<BoardData>(key, {
			buckets: [normalizeBucket({id: 8, count: 60, tasks: Array.from({length: 50}, (_, i) => card(i + 1, (i + 1) * 100))})],
			pages: {8: 2},
		})
		const fetch = observe(value, key)
		const ordered = [card(60, 50), ...Array.from({length: 49}, (_, i) => card(i + 1, (i + 1) * 100))]
		sdk.projectViewBucketsTasksList.mockResolvedValue({data: {items: [{
			id: 8,
			count: 60,
			tasks: ordered.slice(0, 25),
		}]}})
		sdk.projectViewTasksList.mockResolvedValue({data: {items: ordered.slice(25)}})

		await apply(value, result({
			task_ids: [60],
			changed_positions: [{task_id: 60, project_view_id: 4, position: 50}],
		}))

		const board = value.getQueryData<BoardData>(key)!
		expect(board.pages).toEqual({8: 2})
		expect(board.buckets[0].tasks.map(task => task.id)).toEqual(ordered.map(task => task.id))
		expect(sdk.projectViewTasksList).toHaveBeenCalledWith(expect.objectContaining({
			path: {project: 1, view: 4},
			query: expect.objectContaining({page: 2, q: 'matching'}),
		}))
		expect(fetch).not.toHaveBeenCalled()
	})

	it('refetches the active position-sorted page in place and leaves a different sort order intact', async () => {
		const value = client()
		const scope = {project: 1, view: 4, params: {sort_by: ['position'], order_by: ['asc']}}
		const first = taskKeys.list(scope, 1)
		const second = taskKeys.list(scope, 2)
		const dated = taskKeys.list({project: 1, view: 4, params: {sort_by: ['due_date']}}, 2)
		const page = (items: ReturnType<typeof card>[], number: number): PaginatedTaskResponse => ({
			items,
			total: 4,
			page: number,
			per_page: 2,
			total_pages: 2,
		})
		value.setQueryData(first, page([card(1, 100), card(2, 250)], 1))
		value.setQueryData(second, page([card(3, 300), card(4, 400)], 2))
		value.setQueryData(dated, page([card(3, 300), card(4, 400)], 2))
		const currentPage = vi.fn(async () => page([card(2, 250), card(4, 400)], 2))
		const datePage = vi.fn(async () => page([], 2))
		observe(value, second, currentPage)
		observe(value, dated, datePage)

		await apply(value, result({view_kind: 'list', bucket_id: 0}))

		expect(value.getQueryData<PaginatedTaskResponse>(second)!.items.map(task => task.id)).toEqual([2, 4])
		expect(value.getQueryData<PaginatedTaskResponse>(second)!.page).toBe(2)
		expect(value.getQueryState(first)?.isInvalidated).toBe(true)
		expect(value.getQueryData<PaginatedTaskResponse>(dated)!.items.map(task => task.id)).toEqual([3, 4])
		expect(currentPage).toHaveBeenCalledTimes(1)
		expect(datePage).not.toHaveBeenCalled()
	})
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(yes => { resolve = yes })
	return {promise, resolve}
}

const onePage = (items: ReturnType<typeof card>[]): PaginatedTaskResponse => ({
	items,
	total: items.length,
	page: 1,
	per_page: 25,
	total_pages: 1,
})

describe('authoritative order read boundaries', () => {
	it('cancels a stale date-sorted read, refreshes its metadata, and accepts a later legitimate read', async () => {
		const value = client()
		const key = taskKeys.list({
			project: 1,
			view: 4,
			params: {sort_by: ['due_date']},
		})
		value.setQueryData(key, onePage([card(3, 300), card(1, 100)]))
		const old = deferred<{data: PaginatedTaskResponse}>()
		let signal: AbortSignal | undefined
		const read = sdk.projectViewTasksList
			.mockImplementationOnce(({signal: current}: {signal: AbortSignal}) => {
				signal = current
				return old.promise
			})
			.mockResolvedValueOnce({data: onePage([card(3, 50), card(1, 100)])})
			.mockResolvedValueOnce({data: onePage([card(3, 900), card(1, 100)])})
		const query = tasksQuery({
			project: 1,
			view: 4,
			params: taskKeys.paramsOf(key),
		})
		if (typeof query.queryFn !== 'function') throw new Error('Task query must provide its real reader')
		stops.push(new QueryObserver(value, {
			queryKey: query.queryKey,
			queryFn: query.queryFn,
		}).subscribe(() => {}))
		const stale = value.refetchQueries({queryKey: key, exact: true})
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))

		await apply(value)
		expect(signal?.aborted).toBe(true)
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items.map(task => task.id)).toEqual([3, 1])
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items[0].positions?.[0].position).toBe(50)
		old.resolve({data: onePage([card(3, 300), card(1, 100)])})
		await stale
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items[0].position).toBe(50)

		await value.refetchQueries({queryKey: key, exact: true})
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items[0].position).toBe(900)
		expect(read).toHaveBeenCalledTimes(3)
	})

	it('preserves receipt order across two concurrent mutations while an older read is pending', async () => {
		const value = client()
		const key = taskKeys.list({
			project: 1,
			view: 4,
			params: {sort_by: ['position']},
		})
		value.setQueryData(key, onePage([card(1, 100), card(2, 250), card(3, 300)]))
		const old = deferred<{data: PaginatedTaskResponse}>()
		const read = sdk.projectViewTasksList
			.mockImplementationOnce(({signal}: {signal: AbortSignal}) => {
				signal.addEventListener('abort', () => {}, {once: true})
				return old.promise
			})
			.mockResolvedValue({data: onePage([card(1, 100), card(2, 250), card(3, 400)])})
		const query = tasksQuery({
			project: 1,
			view: 4,
			params: taskKeys.paramsOf(key),
		})
		if (typeof query.queryFn !== 'function') throw new Error('Task query must provide its real reader')
		stops.push(new QueryObserver(value, {
			queryKey: query.queryKey,
			queryFn: query.queryFn,
		}).subscribe(() => {}))
		const stale = value.refetchQueries({queryKey: key, exact: true})
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))

		await Promise.all([
			apply(value),
			apply(value, result({changed_positions: [{task_id: 3, project_view_id: 4, position: 400}]})),
		])
		old.resolve({data: onePage([card(1, 100), card(2, 250), card(3, 300)])})
		await stale
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items.map(task => task.id)).toEqual([1, 2, 3])
		expect(value.getQueryData<PaginatedTaskResponse>(key)!.items[2].position).toBe(400)
	})

	it('keeps patched cards and loaded depth after a board refresh failure', async () => {
		const value = client()
		const key = kanbanKeys.board(1, 4)
		value.setQueryData<BoardData>(key, {
			buckets: [normalizeBucket({id: 8, count: 60, tasks: [card(1, 100), card(3, 300)]})],
			pages: {8: 2},
		})
		observe(value, key)
		sdk.projectViewBucketsTasksList.mockRejectedValue(new Error('fixture unavailable'))

		await apply(value)

		expect(value.getQueryData<BoardData>(key)!.pages).toEqual({8: 2})
		expect(value.getQueryData<BoardData>(key)!.buckets[0].tasks.map(task => task.id)).toEqual([3, 1])
		expect(value.getQueryState(key)?.isInvalidated).toBe(true)
	})

	it.each(['API', 'identity', 'session'])('rejects a late board response after the %s owner changes', async change => {
		const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
		saveToken(token(1), false)
		const value = client()
		const key = kanbanKeys.board(1, 4)
		const board: BoardData = {
			buckets: [normalizeBucket({id: 8, count: 60, tasks: [card(1, 100), card(3, 300)]})],
			pages: {8: 1},
		}
		value.setQueryData(key, board)
		observe(value, key)
		const read = deferred<{data: {items: {id: number; count: number; tasks: ReturnType<typeof card>[]}[]}}>()
		sdk.projectViewBucketsTasksList.mockReturnValue(read.promise)
		const pending = apply(value)
		await vi.waitFor(() => expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1))
		const original = window.API_URL
		try {
			if (change === 'API') window.API_URL = 'https://other-server.invalid'
			if (change === 'identity') saveToken(token(2), false)
			if (change === 'session') {
				removeToken()
				saveToken(token(1), false)
			}
			const replacement = {...board, buckets: [normalizeBucket({id: 8, count: 1, tasks: [card(99, 9900)]})]}
			value.setQueryData(key, replacement)
			read.resolve({data: {items: [{id: 8, count: 2, tasks: [card(3, 50), card(1, 100)]}]}})
			await expect(pending).rejects.toMatchObject({name: 'AbortError'})
			expect(value.getQueryData<BoardData>(key)!.buckets[0].tasks.map(task => task.id)).toEqual([99])
		} finally {
			window.API_URL = original
		}
	})
})

it('adds missing view-position metadata to relations without changing another view scalar or an already moved task', async () => {
	const value = client()
	const whole = taskKeys.allList({
		project: 1,
		view: 4,
		params: {sort_by: ['position'], order_by: ['desc']},
	})
	value.setQueryData(whole, [card(3, 300), card(2, 250), card(1, 100)])
	value.setQueryData(taskKeys.detail(9), normalizeTask({
		id: 9,
		project_id: 1,
		related_tasks: {subtask: [{id: 3, project_id: 1, position: 700}]},
	}))
	value.setQueryData(taskKeys.detail(3), {...card(3, 500), project_id: 2, positions: []})

	await apply(value, result({view_kind: 'list', bucket_id: 0}))

	expect(value.getQueryData<ReturnType<typeof card>[]>(whole)!.map(task => task.id)).toEqual([2, 1, 3])
	const nested = value.getQueryData<Task>(taskKeys.detail(9))!.related_tasks!.subtask![0]
	expect(nested).toMatchObject({
		position: 700,
		positions: [{task_id: 3, project_view_id: 4, position: 50}],
	})
	expect(value.getQueryData<Task>(taskKeys.detail(3))).toMatchObject({project_id: 2, position: 500, positions: []})
})

it('restarts an initial board GET without materializing an empty board or losing a later valid server response', async () => {
	const value = client()
	const key = kanbanKeys.board(1, 4)
	const old = deferred<{data: {items: {id: number; count: number; tasks: ReturnType<typeof card>[]}[]}}>()
	sdk.projectViewBucketsTasksList
		.mockImplementationOnce(({signal}: {signal: AbortSignal}) => {
			signal.addEventListener('abort', () => {}, {once: true})
			return old.promise
		})
		.mockResolvedValueOnce({data: {items: [{
			id: 8,
			count: 3,
			tasks: [card(3, 50), card(1, 100), card(2, 250)],
		}]}})
	const query = kanbanQuery(1, 4)
	if (typeof query.queryFn !== 'function') throw new Error('Board query must provide its real reader')
	stops.push(new QueryObserver(value, {
		queryKey: query.queryKey,
		queryFn: query.queryFn,
	}).subscribe(() => {}))
	await vi.waitFor(() => expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1))
	expect(value.getQueryData(key)).toBeUndefined()

	await apply(value)
	old.resolve({data: {items: [{id: 8, count: 3, tasks: [card(1, 100), card(2, 250), card(3, 300)]}]}})

	expect(value.getQueryData<BoardData>(key)!.buckets[0].tasks.map(task => task.id)).toEqual([3, 1, 2])
	expect(value.getQueryData<BoardData>(key)!.pages).toEqual({8: 1})
	expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(2)
})

it('does not reread a fully loaded filtered collection when the reordered task is excluded', async () => {
	const value = client()
	const scope = {
		project: 1,
		view: 4,
		params: {
			q: 'Only another task',
			sort_by: ['position'],
		},
	}
	const key = taskKeys.allList(scope)
	const pageKey = taskKeys.list(scope, 1)
	value.setQueryData(key, [card(1, 100)])
	value.setQueryData(pageKey, onePage([card(1, 100)]))
	const readAll = observe(value, key)
	const readPage = observe(value, pageKey)

	await apply(value, result({view_kind: 'list', bucket_id: 0, position_recalculated: true}))

	expect(value.getQueryData<ReturnType<typeof card>[]>(key)!.map(task => task.id)).toEqual([1])
	expect(readAll).not.toHaveBeenCalled()
	expect(readPage).not.toHaveBeenCalled()
})
