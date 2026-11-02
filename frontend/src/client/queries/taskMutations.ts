import {hashKey, useMutation, type QueryClient, type QueryKey} from '@tanstack/vue-query'
import {
	tasksCreate,
	tasksRead,
	patchTasksRead,
	tasksDelete,
	tasksBulkCreate,
	tasksDuplicate,
	tasksMarkRead,
	taskAssigneesCreate,
	taskAssigneesDelete,
	taskLabelsCreate,
	taskLabelsDelete,
	tasksRelationsCreate,
	tasksRelationsDelete,
	tasksPositionUpdate,
	taskBucketUpdate,
	type Task,
	type TaskWritable,
	type User,
	type Label,
	type TaskRelationWritable,
	type TasksRelationsDeleteData,
	type TaskPositionWritable,
	type JsonPatchOp,
	type Bucket,
} from '@/client/generated'
import {client as sdkClient} from '@/client/generated/client.gen'
import {assertClientRequestContext, captureClientRequestContext, isRequestContextAbort, type ClientRequestContext} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {normalizeTask, taskKeys, type TaskFilterParams, type TaskResponse} from './tasks'
import {bucketKeys, kanbanKeys, normalizeBucket, type BoardData} from './kanban'
import {
	cachedTaskCopies,
	invalidateTaskMembership,
	isOvertakenByServerWrite,
	isStaleTask,
	mapTaskEverywhere,
	recordServerTaskWrite,
	removeTaskEverywhere,
	replaceTaskEverywhere,
	serverWriteMark,
	taskQueryKeys,
} from './taskCache'
import {projectTimelineKeys, type ProjectTimelineQuery} from './projectTimeline'
import {invalidateCalendarTasks} from './calendar'
import {patchTaskViewPositions} from './taskOrder'
import {agentBoardKeys, refreshAgentBoards} from './kanbanServerRefresh'
import {getCachedProject, projectKeys} from './projects'
import {colorFromHex} from '@/helpers/color/colorFromHex'
import {getDefaultBucketId, moveTaskToBucket} from '@/helpers/task'
import {error, translatedError} from '@/message'

const API_ZERO_DATE = '0001-01-01T00:00:00Z'

const writableFields = [
	'title',
	'description',
	'done',
	'due_date',
	'start_date',
	'end_date',
	'all_day',
	'all_day_start',
	'all_day_end',
	'priority',
	'hex_color',
	'percent_done',
	'repeat_after',
	'repeat_mode',
	'is_favorite',
	'bucket_id',
	'project_id',
	'reminders',
	'cover_image_attachment_id',
] as const satisfies readonly (keyof TaskWritable)[]

export function taskWriteBody(task: Task): TaskWritable {
	const body: TaskWritable = Object.fromEntries(
		writableFields
			.filter(field => task[field] !== undefined)
			.map(field => [field, task[field]]),
	)
	if (body.title !== undefined) body.title = body.title.trim()
	if (body.hex_color !== undefined) body.hex_color = colorFromHex(body.hex_color)
	for (const field of ['due_date', 'start_date', 'end_date'] as const) {
		if (body[field] === '') body[field] = API_ZERO_DATE
	}
	if (body.reminders) body.reminders = body.reminders.map(reminder => ({
		...reminder,
		reminder: reminder.reminder === '' ? API_ZERO_DATE : reminder.reminder,
	}))
	return body
}

function taskPatchBody(task: Task): JsonPatchOp[] {
	return Object.entries(taskWriteBody(task)).map(([field, value]) => ({op: 'add', path: `/${field}`, value}))
}

