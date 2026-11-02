import {hashKey, type QueryClient, type QueryKey} from '@tanstack/vue-query'
import type {Task} from '@/client/generated'
import {captureClientRequestContext, isClientRequestContextCurrent, type ClientRequestContext} from '@/client/requestContext'
import {mapTasksDeep, mergeTask, removeTask} from '@/helpers/task'
import {normalizeTask, taskKeys, type PaginatedTaskResponse, type TaskResponse} from './tasks'
import {kanbanKeys, type BoardData} from './kanban'
import {totalPagesFor} from './pagination'
import {projectTimelineKeys} from './projectTimeline'
import {invalidateCalendarTasks} from './calendar'

// Applies `update` to every cached copy of task `id` (detail, lists, boards, nested relations),
// so a mutation response patches all mounted views without refetching them.
export function mapTaskEverywhere(
	client: QueryClient,
	id: number,
	update: (task: TaskResponse) => TaskResponse,
) {
	const map = (tasks: readonly TaskResponse[]) =>
		mapTasksDeep(tasks, id, task => update(normalizeTask(task))).map(normalizeTask)
	const holds = (tasks: readonly TaskResponse[]) => containsTask(tasks, id)
	client.setQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists}, current =>
		current && holds(current) ? map(current) : undefined,
	)
	client.setQueriesData<TaskResponse>({queryKey: taskKeys.details}, current =>
		current && holds([current]) ? map([current])[0] : undefined,
	)
	client.setQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists}, current =>
		current && holds(current.items) ? {...current, items: map(current.items)} : undefined,
	)
	client.setQueriesData<BoardData>({queryKey: kanbanKeys.all}, current => {
		if (!current) return undefined
		const buckets = current.buckets.map(bucket =>
			holds(bucket.tasks) ? {...bucket, tasks: map(bucket.tasks)} : bucket,
		)
		return buckets.some((bucket, index) => bucket !== current.buckets[index])
			? {...current, buckets}
			: undefined
	})
}

// undefined: task absent, entry stays untouched
type TaskRemoval = (tasks: readonly TaskResponse[], id: number) => TaskResponse[] | undefined

// Relations cross projects, so a move only drops top-level membership.
const dropMembership: TaskRemoval = (tasks, id) => tasks.some(task => task.id === id)
	? tasks.filter(task => task.id !== id)
	: undefined

const dropEverywhere: TaskRemoval = (tasks, id) => containsTask(tasks, id)
	? removeTask(tasks, id).map(normalizeTask)
	: undefined

// Favorites and saved filters span projects.
const isRealProject = (project: number | null | undefined): project is number =>
	typeof project === 'number' && project > 0

function containsTask(tasks: readonly Task[], id: number): boolean {
	return tasks.some(task => task.id === id
		|| Object.values(task.related_tasks ?? {}).some(children => containsTask(children ?? [], id)))
}

export function taskQueryKeys(client: QueryClient, id: number): QueryKey[] {
	return [
		...client.getQueriesData<TaskResponse>({queryKey: taskKeys.details})
			.filter(([, task]) => task && containsTask([task], id)),
		...client.getQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists})
			.filter(([, tasks]) => tasks && containsTask(tasks, id)),
		...client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})
			.filter(([, list]) => list && containsTask(list.items, id)),
		...client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})
			.filter(([, board]) => board?.buckets.some(bucket => containsTask(bucket.tasks, id))),
	].map(([key]) => key)
}

type CollectionRemoval = {kind: 'move', project: number} | {kind: 'delete'}

function removeTaskFromCollections(client: QueryClient, id: number, removal: CollectionRemoval) {
	const movedTo = removal.kind === 'move' ? removal.project : undefined
	const remove: TaskRemoval = movedTo === undefined ? dropEverywhere : dropMembership
	const inScope = (project: number | null | undefined) =>
		movedTo === undefined || (isRealProject(project) && project !== movedTo)
	for (const [key, tasks] of client.getQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists})) {
		if (!tasks || !inScope(taskKeys.projectOf(key))) continue
		const items = remove(tasks, id)
		if (items) client.setQueryData(key, items)
	}
	// Every cached page of a scope shares total and total_pages, not only the page holding the task.
	const removedPerScope = new Map<string, number>()
	const scopeOf = (key: QueryKey) => hashKey(key.slice(0, -1))
	for (const [key, list] of client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})) {
		if (!list || !inScope(taskKeys.projectOf(key))) continue
		const items = remove(list.items, id)
		if (!items) continue
		client.setQueryData(key, {...list, items})
		removedPerScope.set(scopeOf(key), (removedPerScope.get(scopeOf(key)) ?? 0) + list.items.length - items.length)
	}
	for (const [key, list] of client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})) {
		const removed = removedPerScope.get(scopeOf(key))
		if (!list || !removed) continue
		const total = Math.max(0, list.total - removed)
		const total_pages = totalPagesFor(list, total)
		client.setQueryData(key, {...list, total, total_pages})
	}
	for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		if (!board || !inScope(kanbanKeys.projectOf(key))) continue
		const next = removeFromBoard(board, id, remove)
		if (next) client.setQueryData(key, next)
	}
}

