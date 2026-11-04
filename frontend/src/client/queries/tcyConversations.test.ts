import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver, type QueryKey} from '@tanstack/vue-query'
import type {Action, ChatTurn, Conversation, Label, Task} from '@/client/generated'
import {removeToken} from '@/helpers/auth'
import {
	agentReceipt,
	agentRefreshMutationOptions,
	agentRunScope,
	planAgentRefresh,
	takeAgentReceipts,
	trackNewConversation,
	type AgentReceipt,
} from './tcyConversations'
import {normalizeTask, taskKeys, taskQuery, type PaginatedTaskResponse, type TaskResponse} from './tasks'
import {bucketKeys, kanbanKeys, normalizeBucket, type BoardData} from './kanban'
import {labelKeys} from './labels'
import {commentKeys} from './comments'
import {normalizeProject, projectKeys, type ProjectListResult, type ProjectResponse} from './projects'
import {projectTimelineKeys} from './projectTimeline'
import {mapTaskEverywhere, TaskDeletedError} from './taskCache'
import {projectAnnouncementKeys} from './projectAnnouncements'
import {refreshTaskRoutinesMutationOptions, taskRoutineKeys} from './taskRoutines'

const sdk = vi.hoisted(() => ({
	tasksRead: vi.fn(),
	taskRoutineRead: vi.fn(),
	// Board reconciliation: the first page of every bucket, then each further loaded page.
	projectViewBucketsTasksList: vi.fn(),
	projectViewTasksList: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))

function action(tool: string, args: object, result: unknown, success = true): Action {
	return {
		tool,
		arguments: JSON.stringify(args),
		result: typeof result === 'string' ? result : JSON.stringify(result),
		success,
	}
}

function conversation(id: string, turns: {id: string, actions: Action[]}[]): Conversation {
	return {
		id,
		turns: turns.map((turn): ChatTurn => ({
			id: turn.id,
			status: 'completed',
			result: {actions: turn.actions},
		})),
	}
}

function receipt(tool: string, args: object, result: unknown): AgentReceipt {
	return agentReceipt(`turn:${tool}`, action(tool, args, result))!
}

const serverTask = {
	id: 3,
	project_id: 1,
	title: 'Renamed by Arona',
	done: false,
	labels: null,
	assignees: null,
}

describe('agent receipts', () => {
	it('records an opened chat without replaying it and applies each later receipt once', () => {
		const client = new QueryClient()
		const old = conversation('old', [{id: 't1', actions: [action('update_task', {id: 3, title: 'x'}, serverTask)]}])
		expect(takeAgentReceipts(client, old)).toEqual([])
		expect(takeAgentReceipts(client, old)).toEqual([])

		const live = conversation('old', [{
			id: 't1',
			actions: [
				action('update_task', {id: 3, title: 'x'}, serverTask),
				action('list_project_timeline', {year: 2026}, {items: []}),
				action('update_task', {id: 4, title: 'y'}, {success: false}, false),
				action('add_task_label', {id: 3, label_id: 9}, {label_id: 9}),
			],
		}])
		expect(takeAgentReceipts(client, live).map(item => [item.key, item.tool])).toEqual([['t1:3', 'add_task_label']])
		expect(takeAgentReceipts(client, live)).toEqual([])
	})

	it('switching back to an earlier chat replays nothing', () => {
		const client = new QueryClient()
		const first = conversation('a', [{id: 't1', actions: [action('delete_task', {id: 1}, {success: true})]}])
		const second = conversation('b', [{id: 't2', actions: [action('create_task', {project_id: 1, title: 'n'}, {id: 5})]}])
		takeAgentReceipts(client, first)
		takeAgentReceipts(client, second)
		expect(takeAgentReceipts(client, first)).toEqual([])
		expect(takeAgentReceipts(client, second)).toEqual([])
	})

	it('applies the first receipts of a chat created in this tab', () => {
		const client = new QueryClient()
		trackNewConversation(client, 'fresh')
		const fresh = conversation('fresh', [{id: 't1', actions: [action('create_task', {project_id: 1, title: 'n'}, {id: 5})]}])
		expect(takeAgentReceipts(client, fresh).map(item => item.tool)).toEqual(['create_task'])
	})

	it('keeps ledgers per query client', () => {
		const chat = conversation('shared', [{id: 't1', actions: []}])
		const first = new QueryClient()
		const second = new QueryClient()
		takeAgentReceipts(first, chat)
		const next = conversation('shared', [{id: 't1', actions: [action('delete_task', {id: 1}, {success: true})]}])
		expect(takeAgentReceipts(second, next)).toEqual([])
		expect(takeAgentReceipts(first, next)).toHaveLength(1)
	})

	it('starts a fresh ledger for the next account on the same query client', () => {
		const client = new QueryClient()
		const created = conversation('created', [{id: 't1', actions: [action('delete_task', {id: 1}, {success: true})]}])
		const observed = conversation('observed', [{id: 't1', actions: [action('delete_task', {id: 2}, {success: true})]}])
		trackNewConversation(client, 'created')
		takeAgentReceipts(client, observed)
		agentRunScope(client).live.value = ['observed']

		// Logging out keeps the query client alive.
		removeToken()

		expect(agentRunScope(client).live.value).toEqual([])
		// Not inherited: the previous account's fresh chat replays nothing for the next one.
		expect(takeAgentReceipts(client, created)).toEqual([])
		// Not suppressed: what the previous account recorded does not hide a new chat's receipts.
		trackNewConversation(client, 'observed')
		expect(takeAgentReceipts(client, observed).map(item => item.key)).toEqual(['t1:0'])
	})

	it('applies a running chat\'s new action once across conversation refetches', () => {
		const client = new QueryClient()
		trackNewConversation(client, 'live')
		const first = conversation('live', [{id: 't1', actions: [action('create_task', {project_id: 1}, {id: 5, project_id: 1})]}])
		// A refetch returns a new object with the same turn and one more action.
		const refetched = conversation('live', [{
			id: 't1',
			actions: [
				action('create_task', {project_id: 1}, {id: 5, project_id: 1}),
				action('update_task', {id: 5, done: true}, {id: 5, project_id: 1, done: true}),
			],
		}])
		expect(takeAgentReceipts(client, first).map(item => item.key)).toEqual(['t1:0'])
		expect(takeAgentReceipts(client, structuredClone(first))).toEqual([])
		expect(takeAgentReceipts(client, refetched).map(item => item.key)).toEqual(['t1:1'])
		expect(takeAgentReceipts(client, refetched)).toEqual([])
	})
})

describe('receipt refresh plan', () => {
	it('turns returned tasks into server task changes and touches history only for projects', () => {
		const title = planAgentRefresh([receipt('update_task', {id: 3, title: 'x'}, serverTask)])
		expect(title.operations).toEqual([{kind: 'task', task: serverTask}])
		expect(title.taskLists).toBe(false)
		expect(title.timeline).toBe(false)
		expect(title.history).toBe(false)
		expect(planAgentRefresh([receipt('update_task', {id: 3, due_date: '2026-11-02T00:00:00Z'}, serverTask)]).timeline)
			.toBe(true)
	})

	it('maps create, update, bulk update and delete receipts to their task changes', () => {
		const created = {id: 5, project_id: 1, title: 'n'}
		const second = {...serverTask, id: 4}
		const plan = planAgentRefresh([
			receipt('create_task', {project_id: 1, title: 'n'}, created),
			receipt('update_task', {id: 3, done: true}, serverTask),
			receipt('bulk_update_tasks', {updates: [{id: 3, changes: {priority: 2}}, {id: 4, changes: {priority: 2}}]}, [serverTask, second]),
			receipt('delete_task', {id: 6}, {success: true, deleted: true}),
		])
		expect(plan.operations).toEqual([
			{kind: 'createdTask', task: created},
			{kind: 'task', task: serverTask},
			{kind: 'task', task: serverTask},
			{kind: 'task', task: second},
			{kind: 'removeTask', id: 6},
		])
		expect(plan.taskLists).toBe(false)
		expect(plan.timeline).toBe(true)
	})

	it('falls back to the named task and open lists when the receipt holds no task', () => {
		const plan = planAgentRefresh([receipt('update_task', {id: 1}, {})])
		expect(plan.operations).toEqual([])
		expect(plan.refetchTasks).toEqual([1])
		expect(plan.taskLists).toBe('active')
		expect(planAgentRefresh([receipt('create_task', {project_id: 1}, {success: true})]).taskLists).toBe('active')
	})

	it('reconciles a comment count with the server instead of adding one locally', () => {
		const plan = planAgentRefresh([receipt('add_comment', {id: 3, comment: 'Done'}, {id: 40, comment: 'Done'})])
		expect(plan.operations).toEqual([])
		expect(plan.comments).toEqual([3])
	})

	it('updates project history and timeline only for visible project changes', () => {
		const project = {id: 7, title: 'Thesis', is_completed: true}
		const completed = planAgentRefresh([receipt('set_project_completed', {id: 7, completed: true}, project)])
		expect(completed.operations).toEqual([{kind: 'project', project}])
		expect(completed).toMatchObject({history: true, timeline: true, projectList: true, taskLists: false})
		const described = planAgentRefresh([receipt('update_project', {id: 7, description: 'd'}, project)])
		expect(described).toMatchObject({history: false, timeline: false, projectList: true})
	})

	it('applies a returned routine task like a task change and refreshes only its routine data', () => {
		const routineTask = {...serverTask, routine: {enabled: true, completed_today: true, date: '2026-11-01'}}
		const checkedIn = planAgentRefresh([receipt('check_in_task_routine', {id: 3, date: '2026-11-01', completed: true}, routineTask)])
		expect(checkedIn.operations).toEqual([{kind: 'task', task: routineTask}])
		expect(checkedIn).toMatchObject({routines: [3], refetchTasks: [], taskLists: false, projectList: false, timeline: false})
		const unknownResult = planAgentRefresh([receipt('configure_task_routine', {id: 5, enabled: true, paused: true, timezone: 'Asia/Shanghai', revision: 2}, {success: true})])
		expect(unknownResult).toMatchObject({operations: [], refetchTasks: [5], routines: [5], taskLists: false})
	})

	it('refreshes only the announcement of the project it changed', () => {
		const plan = planAgentRefresh([
			receipt('update_project_announcement', {id: 7, title: 'Hi', content: '<p>x</p>', revision: 1}, {project_id: 7, revision: 2}),
			receipt('update_project_announcement', {title: '', content: '', revision: 2}, {project_id: 8, revision: 3}),
		])
		expect(plan).toMatchObject({
			announcements: [7, 8],
			operations: [],
			refetchProjects: [],
			projectList: false,
			history: false,
			timeline: false,
			taskLists: false,
		})
	})

	it('narrows unknown writes to the named records', () => {
		const plan = planAgentRefresh([receipt('archive_everything', {id: 4, project_id: 2}, {success: true})])
		expect(plan).toMatchObject({
			refetchTasks: [4],
			refetchProjects: [2],
			taskLists: 'none',
		})
	})

	it('keeps a saved filter board\'s negative project id and refetches the moved task', () => {
		const plan = planAgentRefresh([receipt('move_task_to_bucket', {
			project_id: -2,
			view_id: 9,
			bucket_id: 31,
			task_id: 3,
		}, {
			task: {id: 3, title: 'Card', done: true, project_id: 1},
			bucket: {id: 31, title: 'Done'},
			previous_bucket_id: 30,
			effects: ['marks_task_done'],
		})])
		expect(plan).toMatchObject({
			boards: [{project: -2, view: 9}],
			refetchTasks: [3],
			movedTasks: [3],
			refetchProjects: [],
			// Done state changed, so open lists follow the server.
			taskLists: 'active',
			timeline: true,
			projectList: false,
		})
	})

	it('patches a view\'s default and done bucket from what the server stored', () => {
		const plan = planAgentRefresh([
			receipt('set_view_buckets', {project_id: 1, view_id: 4, done_bucket_id: 9}, {
				view: {id: 4, title: 'Kanban', default_bucket_id: 8, done_bucket_id: 9},
			}),
			receipt('delete_bucket', {project_id: -2, view_id: 6, bucket_id: 12}, {
				deleted_bucket_id: 12,
				tasks_moved: 3,
				tasks_deleted: 0,
				view: {default_bucket_id: 0, done_bucket_id: 0},
			}),
			receipt('update_bucket', {project_id: 1, view_id: 4, bucket_id: 8, title: 'Next'}, {
				bucket: {id: 8, title: 'Next', limit: 0, order: 1},
			}),
		])
		expect(plan.operations).toEqual([
			{kind: 'viewBuckets', project: 1, view: 4, defaultBucket: 8, doneBucket: 9},
			{kind: 'viewBuckets', project: -2, view: 6, defaultBucket: 0, doneBucket: 0},
		])
		expect(plan).toMatchObject({
			boards: [{project: 1, view: 4}, {project: -2, view: 6}],
			buckets: [12, 8],
			movedTasks: [],
			refetchTasks: [],
			refetchProjects: [],
			// Deleting moves tasks without changing their done state: lists only go stale.
			taskLists: 'none',
			projectList: true,
			history: false,
			timeline: false,
		})
	})

	it('ignores read-only and failed tools', () => {
		expect(agentReceipt('k', action('list_project_timeline', {year: 2026}, {}))).toBeUndefined()
		expect(agentReceipt('k', action('web_search', {query: 'q'}, {}))).toBeUndefined()
		expect(agentReceipt('k', action('update_task', {id: 1}, {}, false))).toBeUndefined()
	})
})

describe('receipt refresh cache writes', () => {
	let client: QueryClient
	const listKey = taskKeys.list({project: 1})
	const boardKey = kanbanKeys.board(1, 4)
	const listFetch = vi.fn()
	const boardFetch = vi.fn()
	const task = normalizeTask({id: 3, project_id: 1, title: 'Before', bucket_id: 8, position: 250})

	function observe(queryKey: QueryKey, queryFn: () => unknown) {
		return new QueryObserver(client, {queryKey, queryFn, staleTime: Infinity}).subscribe(() => {})
	}

	async function apply(receipts: AgentReceipt[]) {
		await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipts))
	}

	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		listFetch.mockResolvedValue({items: [task], total: 1, page: 1, per_page: 50, total_pages: 1})
		boardFetch.mockResolvedValue({buckets: [], pages: {}})
		client.setQueryData<PaginatedTaskResponse>(listKey, {items: [task], total: 1, page: 1, per_page: 50, total_pages: 1})
		client.setQueryData<BoardData>(boardKey, {buckets: [normalizeBucket({id: 8, count: 30, tasks: [task]})], pages: {8: 2}})
		client.setQueryData<Label[]>(labelKeys.all, [{id: 9, title: 'Urgent'}])
		client.setQueryData(projectTimelineKeys.query({year: 2026}), {items: []})
		client.setQueryData(['project-history', {year: 2026}], {items: []})
		observe(listKey, listFetch)
		observe(boardKey, boardFetch)
	})

	// The open list refetches after a task change; the mocked server answers with its state after the receipt.
	function serverList(tasks: TaskResponse[]) {
		const patchedBeforeRefetch: string[] = []
		listFetch.mockImplementation(async () => {
			patchedBeforeRefetch.push(client.getQueryData<PaginatedTaskResponse>(listKey)!.items.map(item => item.title).join())
			return {items: tasks, total: tasks.length, page: 1, per_page: 50, total_pages: 1}
		})
		return patchedBeforeRefetch
	}

	it('patches the task in lists and boards, refetches the open list once and never the board', async () => {
		const seen = serverList([normalizeTask({...task, title: 'Renamed by Arona'})])
		await apply([receipt('update_task', {id: 3, title: 'x'}, serverTask)])
		expect(seen).toEqual(['Renamed by Arona'])
		const listed = client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0]
		const card = client.getQueryData<BoardData>(boardKey)!.buckets[0]
		expect(listed.title).toBe('Renamed by Arona')
		expect(card.tasks[0]).toMatchObject({title: 'Renamed by Arona', bucket_id: 8, position: 250})
		expect(client.getQueryData<BoardData>(boardKey)!.pages).toEqual({8: 2})
		// The open list follows the server: the task may no longer match its filter.
		expect(listFetch).toHaveBeenCalledTimes(1)
		// A rename cannot change membership of an unfiltered board: the patch is the whole update.
		expect(boardFetch).not.toHaveBeenCalled()
		expect(sdk.projectViewBucketsTasksList).not.toHaveBeenCalled()
		expect(client.getQueryState(boardKey)?.isInvalidated).toBe(false)
		expect(sdk.tasksRead).not.toHaveBeenCalled()
		expect(client.getQueryState(labelKeys.all)?.isInvalidated).toBe(false)
		expect(client.getQueryState(['project-history', {year: 2026}])?.isInvalidated).toBe(false)
	})

	it('refetches open lists once for a whole bulk update', async () => {
		serverList([normalizeTask({...task, priority: 2})])
		await apply([receipt('bulk_update_tasks', {updates: [{id: 3, changes: {priority: 2}}]}, [
			{...serverTask, priority: 2},
			{...serverTask, id: 4, priority: 2},
		])])
		expect(client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0].priority).toBe(2)
		expect(listFetch).toHaveBeenCalledTimes(1)
		expect(boardFetch).not.toHaveBeenCalled()
		expect(sdk.projectViewBucketsTasksList).not.toHaveBeenCalled()
	})

	it('ignores a late receipt when a newer copy of the task is cached', async () => {
		client.setQueryData(taskKeys.detail(3), {...task, title: 'Edited later', updated: '2026-10-31T12:00:00Z'})
		await apply([receipt('update_task', {id: 3, title: 'x'}, {...serverTask, updated: '2026-10-31T11:00:00Z'})])
		expect(client.getQueryData<TaskResponse>(taskKeys.detail(3))?.title).toBe('Edited later')
		expect(client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0].title).toBe('Before')
	})

	it('marks the timeline stale when a schedule changes', async () => {
		await apply([receipt('update_task', {id: 3, end_date: '2026-11-04T00:00:00Z'}, serverTask)])
		expect(client.getQueryState(projectTimelineKeys.query({year: 2026}))?.isInvalidated).toBe(true)
		expect(client.getQueryState(['project-history', {year: 2026}])?.isInvalidated).toBe(false)
	})

	// The server's board after the receipt: 31 cards in bucket 8, the second page holding the oldest.
	function serverBoard(firstPage: TaskResponse[], count: number, secondPage: TaskResponse[] = []) {
		sdk.projectViewBucketsTasksList.mockResolvedValue({data: {items: [{id: 8, count, tasks: firstPage}]}})
		sdk.projectViewTasksList.mockResolvedValue({data: {items: secondPage}})
	}

	it('puts a created task on the open board once and reconciles its loaded pages once', async () => {
		client.setQueryData(projectKeys.detail(1), {
			id: 1,
			title: 'Website',
			views: [{id: 4, project_id: 1, view_kind: 'kanban', default_bucket_id: 8}],
		})
		const older = normalizeTask({id: 2, project_id: 1, title: 'Oldest', bucket_id: 8})
		serverBoard([normalizeTask({id: 5, project_id: 1, title: 'New', bucket_id: 8}), task], 31, [older])
		const created = receipt('create_task', {project_id: 1, title: 'New'}, {id: 5, project_id: 1, title: 'New'})
		await apply([created])
		// One request per loaded page: the bucket list, then page 2 of the bucket that had two loaded.
		expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1)
		expect(sdk.projectViewBucketsTasksList.mock.calls[0][0]).toMatchObject({path: {project: 1, view: 4}})
		expect(sdk.projectViewTasksList).toHaveBeenCalledTimes(1)
		expect(sdk.projectViewTasksList.mock.calls[0][0].query).toMatchObject({page: 2, filter: 'bucket_id = 8'})
		// The same receipt again (another window, a replayed plan) adds no second card.
		await apply([created])
		const bucket = client.getQueryData<BoardData>(boardKey)!.buckets[0]
		expect(bucket.tasks.map(item => item.id)).toEqual([5, 3, 2])
		expect(bucket.count).toBe(31)
		expect(client.getQueryData<BoardData>(boardKey)!.pages).toEqual({8: 2})
		// Never the generic first-page refetch, which would drop the second page.
		expect(boardFetch).not.toHaveBeenCalled()
	})

	it('moves a task completed by Arona into the done bucket', async () => {
		client.setQueryData(projectKeys.detail(1), {
			id: 1,
			title: 'Website',
			views: [{id: 4, project_id: 1, view_kind: 'kanban', default_bucket_id: 8, done_bucket_id: 9}],
		})
		client.setQueryData<BoardData>(boardKey, {
			buckets: [
				normalizeBucket({id: 8, count: 30, tasks: [task]}),
				normalizeBucket({id: 9, count: 2, tasks: []}),
			],
			pages: {8: 2, 9: 1},
		})
		await apply([receipt('update_task', {id: 3, done: true}, {...serverTask, done: true})])
		const buckets = client.getQueryData<BoardData>(boardKey)!.buckets
		expect(buckets[0].tasks).toEqual([])
		expect(buckets[1].tasks.map(item => [item.id, item.done])).toEqual([[3, true]])
		expect(buckets.map(item => item.count)).toEqual([29, 3])
		expect(client.getQueryData<BoardData>(boardKey)!.pages).toEqual({8: 2, 9: 1})
		// The done bucket move is local; an unfiltered board needs no request for it.
		expect(boardFetch).not.toHaveBeenCalled()
		expect(sdk.projectViewBucketsTasksList).not.toHaveBeenCalled()
	})

	it('refetches mounted lists for a created task and reconciles the board, never its first page alone', async () => {
		serverBoard([task], 31)
		await apply([receipt('create_task', {project_id: 1, title: 'New'}, {id: 5, project_id: 1, title: 'New'})])
		expect(listFetch).toHaveBeenCalledTimes(1)
		expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1)
		expect(boardFetch).not.toHaveBeenCalled()
	})

	it('adds a cached label without a request and fetches the task for an unknown one', async () => {
		await apply([receipt('add_task_label', {id: 3, label_id: 9}, {label_id: 9})])
		expect(client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0].labels).toEqual([{id: 9, title: 'Urgent'}])
		expect(sdk.tasksRead).not.toHaveBeenCalled()

		sdk.tasksRead.mockResolvedValue({data: {...serverTask, labels: [{id: 9, title: 'Urgent'}, {id: 12, title: 'Fresh'}]}})
		await apply([receipt('add_task_label', {id: 3, label_id: 12}, {label_id: 12})])
		expect(sdk.tasksRead).toHaveBeenCalledWith({path: {task: 3}})
		const listed: TaskResponse = client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0]
		expect(listed.labels.map(label => label.id)).toEqual([9, 12])
		// Embedded data only: other cached fields stay as they were.
		expect(listed.title).toBe('Before')
	})

	it('removes a deleted task from every view, adjusts totals and closes its open detail', async () => {
		const detail = new QueryObserver(client, {
			queryKey: taskKeys.detail(3),
			queryFn: async () => task,
			staleTime: Infinity,
			initialData: task,
		})
		const results: unknown[] = []
		const stop = detail.subscribe(result => results.push(result.error))
		const seen = serverList([])
		const next = normalizeTask({id: 2, project_id: 1, title: 'Moved up from page 2', bucket_id: 8})
		serverBoard([], 29, [next])
		await apply([receipt('delete_task', {id: 3}, {success: true, deleted: true})])
		expect(seen).toEqual([''])
		expect(client.getQueryData<PaginatedTaskResponse>(listKey)).toMatchObject({items: [], total: 0})
		expect(client.getQueryData<BoardData>(boardKey)).toMatchObject({buckets: [{count: 29}], pages: {8: 2}})
		expect(client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks.map(item => item.id)).toEqual([2])
		expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1)
		expect(sdk.projectViewTasksList).toHaveBeenCalledTimes(1)
		expect(boardFetch).not.toHaveBeenCalled()
		expect(results.at(-1)).toBeInstanceOf(TaskDeletedError)
		stop()
	})

	it('merges a returned project into the navigation list and detail', async () => {
		const cached = normalizeProject({id: 7, title: 'Thesis', max_permission: 2, views: [{id: 1, title: 'List'}]})
		client.setQueryData<ProjectListResult>(projectKeys.list(), {projects: [cached], favoriteProject: null, savedFilterProjects: []})
		client.setQueryData<ProjectResponse>(projectKeys.detail(7), cached)
		await apply([receipt('set_project_completed', {id: 7, completed: true}, {id: 7, title: 'Thesis', is_completed: true})])
		const listed = client.getQueryData<ProjectListResult>(projectKeys.list())!.projects[0]
		expect(listed).toMatchObject({is_completed: true, max_permission: 2})
		expect(listed.views).toHaveLength(1)
		expect(client.getQueryData<ProjectResponse>(projectKeys.detail(7))).toMatchObject({is_completed: true})
		expect(client.getQueryState(projectTimelineKeys.query({year: 2026}))?.isInvalidated).toBe(true)
		expect(client.getQueryState(['project-history', {year: 2026}])?.isInvalidated).toBe(true)
		expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	})

	it('patches a checked-in routine everywhere and invalidates only that task\'s routine and that announcement', async () => {
		const routine = {enabled: true, paused: false, completed_today: true, date: '2026-11-01', completed_at: '2026-11-01T08:00:00+08:00'}
		client.setQueryData(taskRoutineKeys.summary(3), {enabled: true, completed_today: false})
		client.setQueryData(taskRoutineKeys.summary(4), {enabled: true, completed_today: false})
		client.setQueryData(projectAnnouncementKeys.detail(1), {project_id: 1, revision: 1})
		client.setQueryData(projectAnnouncementKeys.detail(2), {project_id: 2, revision: 1})
		serverList([normalizeTask({...task, routine} as Task)])
		await apply([
			receipt('check_in_task_routine', {id: 3, date: '2026-11-01', completed: true}, {...serverTask, routine}),
			receipt('update_project_announcement', {id: 1, title: '', content: '<p>New</p>', revision: 1}, {project_id: 1, revision: 2}),
		])
		const card = client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0] as TaskResponse & {routine?: unknown}
		expect(card.routine).toMatchObject({completed_today: true})
		expect(card.done).toBe(false)
		expect(client.getQueryData<BoardData>(boardKey)!.pages).toEqual({8: 2})
		expect(boardFetch).not.toHaveBeenCalled()
		expect(client.getQueryState(taskRoutineKeys.summary(3))?.isInvalidated).toBe(true)
		expect(client.getQueryState(taskRoutineKeys.summary(4))?.isInvalidated).toBe(false)
		expect(client.getQueryState(projectAnnouncementKeys.detail(1))?.isInvalidated).toBe(true)
		expect(client.getQueryState(projectAnnouncementKeys.detail(2))?.isInvalidated).toBe(false)
	})

	it('refreshes the active period summary and history after an absolute routine progress receipt', async () => {
		const routine = {
			enabled: true,
			period: 'weekly',
			date: '2026-11-02',
			current_amount: 2,
			target: 5,
			completed_period: false,
		}
		const summaryFetch = vi.fn().mockResolvedValue(routine)
		const historyFetch = vi.fn().mockResolvedValue({periods: [{amount: 2, target: 5}]})
		client.setQueryData(taskRoutineKeys.summary(3), {...routine, current_amount: 0})
		client.setQueryData(taskRoutineKeys.history(3, 2026, 11), {periods: []})
		client.setQueryData(taskRoutineKeys.summary(4), {enabled: true})
		const stopSummary = observe(taskRoutineKeys.summary(3), summaryFetch)
		const stopHistory = observe(taskRoutineKeys.history(3, 2026, 11), historyFetch)
		serverList([normalizeTask({...task, routine} as Task)])
		await apply([receipt('set_task_routine_progress', {
			id: 3,
			date: '2026-11-02',
			revision: 2,
			amount: 2,
		}, {...serverTask, routine})])
		expect(summaryFetch).toHaveBeenCalledTimes(1)
		expect(historyFetch).toHaveBeenCalledTimes(1)
		expect(client.getQueryData(taskRoutineKeys.summary(3))).toMatchObject({current_amount: 2})
		expect(client.getQueryData(taskRoutineKeys.history(3, 2026, 11))).toMatchObject({periods: [{amount: 2}]})
		expect(client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0]).toMatchObject({routine})
		expect(client.getQueryState(taskRoutineKeys.summary(4))?.isInvalidated).toBe(false)
		expect(client.getQueryState(projectKeys.detail(3))).toBeUndefined()
		stopSummary()
		stopHistory()
	})

	it('patches a repeat policy receipt task without moving its card or scheduling broad project refetches', async () => {
		const returned = {...serverTask, title: 'Before', updated: '2026-11-02T12:00:00Z'}
		serverList([normalizeTask({...task, ...returned})])
		const changed = receipt('set_task_repeat_bucket', {
			project_id: 1,
			view_id: 4,
			task_id: 3,
			repeat_return_mode: 'keep',
			repeat_return_bucket_id: 0,
		}, {
			task: returned,
			repeat_bucket: {
				task_id: 3,
				project_view_id: 4,
				repeat_return_mode: 'keep',
				repeat_return_bucket_id: 0,
			},
		})
		expect(planAgentRefresh([changed])).toMatchObject({
			projectList: false,
			refetchProjects: [],
			history: false,
			timeline: false,
		})
		await apply([changed])
		const card = client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0]
		expect(card).toMatchObject({id: 3, bucket_id: 8, position: 250, updated: returned.updated})
		expect(client.getQueryData<BoardData>(boardKey)!.pages).toEqual({8: 2})
		expect(sdk.tasksRead).not.toHaveBeenCalled()
		expect(boardFetch).not.toHaveBeenCalled()
		expect(sdk.projectViewBucketsTasksList).not.toHaveBeenCalled()
	})

	it('does not let a routine refresh started before an agent write restore the old amount', async () => {
		const before = {
			enabled: true,
			period: 'weekly',
			date: '2026-11-02',
			current_amount: 0,
			target: 5,
			completed_period: false,
		}
		const updated = {...before, current_amount: 2}
		client.setQueryData(taskRoutineKeys.summary(3), before)
		let finishRead!: (value: unknown) => void
		sdk.taskRoutineRead.mockReturnValue(new Promise(resolve => { finishRead = resolve }))
		const refresh = client.getMutationCache().build(client, refreshTaskRoutinesMutationOptions()).execute([3])
		await vi.waitFor(() => expect(sdk.taskRoutineRead).toHaveBeenCalledOnce())
		serverList([normalizeTask({...task, routine: updated} as Task)])
		await apply([receipt('set_task_routine_progress', {
			id: 3,
			date: before.date,
			revision: 2,
			amount: 2,
		}, {...serverTask, routine: updated})])
		finishRead({data: before})
		await refresh
		expect(client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0]).toMatchObject({routine: updated})
		expect(client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0]).toMatchObject({routine: updated})
	})
})