function reconcileDoneBuckets(client: QueryClient, task: TaskResponse) {
	const handled = new Set<number>()
	for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		const project = kanbanKeys.projectOf(key)
		const viewId = kanbanKeys.viewOf(key)
		if (!board || project === undefined || viewId === undefined) continue
		const view = getCachedProject(project, client)?.views?.find(item => item.id === viewId)
		if (!view?.done_bucket_id) continue
		const source = board.buckets.find(bucket => bucket.tasks.some(item => item.id === task.id))
		if (!source) continue
		handled.add(viewId)
		const target = task.done
			? view.done_bucket_id
			: source.id === view.done_bucket_id
				? getDefaultBucketId(view, board.buckets)
				: source.id
		if (target === undefined) continue
		const buckets = moveTaskToBucket(board.buckets, task, target)
		if (buckets === board.buckets) continue
		client.setQueryData(key, {...board, buckets: buckets.map(normalizeBucket)})
		reconcileTaskBuckets(client, {project, view: viewId, bucket: target, task: task.id})
	}
	reconcileDoneBucketsWithoutBoard(client, task, handled)
}

// Without a board holding the card, the detail's own buckets array is the only record of where it sits.
function reconcileDoneBucketsWithoutBoard(client: QueryClient, task: TaskResponse, handled: Set<number>) {
	for (const view of getCachedProject(task.project_id, client)?.views ?? []) {
		if (view.id === undefined || handled.has(view.id) || !view.done_bucket_id) continue
		const source = cachedTaskBucketId(client, task.id, view.id)
		if (source === undefined) continue
		const target = task.done
			? view.done_bucket_id
			: source === view.done_bucket_id
				? getDefaultBucketId(view, cachedViewBuckets(client, task.project_id, view.id) ?? [])
				: undefined
		if (target === undefined || target === source) continue
		reconcileTaskBuckets(client, {
			project: task.project_id,
			view: view.id,
			bucket: target,
			task: task.id,
		})
	}
}

function cachedTaskBucketId(client: QueryClient, task: number, view: number): number | undefined {
	for (const [, detail] of client.getQueriesData<TaskResponse>({queryKey: taskKeys.details})) {
		if (detail?.id !== task) continue
		const bucket = detail.buckets?.find(item => item.project_view_id === view)
		if (bucket?.id !== undefined) return bucket.id
	}
	return undefined
}

function cachedViewBuckets(client: QueryClient, project: number, view: number) {
	const board = client.getQueriesData<BoardData>({queryKey: kanbanKeys.view(project, view)})
		.find(([, data]) => data)?.[1]
	return board?.buckets ?? client.getQueryData<Bucket[]>(bucketKeys.list(project, view))
}

function insertTaskIntoBoards(client: QueryClient, created: Task) {
	const task = normalizeTask(created)
	for (const [key, board] of client.getQueriesData<BoardData>({queryKey: kanbanKeys.all})) {
		const project = kanbanKeys.projectOf(key)
		const viewId = kanbanKeys.viewOf(key)
		if (!board || project === undefined || project !== task.project_id || viewId === undefined) continue
		const view = getCachedProject(project, client)?.views?.find(item => item.id === viewId)
		// The response only echoes the requested bucket, which belongs to the one view it was requested for.
		const target = board.buckets.some(bucket => bucket.id === task.bucket_id)
			? task.bucket_id
			: view && view.bucket_configuration_mode !== 'filter'
				? getDefaultBucketId(view, board.buckets)
				: undefined
		if (target === undefined) continue
		const position = task.positions?.find(item => item.project_view_id === viewId)?.position ?? task.position
		client.setQueryData(key, {
			...board,
			buckets: board.buckets.map(bucket => bucket.id === target
				? {...bucket, count: bucket.count + 1, tasks: [{...task, bucket_id: target, position}, ...bucket.tasks]}
				: bucket),
		})
	}
}

/** A task created elsewhere: shown on open boards like a local create, then reconciled with the server. */
export async function applyServerTaskCreated(client: QueryClient, created: Task) {
	await applyServerTaskChanges(client, [{kind: 'created', task: created}])
}

/**
 * A full task written elsewhere: every cached copy is patched and done buckets follow `done`, unless a
 * newer copy is already cached. Returns whether the task was applied.
 */
