import {hashKey, type QueryClient, type QueryKey} from '@tanstack/vue-query'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isRequestContextAbort,
	isClientRequestContextCurrent,
} from '@/client/requestContext'
import {error, translatedError} from '@/message'
import {kanbanKeys, type BoardData} from './kanban'
import {refreshAgentBoards} from './kanbanServerRefresh'
import type {Task} from '@/client/generated'
import {taskKeys, type PaginatedTaskResponse, type TaskResponse} from './tasks'

import {type TaskOrderResult, type ViewTaskPosition} from '@/helpers/taskOrder'
export {parseTaskOrderResult, type TaskOrderResult} from '@/helpers/taskOrder'

function manualSort(key: QueryKey): boolean {
	const sort = taskKeys.paramsOf(key)?.sort_by?.[0]
	return sort === 'position'
}

function sortTasks(tasks: TaskResponse[], key?: QueryKey): TaskResponse[] {
	const direction = key && taskKeys.paramsOf(key)?.order_by?.[0] === 'desc' ? -1 : 1
	return [...tasks].sort((a, b) => direction * (a.position - b.position))
}

/** Position metadata belongs to a view; a detail's scalar position has no view context. */
export function patchTaskViewPositions(
	client: QueryClient,
	view: number,
	positions: readonly ViewTaskPosition[],
	project?: number,
) {
	const changed = new Map(positions.map(position => [position.task_id, position]))
	// A healing receipt can change many positions. Visit each cached task once, rather than
	// scanning the whole cache once per changed ID. Nested relations carry metadata only.
	function patch<T extends Task>(task: T, scalar = false): T {
		const position = changed.get(task.id ?? 0)
		let next = task
		if (position && (project === undefined || task.project_id === project)) {
			const previous = task.positions ?? []
			next = {
				...task,
				positions: previous.some(entry => entry.project_view_id === view)
					? previous.map(entry => entry.project_view_id === view ? {...entry, ...position} : entry)
					: [...previous, position],
				...(scalar ? {position: position.position} : {}),
			}
		}
		for (const [relation, children] of Object.entries(task.related_tasks ?? {})) {
			if (!children) continue
			const mapped = children.map(child => patch(child))
			if (mapped.some((child, index) => child !== children[index])) {
				next = {...next, related_tasks: {...next.related_tasks, [relation]: mapped}}
			}
		}
		return next
	}
	for (const [key, task] of client.getQueriesData<TaskResponse>({queryKey: taskKeys.details})) {
		if (!task) continue
		const next = patch(task)
		if (next !== task) client.setQueryData(key, next)
	}
	for (const [key, items] of client.getQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists})) {
		if (!items) continue
		const inView = taskKeys.viewOf(key) === view && (project === undefined || taskKeys.projectOf(key) === project)
		const mapped = items.map(task => patch(task, inView))
		const next = inView && manualSort(key) ? sortTasks(mapped, key) : mapped
		if (next.some((task, index) => task !== items[index])) client.setQueryData(key, next)
	}
	for (const [key, list] of client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})) {
		if (!list) continue
		const inView = taskKeys.viewOf(key) === view && (project === undefined || taskKeys.projectOf(key) === project)
		const mapped = list.items.map(task => patch(task, inView))
		// Across pages, only the server knows which cards now belong to this page.
		const items = inView && (list.total_pages ?? 1) <= 1 && manualSort(key) ? sortTasks(mapped, key) : mapped
		if (items.some((task, index) => task !== list.items[index])) client.setQueryData(key, {...list, items})
	}
	for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		if (!board) continue
		const inView = kanbanKeys.viewOf(key) === view && (project === undefined || kanbanKeys.projectOf(key) === project)
		const buckets = board.buckets.map(bucket => {
			const mapped = bucket.tasks.map(task => patch(task, inView))
			const tasks = inView ? sortTasks(mapped) : mapped
			return tasks.some((task, index) => task !== bucket.tasks[index]) ? {...bucket, tasks} : bucket
		})
		if (buckets.some((bucket, index) => bucket !== board.buckets[index])) client.setQueryData(key, {...board, buckets})
	}
}

const orderJobs = new WeakMap<QueryClient, Map<string, Promise<void>>>()