function removeFromBoard(board: BoardData, id: number, remove: TaskRemoval): BoardData | undefined {
	const buckets = board.buckets.map(bucket => {
		const tasks = remove(bucket.tasks, id)
		if (!tasks) return bucket
		return {...bucket, tasks, count: Math.max(0, bucket.count - (bucket.tasks.length - tasks.length))}
	})
	return buckets.some((bucket, index) => bucket !== board.buckets[index]) ? {...board, buckets} : undefined
}

// A move keeps pseudo-project boards (membership is server-decided), so the drag source drops its own card.
export function removeTaskFromBoard(client: QueryClient, key: QueryKey, id: number) {
	client.setQueryData<BoardData>(key, board => board && removeFromBoard(board, id, dropMembership))
}

export function replaceTaskEverywhere(client: QueryClient, updated: Task) {
	if (updated.id === undefined) return
	if (updated.project_id) {
		removeTaskFromCollections(client, updated.id, {kind: 'move', project: updated.project_id})
	}
	mapTaskEverywhere(client, updated.id, current => normalizeTask(mergeTask(current, updated)))
}

function collectTaskCopies(tasks: readonly Task[], id: number, found: Task[]) {
	for (const task of tasks) {
		if (task.id === id) found.push(task)
		for (const children of Object.values(task.related_tasks ?? {})) collectTaskCopies(children ?? [], id, found)
	}
}

/**
 * True when a cached copy of the task was updated after `task` was: a late receipt or a delayed response
 * must not overwrite a newer write. Without timestamps nothing can be compared, so it is not stale.
 */
export function isStaleTask(client: QueryClient, task: Task): boolean {
	const incoming = Date.parse(task.updated ?? '')
	if (task.id === undefined || Number.isNaN(incoming)) return false
	const copies: Task[] = []
	for (const [, detail] of client.getQueriesData<TaskResponse>({queryKey: taskKeys.details})) {
		if (detail) collectTaskCopies([detail], task.id, copies)
	}
	for (const [, tasks] of client.getQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists})) {
		if (tasks) collectTaskCopies(tasks, task.id, copies)
	}
	for (const [, list] of client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})) {
		if (list) collectTaskCopies(list.items, task.id, copies)
	}
	for (const [, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		for (const bucket of board?.buckets ?? []) collectTaskCopies(bucket.tasks, task.id, copies)
	}
	return copies.some(copy => Date.parse(copy.updated ?? '') > incoming)
}

export class TaskDeletedError extends Error {
	// Shaped like the API's 404 so views that handle a missing task treat it the same way.
	readonly status = 404

	constructor(readonly taskId: number) {
		super(`Task ${taskId} was deleted`)
		this.name = 'TaskDeletedError'
	}
}

// Ids only mean something for one account on one API: another login or server starts a fresh record.
type ServerWrite = {updated: number, sequence: number}
type ServerChangeRecord = {context: ClientRequestContext, deleted: Set<number>, written: Map<number, ServerWrite>}
const serverChanges = new WeakMap<QueryClient, ServerChangeRecord>()
// Orders server writes against the start of local saves, independent of timestamp precision.
let serverWriteSequence = 0

function serverChangeRecord(client: QueryClient): ServerChangeRecord {
	let record = serverChanges.get(client)
	if (!record || !isClientRequestContextCurrent(record.context)) {
		record = {context: captureClientRequestContext(), deleted: new Set(), written: new Map()}
		serverChanges.set(client, record)
	}
	return record
}

function deletedTaskIds(client: QueryClient): Set<number> {
	return serverChangeRecord(client).deleted
}