export async function applyServerTaskUpdated(client: QueryClient, updated: Task): Promise<boolean> {
	const [applied] = await applyServerTaskChanges(client, [{kind: 'updated', task: updated}])
	return applied ?? false
}

/** A task deleted elsewhere: cards go, and an open detail shows its deleted notice. */
export async function applyServerTaskDeleted(client: QueryClient, id: number) {
	await applyServerTaskChanges(client, [{kind: 'deleted', id}])
}

export function createTaskMutationOptions(owner?: ClientRequestContext) {
	return contextMutationOptions({
		mutationFn: async (
			task: Task & Required<Pick<Task, 'project_id'>>,
			{request},
		) => {
			const send = sdkClient.getConfig().fetch ?? globalThis.fetch
			return (await tasksCreate({
				path: {project: task.project_id},
				body: taskWriteBody(task),
				fetch: (input, init) => {
					// SDK preparation and interceptors yield before dispatch, after the mutation's owner check.
					assertClientRequestContext(request)
					return send(input, init)
				},
			})).data
		},
		onSuccess: (task, _input, client) => insertTaskIntoBoards(client, task),
		onSettled: (_task, client) => invalidateTaskMembership(client, undefined, 'active'),
	}, owner)
}

// When each save started, keyed by its input, so its answer can tell which server writes came later.
const saveMarks = new WeakMap<object, number>()

export function updateTaskMutationOptions(optimistic = false, owner?: ClientRequestContext) {
	return contextMutationOptions({
		mutationFn: async (task: Task & Required<Pick<Task, 'id'>>) => {
			saveMarks.set(task, serverWriteMark())
			return (await patchTasksRead({
				path: {task: task.id},
				body: taskPatchBody(task),
			})).data
		},
		optimistic: optimistic ? {
			queryKeys: ({id}, client) => taskQueryKeys(client, id),
			update: (task, client) => replaceTaskEverywhere(client, task),
		} : undefined,
		onSuccess: (task, input, client) => {
			// A receipt that arrived while this PATCH was in flight may already have written a newer version.
			if (isOvertakenByServerWrite(client, {...task, id: input.id}, saveMarks.get(input) ?? Infinity)) return
			replaceTaskEverywhere(client, task)
			reconcileDoneBuckets(client, normalizeTask({...task, id: input.id}))
		},
		onSettled: ({id}, client) => invalidateTaskMembership(client, id),
	}, owner)
}

export function deleteTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => { await tasksDelete({path: {task: id}}) },
		onSuccess: (_data, id, client) => removeTaskEverywhere(client, id),
		onSettled: (_id, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function bulkCreateTasksMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: Task[]) => {
			const context = captureClientRequestContext()
			const tasks: (Task | null)[] = Array(input.length).fill(null)
			let error: unknown = null
			const groups = new Map<number, {task: Task, index: number}[]>()
			input.forEach((task, index) => {
				const project = task.project_id ?? 0
				groups.set(project, [...(groups.get(project) ?? []), {task, index}])
			})
			for (const [project, entries] of groups) {
				const batches = []
				for (let index = 0; index < entries.length; index += 100) batches.push(entries.slice(index, index + 100))
				// The API inserts batches at the top, so submit the last batch first.
				for (const batch of batches.reverse()) {
					assertClientRequestContext(context)
					try {
						const {data} = await tasksBulkCreate({
							path: {project},
							body: {tasks: batch.map(({task}) => taskWriteBody(task))},
						})
						if (data.tasks?.length !== batch.length) throw translatedError('task.bulkCreateUnexpectedResponse')
						data.tasks!.forEach((task, index) => { tasks[batch[index].index] = task })
					} catch (cause) {
						error ??= cause
						break
					}
				}
			}
			return {tasks, error}
		},
		// The backend keeps the input order top to bottom, so insert back to front.
		onSuccess: ({tasks}, _input, client) => [...tasks].reverse().forEach(task => {
			if (task) insertTaskIntoBoards(client, task)
		}),
		onSettled: (_input, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function duplicateTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => (await tasksDuplicate({path: {task: id}})).data.duplicated_task!,
		onSuccess: (task, _id, client) => insertTaskIntoBoards(client, task),
		onSettled: (_id, client) => invalidateTaskMembership(client, undefined, 'active'),
	})
}