describe('embedded task data after receipts', () => {
	let client: QueryClient
	const listKey = taskKeys.list({project: 1})
	const seven: Task = {id: 7, project_id: 1, title: 'Seven'}
	const base = normalizeTask({
		id: 3,
		project_id: 1,
		title: 'Before',
		comment_count: 2,
		related_tasks: {related: [seven]},
	})

	const listed = () => client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0]
	const detail = () => client.getQueryData<TaskResponse>(taskKeys.detail(3))!
	const relatedIds = () => (listed().related_tasks.related ?? []).map(item => item.id)
	const related = (...ids: number[]) => ({related: ids.map(id => ({id, project_id: 1, title: `Task ${id}`}))})

	function deferred<T>() {
		let resolve!: (value: T) => void
		const promise = new Promise<T>(done => {
			resolve = done
		})
		return {promise, resolve}
	}

	async function apply(receipts: AgentReceipt[]) {
		await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipts))
	}

	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		client.setQueryData<PaginatedTaskResponse>(listKey, {items: [base], total: 1, page: 1, per_page: 50, total_pages: 1})
		client.setQueryData<TaskResponse>(taskKeys.detail(3), base)
		client.setQueryData(commentKeys.task(3), [])
	})

	it('takes the comment count from the server, so a fresher full read is not counted twice', async () => {
		// A full read that already includes Arona's comment landed before the receipt.
		mapTaskEverywhere(client, 3, current => ({...current, comment_count: 3}))
		sdk.tasksRead.mockResolvedValue({data: {...base, comment_count: 3}})
		await apply([receipt('add_comment', {id: 3, comment: 'Done'}, {id: 40, comment: 'Done'})])
		expect(sdk.tasksRead).toHaveBeenCalledWith({path: {task: 3}, query: {expand: ['comment_count']}})
		expect(listed().comment_count).toBe(3)
		expect(detail().comment_count).toBe(3)
		expect(client.getQueryState(commentKeys.task(3))?.isInvalidated).toBe(true)
	})

	it('keeps a comment count that changed while the server count was in flight', async () => {
		sdk.tasksRead.mockImplementation(async () => {
			// The user posts a comment of their own meanwhile.
			mapTaskEverywhere(client, 3, current => ({...current, comment_count: 4}))
			return {data: {...base, comment_count: 3}}
		})
		await apply([receipt('add_comment', {id: 3, comment: 'Done'}, {id: 40, comment: 'Done'})])
		expect(listed().comment_count).toBe(4)
	})

	it('does not request a count no cached copy shows', async () => {
		mapTaskEverywhere(client, 3, ({comment_count: _count, ...current}) => current)
		await apply([receipt('add_comment', {id: 3, comment: 'Done'}, {id: 40, comment: 'Done'})])
		expect(sdk.tasksRead).not.toHaveBeenCalled()
	})

	it('ignores a relation response that a newer request overtook', async () => {
		const older = deferred<{data: Task}>()
		const newer = deferred<{data: Task}>()
		sdk.tasksRead.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
		const first = apply([receipt('relate_tasks', {id: 3, other_task_id: 8, relation_kind: 'related'}, {success: true})])
		await vi.waitFor(() => expect(sdk.tasksRead).toHaveBeenCalledTimes(1))
		const second = apply([receipt('relate_tasks', {id: 3, other_task_id: 9, relation_kind: 'related'}, {success: true})])
		await vi.waitFor(() => expect(sdk.tasksRead).toHaveBeenCalledTimes(2))

		newer.resolve({data: {...base, related_tasks: related(7, 8, 9)}})
		await second
		older.resolve({data: {...base, related_tasks: related(7, 8)}})
		await first
		expect(relatedIds()).toEqual([7, 8, 9])
	})

	it('keeps a relation the user changed while the fetch was in flight', async () => {
		sdk.tasksRead.mockImplementation(async () => {
			// The user's own relation edit and its refresh land first.
			mapTaskEverywhere(client, 3, current => normalizeTask({...current, related_tasks: related(7, 10)}))
			return {data: {...base, related_tasks: related(7, 8)}}
		})
		await apply([receipt('relate_tasks', {id: 3, other_task_id: 8, relation_kind: 'related'}, {success: true})])
		expect(relatedIds()).toEqual([7, 10])
	})

	it('patches assignees from the server, but never from a response older than the cached task', async () => {
		const kim = {id: 2, username: 'kim'}
		sdk.tasksRead.mockResolvedValue({data: {...base, title: 'Server title', assignees: [kim]}})
		await apply([receipt('assign_task', {id: 3, user_id: 2}, {success: true})])
		expect(listed().assignees).toEqual([kim])
		// Embedded data only: other fields keep their cached values.
		expect(listed().title).toBe('Before')

		mapTaskEverywhere(client, 3, current => ({...current, assignees: [], updated: '2026-10-31T12:00:00Z'}))
		sdk.tasksRead.mockResolvedValue({data: {...base, assignees: [kim], updated: '2026-10-31T11:00:00Z'}})
		await apply([receipt('assign_task', {id: 3, user_id: 2}, {success: true})])
		expect(detail().assignees).toEqual([])
	})
})