/** Remembers that a change made elsewhere (an Arona receipt) wrote this version of a task. */
export function recordServerTaskWrite(client: QueryClient, task: Task) {
	const updated = Date.parse(task.updated ?? '')
	if (task.id === undefined || Number.isNaN(updated)) return
	const written = serverChangeRecord(client).written
	written.set(task.id, {updated: Math.max(written.get(task.id)?.updated ?? updated, updated), sequence: ++serverWriteSequence})
}

/** Taken when a local save starts; pass it to isOvertakenByServerWrite with the save's answer. */
export function serverWriteMark(): number {
	return serverWriteSequence
}

/**
 * Whether a change made elsewhere after `since` (the save's start) wrote a newer version than this
 * answer to a local save, e.g. a receipt that arrived while the PATCH was in flight. Versions that were
 * already cached or recorded when the save started never count: their timestamps can be finer than the
 * answer's whole seconds and would wrongly win over the user's later save.
 */
export function isOvertakenByServerWrite(client: QueryClient, task: Task, since: number): boolean {
	const updated = Date.parse(task.updated ?? '')
	if (task.id === undefined || Number.isNaN(updated)) return false
	const write = serverChangeRecord(client).written.get(task.id)
	return write !== undefined && write.sequence > since && write.updated > updated
}

/** Whether a server change said this task is gone, so a pending draft must not try to save it. */
export function isTaskDeleted(client: QueryClient, id: number): boolean {
	return deletedTaskIds(client).has(id)
}

/**
 * Puts mounted detail queries of a task deleted elsewhere into an error state. Removing a query from the
 * cache does not reach an observer that already holds it, which would leave a stale, editable detail open.
 */
export function failTaskDetails(client: QueryClient, id: number) {
	deletedTaskIds(client).add(id)
	for (const query of client.getQueryCache().findAll({queryKey: [...taskKeys.details, id]})) {
		if (!query.getObserversCount()) continue
		query.setState({
			...query.state,
			data: undefined,
			status: 'error',
			fetchStatus: 'idle',
			error: new TaskDeletedError(id),
			errorUpdatedAt: Date.now(),
		})
	}
}

export function removeTaskEverywhere(client: QueryClient, id: number) {
	// Mounted observers retain their query after removeQueries, including a later visit during a slow DELETE.
	failTaskDetails(client, id)
	removeTaskFromCollections(client, id, {kind: 'delete'})
	client.removeQueries({queryKey: [...taskKeys.details, id]})
	client.setQueriesData<TaskResponse>({queryKey: taskKeys.details}, current =>
		current ? removeTask([current], id).map(normalizeTask)[0] : current,
	)
}

export async function invalidateTaskMembership(
	client: QueryClient,
	id?: number,
	refetchType: 'none' | 'active' = 'none',
) {
	await Promise.all([
		client.invalidateQueries({queryKey: taskKeys.lists, refetchType}),
		client.invalidateQueries({queryKey: taskKeys.allLists, refetchType}),
		// Refetching a board returns only the first page per bucket, so mutations patch it instead of refetching.
		client.invalidateQueries({queryKey: kanbanKeys.all, refetchType: 'none'}),
		...(id === undefined ? [] : [client.invalidateQueries({queryKey: [...taskKeys.details, id], refetchType})]),
		// Dates, progress and completion feed the timeline; only a mounted timeline refetches.
		client.invalidateQueries({queryKey: projectTimelineKeys.all}),
		invalidateCalendarTasks(client),
	])
}

/** Every cached copy of a task (details, lists, boards and nested relations), read without touching the cache. */
export function cachedTaskCopies(client: QueryClient, id: number): Task[] {
	const copies: Task[] = []
	for (const [, detail] of client.getQueriesData<TaskResponse>({queryKey: taskKeys.details})) {
		if (detail) collectTaskCopies([detail], id, copies)
	}
	for (const [, tasks] of client.getQueriesData<TaskResponse[]>({queryKey: taskKeys.allLists})) {
		if (tasks) collectTaskCopies(tasks, id, copies)
	}
	for (const [, list] of client.getQueriesData<PaginatedTaskResponse>({queryKey: taskKeys.lists})) {
		if (list) collectTaskCopies(list.items, id, copies)
	}
	for (const [, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		for (const bucket of board?.buckets ?? []) collectTaskCopies(bucket.tasks, id, copies)
	}
	return copies
}