export function favoriteTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (task: Task & Required<Pick<Task, 'id'>>) => (await patchTasksRead({
			path: {task: task.id},
			body: taskPatchBody({is_favorite: !task.is_favorite}),
		})).data,
		optimistic: {
			queryKeys: ({id}, client) => taskQueryKeys(client, id),
			update: (task, client) => mapTaskEverywhere(client, task.id, current => ({
				...current,
				is_favorite: !task.is_favorite,
			})),
		},
		onSuccess: (task, _input, client) => replaceTaskEverywhere(client, task),
		onSettled: async ({id}, client) => {
			await invalidateTaskMembership(client, id)
			await client.invalidateQueries({queryKey: projectKeys.list()})
		},
	})
}

export function markTaskReadMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (id: number) => { await tasksMarkRead({path: {task: id}}) },
		onSuccess: (_data, id, client) => mapTaskEverywhere(client, id, task => ({...task, is_unread: false})),
		onSettled: (id, client) => invalidateTaskMembership(client, id),
	})
}

type AssigneeInput = {taskId: number, user: User & Required<Pick<User, 'id'>>}
export function addTaskAssigneeMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, user}: AssigneeInput) =>
			(await taskAssigneesCreate({path: {task: taskId}, body: {user_id: user.id}})).data,
		onSuccess: (_data, {taskId, user}, client) => mapTaskEverywhere(client, taskId, task => ({
			...task,
			assignees: [...task.assignees.filter(item => item.id !== user.id), user],
		})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}
export function removeTaskAssigneeMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, user}: AssigneeInput) => {
			await taskAssigneesDelete({path: {task: taskId, user: user.id}})
		},
		onSuccess: (_data, {taskId, user}, client) => mapTaskEverywhere(client, taskId, task => ({
			...task,
			assignees: task.assignees.filter(item => item.id !== user.id),
		})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

type LabelInput = {taskId: number, label: Label & Required<Pick<Label, 'id'>>}
export function addTaskLabelMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, label}: LabelInput) =>
			(await taskLabelsCreate({path: {task: taskId}, body: {label_id: label.id}})).data,
		onSuccess: (_data, {taskId, label}, client) => mapTaskEverywhere(client, taskId, task => ({
			...task,
			labels: [...task.labels.filter(item => item.id !== label.id), label],
		})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}
export function removeTaskLabelMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, label}: LabelInput) => {
			await taskLabelsDelete({path: {task: taskId, label: label.id}})
		},
		onSuccess: (_data, {taskId, label}, client) => mapTaskEverywhere(client, taskId, task => ({
			...task,
			labels: task.labels.filter(item => item.id !== label.id),
		})),
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

async function refreshTaskRelations(client: QueryClient, ids: number[]) {
	const context = captureClientRequestContext()
	const results = await Promise.allSettled([...new Set(ids)].map(task => tasksRead({path: {task}})))
	assertClientRequestContext(context)
	for (const result of results) {
		if (result.status !== 'fulfilled' || result.value.data.id === undefined) continue
		const task = result.value.data
		// Patch relation metadata only. Preserve already loaded board pages and concurrent task edits.
		mapTaskEverywhere(client, task.id!, current => normalizeTask({...current, related_tasks: task.related_tasks}))
	}
}