/** Same-view receipts retain their execution order, including across streaming batches. */
export function applyServerTaskOrder(client: QueryClient, result: TaskOrderResult): Promise<void> {
	const context = captureClientRequestContext()
	let jobs = orderJobs.get(client)
	if (!jobs) {
		jobs = new Map()
		orderJobs.set(client, jobs)
	}
	const active = jobs
	const key = hashKey([context, result.project_id, result.view_id])
	const previous = active.get(key) ?? Promise.resolve()
	const job = previous.catch(() => {}).then(async () => {
		assertClientRequestContext(context)
		await reconcileTaskOrder(client, result, context)
	}).finally(() => {
		if (active.get(key) === job) active.delete(key)
	})
	active.set(key, job)
	return job
}

/** Reconcile only affected view windows, retaining page numbers and loaded board depth. */
async function reconcileTaskOrder(
	client: QueryClient,
	result: TaskOrderResult,
	context: ReturnType<typeof captureClientRequestContext>,
): Promise<void> {
	const affected = new Set(result.changed_positions.map(position => position.task_id))
	const boardKeys = client.getQueryCache().findAll({queryKey: kanbanKeys.view(result.project_id, result.view_id)})
		.filter(query => {
			const board = query.state.data as BoardData | undefined
			const bucket = board?.buckets.find(item => item.id === result.bucket_id)
			const loaded = new Set(bucket?.tasks.map(task => task.id))
			return !board || query.state.fetchStatus === 'fetching' || result.position_recalculated || !bucket
				|| bucket.count > bucket.tasks.length
				|| [...affected].some(task => !loaded.has(task))
		}).map(query => query.queryKey)
	// Complete lists keep the same membership: an absent ID may simply be filtered out.
	// Only paginated windows need the server to redistribute cards across page boundaries.
	const listKeys = client.getQueryCache().findAll({queryKey: taskKeys.lists})
		.filter(query => {
			if (taskKeys.projectOf(query.queryKey) !== result.project_id || taskKeys.viewOf(query.queryKey) !== result.view_id
				|| !manualSort(query.queryKey)) return false
			const list = query.state.data as PaginatedTaskResponse | undefined
			return !list || query.state.fetchStatus === 'fetching' || list.total_pages > 1
		}).map(query => query.queryKey)
	// This authoritative receipt is the boundary between an older GET snapshot and a fresh
	// server read, like the shared SSE task helpers. Cancel only in-flight reads for this view,
	// without rollback; subsequent normal reads remain authoritative (no sticky write override).
	const pending = client.getQueryCache().findAll({predicate: query => query.state.fetchStatus === 'fetching'
		&& ((taskKeys.projectOf(query.queryKey) === result.project_id && taskKeys.viewOf(query.queryKey) === result.view_id
			&& (query.queryKey[1] === 'list' || query.queryKey[1] === 'all'))
			|| (query.queryKey[0] === 'kanban' && kanbanKeys.projectOf(query.queryKey) === result.project_id
				&& kanbanKeys.viewOf(query.queryKey) === result.view_id))})
	await Promise.all(pending.map(query => client.cancelQueries({queryKey: query.queryKey, exact: true}, {revert: false, silent: true})))
	assertClientRequestContext(context)
	patchTaskViewPositions(client, result.view_id, result.changed_positions, result.project_id)
	await Promise.all([
		...[...new Map([...listKeys,
			...pending.filter(query => query.queryKey[0] === 'tasks').map(query => query.queryKey),
		].map(key => [JSON.stringify(key), key])).values()]
			.map(queryKey => client.invalidateQueries({queryKey, exact: true})),
		...boardKeys.map(async queryKey => {
			// An initial board has no loaded depth yet; restart its cancelled first read normally.
			if (!client.getQueryData(queryKey)) {
				await client.invalidateQueries({queryKey, exact: true})
				return
			}
			await client.invalidateQueries({queryKey, exact: true, refetchType: 'none'})
			assertClientRequestContext(context)
			try {
				await refreshAgentBoards(client, [queryKey])
			} catch (cause) {
				if (isClientRequestContextCurrent(context) && !isRequestContextAbort(cause)) {
					error(translatedError('project.kanban.refreshFailed'))
				}
			}
		}),
	])
}