describe('bucket receipt cache writes', () => {
	let client: QueryClient
	const board = kanbanKeys.board(1, 4)
	const otherBoard = kanbanKeys.board(1, 5)
	const boardFetch = vi.fn()
	const card = normalizeTask({id: 3, project_id: 1, title: 'Card', bucket_id: 8})

	function observe(queryKey: QueryKey) {
		return new QueryObserver(client, {queryKey, queryFn: boardFetch, staleTime: Infinity}).subscribe(() => {})
	}

	async function apply(receipts: AgentReceipt[]) {
		await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipts))
	}

	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		boardFetch.mockResolvedValue({buckets: [], pages: {}})
		client.setQueryData<BoardData>(board, {
			buckets: [
				normalizeBucket({id: 8, title: 'To do', count: 1, tasks: [card]}),
				normalizeBucket({id: 10, title: 'Doing', count: 0, tasks: []}),
			],
			pages: {8: 1, 10: 1},
		})
		client.setQueryData<BoardData>(otherBoard, {
			buckets: [normalizeBucket({id: 20, title: 'Ideas', count: 0, tasks: []})],
			pages: {20: 1},
		})
		client.setQueryData(bucketKeys.list(1, 4), [{id: 8, title: 'To do'}, {id: 10, title: 'Doing'}])
		client.setQueryData(bucketKeys.list(1, 5), [{id: 20, title: 'Ideas'}])
		observe(board)
		observe(otherBoard)
	})

	it('reloads exactly the board whose buckets changed, through its loaded pages', async () => {
		sdk.projectViewBucketsTasksList.mockResolvedValue({data: {items: [
			{id: 8, title: 'To do', count: 1, tasks: [card]},
			{id: 10, title: 'Doing', count: 0, tasks: []},
			{id: 30, title: 'Review', count: 0, tasks: []},
		]}})
		await apply([receipt('create_bucket', {project_id: 1, view_id: 4, title: 'Review'}, {
			bucket: {id: 30, title: 'Review', limit: 0, order: 3},
			success: true,
			verified: true,
		})])
		expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1)
		expect(sdk.projectViewBucketsTasksList.mock.calls[0][0]).toMatchObject({path: {project: 1, view: 4}})
		const reloaded = client.getQueryData<BoardData>(board)!
		expect(reloaded.buckets.map(bucket => bucket.title)).toEqual(['To do', 'Doing', 'Review'])
		expect(reloaded.pages).toEqual({8: 1, 10: 1, 30: 1})
		// Never the generic first-page refetch, and nothing for the other view or task lists.
		expect(boardFetch).not.toHaveBeenCalled()
		expect(client.getQueryState(bucketKeys.list(1, 4))?.isInvalidated).toBe(true)
		expect(client.getQueryState(bucketKeys.list(1, 5))?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherBoard)?.isInvalidated).toBe(false)
		expect(client.getQueryData<BoardData>(otherBoard)!.buckets.map(bucket => bucket.id)).toEqual([20])
	})

	it('follows a move on a saved filter board and every open board showing the task', async () => {
		const filterBoard = kanbanKeys.board(-2, 9)
		client.setQueryData<BoardData>(filterBoard, {
			buckets: [
				normalizeBucket({id: 30, title: 'Open', count: 1, tasks: [card]}),
				normalizeBucket({id: 31, title: 'Done', count: 0, tasks: []}),
			],
			pages: {30: 1, 31: 1},
		})
		client.setQueryData(bucketKeys.list(-2, 9), [{id: 30}, {id: 31}])
		observe(filterBoard)
		const done = normalizeTask({...card, done: true})
		sdk.projectViewBucketsTasksList.mockImplementation(async ({path}: {path: {project: number, view: number}}) => ({
			data: {items: path.project < 0
				? [{id: 30, title: 'Open', count: 0, tasks: []}, {id: 31, title: 'Done', count: 1, tasks: [done]}]
				: [{id: 8, title: 'To do', count: 1, tasks: [done]}, {id: 10, title: 'Doing', count: 0, tasks: []}]},
		}))
		await apply([receipt('move_task_to_bucket', {project_id: -2, view_id: 9, bucket_id: 31, task_id: 3}, {
			task: {id: 3, title: 'Card', done: true, project_id: 1},
			bucket: {id: 31, title: 'Done'},
			previous_bucket_id: 30,
			effects: ['marks_task_done'],
		})])
		const paths = sdk.projectViewBucketsTasksList.mock.calls.map(([request]) => request.path)
		// The saved filter board keeps its negative id; the project board shows the card, the other view does not.
		expect(paths).toHaveLength(2)
		expect(paths).toEqual(expect.arrayContaining([{project: -2, view: 9}, {project: 1, view: 4}]))
		expect(client.getQueryData<BoardData>(filterBoard)!.buckets.map(bucket => bucket.tasks.map(task => task.id)))
			.toEqual([[], [3]])
		expect(client.getQueryData<BoardData>(board)!.buckets[0].tasks[0].done).toBe(true)
		expect(client.getQueryState(bucketKeys.list(-2, 9))?.isInvalidated).toBe(true)
		expect(boardFetch).not.toHaveBeenCalled()
	})

	it('patches the view after a delete and reloads only task details showing the deleted bucket', async () => {
		const project = normalizeProject({
			id: 1,
			title: 'Website',
			views: [{id: 4, title: 'Kanban', view_kind: 'kanban', default_bucket_id: 8, done_bucket_id: 0}],
		})
		client.setQueryData<ProjectListResult>(projectKeys.list(), {
			projects: [project],
			favoriteProject: null,
			savedFilterProjects: [],
		})
		client.setQueryData<ProjectResponse>(projectKeys.detail(1), project)
		client.setQueryData<TaskResponse>(taskKeys.detail(3), normalizeTask({...card, buckets: [{id: 8, title: 'To do'}]}))
		client.setQueryData<TaskResponse>(taskKeys.detail(4), normalizeTask({
			id: 4,
			project_id: 1,
			buckets: [{id: 20, title: 'Ideas'}],
		}))
		sdk.projectViewBucketsTasksList.mockResolvedValue({data: {items: [
			{id: 10, title: 'Doing', count: 1, tasks: [card]},
		]}})
		await apply([receipt('delete_bucket', {project_id: 1, view_id: 4, bucket_id: 8}, {
			deleted_bucket_id: 8,
			deleted_bucket_title: 'To do',
			tasks_moved: 1,
			tasks_deleted: 0,
			view: {default_bucket_id: 0, done_bucket_id: 0},
			moved_to_bucket: {id: 10, title: 'Doing'},
		})])
		expect(client.getQueryData<ProjectResponse>(projectKeys.detail(1))!.views[0])
			.toMatchObject({default_bucket_id: 0, done_bucket_id: 0})
		expect(client.getQueryData<ProjectListResult>(projectKeys.list())!.projects[0].views[0])
			.toMatchObject({default_bucket_id: 0, done_bucket_id: 0})
		expect(client.getQueryState(taskKeys.detail(3))?.isInvalidated).toBe(true)
		expect(client.getQueryState(taskKeys.detail(4))?.isInvalidated).toBe(false)
		const reloaded = client.getQueryData<BoardData>(board)!
		expect(reloaded.buckets.map(bucket => [bucket.id, bucket.count])).toEqual([[10, 1]])
		expect(reloaded.pages).toEqual({10: 1})
		expect(sdk.projectViewBucketsTasksList).toHaveBeenCalledTimes(1)
		expect(boardFetch).not.toHaveBeenCalled()
	})
})