export function createTaskRelationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: TaskRelationWritable & {taskId: number}) =>
			(await tasksRelationsCreate({path: {task: taskId}, body})).data,
		onSettled: async ({taskId, other_task_id}, client) => {
			await refreshTaskRelations(client, [taskId, ...(other_task_id ? [other_task_id] : [])])
			await invalidateTaskMembership(client, taskId, 'active')
			if (other_task_id) await invalidateTaskMembership(client, other_task_id, 'active')
		},
	})
}
export function deleteTaskRelationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (path: TasksRelationsDeleteData['path']) => {
			await tasksRelationsDelete({path})
		},
		onSettled: async ({task, otherTask}, client) => {
			await refreshTaskRelations(client, [task, otherTask])
			await invalidateTaskMembership(client, task, 'active')
			await invalidateTaskMembership(client, otherTask, 'active')
		},
	})
}

export function updateTaskPositionMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: TaskPositionWritable & {taskId: number}) =>
			(await tasksPositionUpdate({path: {task: taskId}, body})).data,
		onSuccess: (data, {taskId, project_view_id}, client) => {
			if (project_view_id === undefined || data.position === undefined) return
			patchTaskViewPositions(client, project_view_id, [{
				task_id: taskId,
				project_view_id,
				position: data.position,
			}])
		},
		onSettled: ({taskId}, client) => invalidateTaskMembership(client, taskId),
	})
}

// The detail's buckets array is the only source of the bucket label and nothing refetches it.
function reconcileTaskBuckets(
	client: QueryClient,
	{project, view, bucket, task}: {project: number, view: number, bucket: number, task: number},
) {
	const target = cachedViewBuckets(client, project, view)?.find(item => item.id === bucket)
	if (!target) {
		void client.invalidateQueries({queryKey: [...taskKeys.details, task], refetchType: 'active'})
		return
	}
	const {tasks: _tasks, ...entry} = target
	mapTaskEverywhere(client, task, current => current.buckets
		? {
			...current,
			buckets: current.buckets.map(item => item.project_view_id === view
				? {...entry, project_view_id: view}
				: item),
		}
		: current)
}

export function moveTaskMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({project, view, bucket, task}: {
			project: number,
			view: number,
			bucket: number,
			task: Task,
		}) => (await taskBucketUpdate({path: {project, view, bucket}, body: {task_id: task.id}})).data,
		optimistic: {
			queryKeys: ({project, view}) => [kanbanKeys.view(project, view)],
			update: ({project, view, bucket, task}, client) => client.setQueriesData<BoardData>(
				{queryKey: kanbanKeys.view(project, view)},
				current => current ? {
					...current,
					buckets: moveTaskToBucket(current.buckets, task, bucket).map(normalizeBucket),
				} : current,
			),
		},
		onSuccess: (data, {project, view, bucket, task}, client) => {
			const target = data.bucket_id ?? bucket
			if (data.task) replaceTaskEverywhere(client, data.task)
			client.setQueriesData<BoardData>(
				{queryKey: kanbanKeys.view(project, view)},
				current => current ? {
					...current,
					buckets: moveTaskToBucket(current.buckets, data.task ?? task, target).map(normalizeBucket),
				} : current,
			)
			const id = data.task?.id ?? task.id
			if (id !== undefined) reconcileTaskBuckets(client, {project, view, bucket: target, task: id})
		},
		onSettled: ({task}, client) => invalidateTaskMembership(client, task.id),
	})
}

export function useCreateTaskMutation(owner?: ClientRequestContext) {
	return useMutation(createTaskMutationOptions(owner))
}

export function useUpdateTaskMutation(optimistic = false, owner?: ClientRequestContext) {
	return useMutation(updateTaskMutationOptions(optimistic, owner))
}

export function useDeleteTaskMutation() {
	return useMutation(deleteTaskMutationOptions())
}

export function useBulkCreateTasksMutation() {
	return useMutation(bulkCreateTasksMutationOptions())
}

export function useDuplicateTaskMutation() {
	return useMutation(duplicateTaskMutationOptions())
}