describe('external and chat-image tool receipt boundaries', () => {
	it('does not turn MCP discovery into a write or remote tool results into Vikunja entities', () => {
		expect(agentReceipt('find', action('find_mcp_tools', {}, {tools: []}))).toBeUndefined()
		const remote = receipt('call_mcp_tool', {
			server_id: 'wallos',
			tool_name: 'delete_task',
			arguments: {id: 3},
		}, serverTask)
		const plan = planAgentRefresh([remote])
		expect(plan.operations).toEqual([])
		expect(plan.refetchTasks).toEqual([])
		expect(plan.refetchProjects).toEqual([])
		expect(plan.timeline).toBe(false)
		expect(plan.projectList).toBe(false)
	})

	it.each(['insert_chat_image', 'update_task_description_image', 'remove_task_description_image'])(
		'patches the description after %s and reads new attachments only when needed', tool => {
			const changed = {...serverTask, description: '<p>Updated image position</p>', attachments: null}
			const plan = planAgentRefresh([receipt(tool, {id: 3}, changed)])
			expect(plan.operations).toEqual([{kind: 'task', task: changed}])
			expect(plan.refetchTasks).toEqual(tool === 'remove_task_description_image' ? [] : [3])
			expect(plan.timeline).toBe(false)
			expect(plan.projectList).toBe(false)
		},
	)
	it('preserves old attachments during an image write and hydrates the exact open task through the generated client', async () => {
		vi.clearAllMocks()
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const oldAttachment = {id: 10, task_id: 3}
		const newAttachment = {id: 11, task_id: 3}
		const initial = normalizeTask({...serverTask, description: '<p>Before</p>', attachments: [oldAttachment]})
		client.setQueryData(taskKeys.detail(3), initial)
		const updated = {...serverTask, description: '<p>After image</p>', attachments: null}
		const hydrated = {...updated, attachments: [oldAttachment, newAttachment]}
		sdk.tasksRead.mockImplementation(async () => {
			const visible = client.getQueryData<TaskResponse>(taskKeys.detail(3))!
			expect(visible.description).toBe('<p>After image</p>')
			expect(visible.attachments.map(item => item.id)).toEqual([10])
			return {data: hydrated}
		})
		const detail = taskQuery(3)
		const unsubscribe = new QueryObserver(client, {
			queryKey: detail.queryKey,
			queryFn: detail.queryFn,
			staleTime: Infinity,
		}).subscribe(() => {})
		try {
			await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh([
				receipt('insert_chat_image', {id: 3, attachment_id: 'chat-image'}, updated),
			]))
			expect(sdk.tasksRead).toHaveBeenCalledTimes(1)
			expect(sdk.tasksRead.mock.calls[0][0].path).toEqual({task: 3})
			expect(client.getQueryData<TaskResponse>(taskKeys.detail(3))?.attachments.map(item => item.id)).toEqual([10, 11])
		} finally {
			unsubscribe()
			client.clear()
		}
	})

})