export function useFavoriteTaskMutation() {
	return useMutation(favoriteTaskMutationOptions())
}

export function useMarkTaskReadMutation() {
	return useMutation(markTaskReadMutationOptions())
}

export function useAddTaskAssigneeMutation() {
	return useMutation(addTaskAssigneeMutationOptions())
}

export function useRemoveTaskAssigneeMutation() {
	return useMutation(removeTaskAssigneeMutationOptions())
}

export function useAddTaskLabelMutation() {
	return useMutation(addTaskLabelMutationOptions())
}

export function useRemoveTaskLabelMutation() {
	return useMutation(removeTaskLabelMutationOptions())
}

export function useCreateTaskRelationMutation() {
	return useMutation(createTaskRelationMutationOptions())
}

export function useDeleteTaskRelationMutation() {
	return useMutation(deleteTaskRelationMutationOptions())
}

export function useUpdateTaskPositionMutation() {
	return useMutation(updateTaskPositionMutationOptions())
}

export function useMoveTaskMutation() {
	return useMutation(moveTaskMutationOptions())
}

export type ServerTaskChange =
	| {kind: 'created', task: Task}
	| {kind: 'updated', task: Task}
	| {kind: 'deleted', id: number}

type ServerChangeScope = {projects: Set<number>, boards: QueryKey[]}

function changedTaskId(change: ServerTaskChange): number | undefined {
	return change.kind === 'deleted' ? change.id : change.task.id
}

// A search or filter on the board, or on its view, may stop or start matching after any field changes.
function boardFiltersTasks(client: QueryClient, key: QueryKey): boolean {
	const params = key[3] as TaskFilterParams | undefined
	if (params?.filter || params?.q) return true
	const project = kanbanKeys.projectOf(key)
	const view = project === undefined ? undefined : getCachedProject(project, client)?.views?.find(item => item.id === kanbanKeys.viewOf(key))
	return Boolean(view?.filter?.filter || view?.filter?.s) || view?.bucket_configuration_mode === 'filter'
}

// The echoed bucket belongs to one view; bucket ids are unique, so only that view's board can match it.
function movesToAnotherBucket(client: QueryClient, key: QueryKey, task: Task): boolean {
	const board = client.getQueryData<BoardData>(key)
	if (!task.bucket_id || !board?.buckets.some(bucket => bucket.id === task.bucket_id)) return false
	const view = getCachedProject(kanbanKeys.projectOf(key)!, client)?.views?.find(item => item.id === kanbanKeys.viewOf(key))
	// Completion moves the card into the done bucket locally.
	if (task.done && task.bucket_id === view?.done_bucket_id) return false
	return board.buckets.some(bucket => bucket.id !== task.bucket_id && bucket.tasks.some(item => item.id === task.id))
}

/**
 * Which projects and open boards a batch touches. Read before patching: afterwards a moved or deleted
 * task no longer shows where it was. Creates and deletes change bucket counts and pages, so their
 * boards reconcile; an update only does when it leaves or enters a project, meets a filter (a saved
 * filter, a filtered view or filter buckets) or moves to another bucket. Everything else is patched.
 */
function serverChangeScope(client: QueryClient, changes: readonly ServerTaskChange[]): ServerChangeScope {
	const projects = new Set<number>()
	const boards = new Map<string, QueryKey>()
	for (const change of changes) {
		const id = changedTaskId(change)
		if (id === undefined) continue
		const before = new Set(cachedTaskCopies(client, id).map(copy => copy.project_id ?? 0).filter(project => project > 0))
		const after = change.kind === 'deleted' ? undefined : change.task.project_id
		const touched = [...before, ...(after ? [after] : [])]
		touched.forEach(project => projects.add(project))
		if (change.kind === 'updated' && isStaleTask(client, change.task)) continue
		const moved = change.kind === 'updated' && [...before].some(project => project !== after)
		for (const key of agentBoardKeys(client, {projectIds: touched, taskIds: [id]})) {
			const project = kanbanKeys.projectOf(key)!
			const reconcile = change.kind !== 'updated'
				|| moved
				|| project < 0
				|| project !== after
				|| boardFiltersTasks(client, key)
				|| movesToAnotherBucket(client, key, change.task)
			if (reconcile) boards.set(hashKey(key), key)
		}
	}
	return {projects, boards: [...boards.values()]}
}

// Writes made outside this tab (Arona tool receipts) reuse the reconciliation of the local mutations.
// Open lists refetch when a filter may now include or exclude the task: global and pseudo-project lists
// always, project lists only for the projects the batch touched. Affected boards reload every loaded
// page through their filters; others keep the patch. The timeline refetches only while mounted.
async function refreshServerTaskMembership(client: QueryClient, scope: ServerChangeScope) {
	const affects = (project: number | null | undefined) => !project || project < 0 || scope.projects.has(project)
	await Promise.all([
		invalidateCalendarTasks(client),
		client.invalidateQueries({
			queryKey: taskKeys.lists,
			refetchType: 'active',
			predicate: query => affects(taskKeys.projectOf(query.queryKey)),
		}),
		client.invalidateQueries({
			queryKey: taskKeys.allLists,
			refetchType: 'active',
			predicate: query => affects(taskKeys.projectOf(query.queryKey)),
		}),
		// A closed board reloads when it opens again; open ones are reconciled below or already patched.
		client.invalidateQueries({
			queryKey: kanbanKeys.all,
			refetchType: 'none',
			predicate: query => !query.isActive() && affects(kanbanKeys.projectOf(query.queryKey)),
		}),
		client.invalidateQueries({
			queryKey: projectTimelineKeys.all,
			predicate: query => affects((query.queryKey[1] as ProjectTimelineQuery | undefined)?.project),
		}),
		reconcileServerBoards(client, scope.boards),
	])
}

// The write itself succeeded; only the board view of it may lag. A failed board keeps the patched
// cards on screen and is marked stale, so its next mount reloads it instead of trusting the patch.
export async function reconcileServerBoards(client: QueryClient, keys: readonly QueryKey[]) {
	const failed: QueryKey[] = []
	await Promise.all(keys.map(key => refreshAgentBoards(client, [key]).catch(cause => {
		// Another account or API: the cache is being replaced anyway.
		if (!isRequestContextAbort(cause)) failed.push(key)
	})))
	if (!failed.length) return
	await Promise.all(failed.map(key => client.invalidateQueries({queryKey: key, exact: true, refetchType: 'none'})))
	error(translatedError('project.kanban.refreshFailed'))
}

/**
 * Changes made elsewhere (one batch of Arona receipts), applied in order like local creates, updates and
 * deletes. The batch refreshes once: one refresh per change would cancel and restart the same list and
 * board requests for every task of a bulk update. Returns whether each change was applied.
 */
export async function applyServerTaskChanges(client: QueryClient, changes: readonly ServerTaskChange[]): Promise<boolean[]> {
	if (!changes.length) return []
	const scope = serverChangeScope(client, changes)
	const applied = changes.map(change => {
		if (change.kind === 'deleted') {
			removeTaskEverywhere(client, change.id)
			return true
		}
		if (change.task.id === undefined) return false
		if (change.kind === 'created') {
			// The same receipt can arrive twice (conversation refetch, panel hand-over): never add a second card.
			if (!taskQueryKeys(client, change.task.id).length) insertTaskIntoBoards(client, change.task)
			return true
		}
		if (isStaleTask(client, change.task)) return false
		recordServerTaskWrite(client, change.task)
		replaceTaskEverywhere(client, change.task)
		reconcileDoneBuckets(client, normalizeTask(change.task))
		return true
	})
	await refreshServerTaskMembership(client, scope)
	return applied
}
