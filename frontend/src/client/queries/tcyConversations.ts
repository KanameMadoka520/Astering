import {computed, onScopeDispose, ref, shallowReactive, toValue, watch, type MaybeRefOrGetter, type Ref} from 'vue'
import {
	hashKey,
	queryOptions,
	useMutation,
	useQueryClient,
	type QueryClient,
	type QueryKey,
} from '@tanstack/vue-query'
import {
	tasksRead,
	tcyAiConversationsList,
	tcyAiConversationsCreate,
	tcyAiConversationsRead,
	tcyAiConversationsRename,
	tcyAiConversationsOrganize,
	tcyAiConversationsDelete,
	tcyAiConversationsSend,
	tcyAiConversationsReview,
	tcyAiConversationsStop,
	tcyAiConversationsFork,
	tcyAiConversationsCompact,
	tcyAiPrompt,
	type Action,
	type Conversation,
	type Label,
	type Project,
	type ReviewInput,
	type Task,
	type TcyAiConversationsSendData,
} from '@/client/generated'
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {PERMISSIONS} from '@/constants/permissions'
import {contextMutationOptions} from './contextMutation'
import {commentKeys} from './comments'
import {bucketKeys, kanbanKeys} from './kanban'
import {agentBoardKeys} from './kanbanServerRefresh'
import {projectAnnouncementKeys} from './projectAnnouncements'
import {taskRoutineKeys} from './taskRoutines'
import {labelKeys} from './labels'
import {
	mapProjectNavigationItem,
	normalizeProject,
	projectKeys,
	type ProjectListResult,
	type ProjectResponse,
} from './projects'
import {projectTimelineKeys} from './projectTimeline'
import {
	cachedTaskCopies,
	isStaleTask,
	mapTaskEverywhere,
} from './taskCache'
import {applyServerTaskChanges, reconcileServerBoards, type ServerTaskChange} from './taskMutations'
import {normalizeTask, taskKeys, type TaskResponse} from './tasks'

export const conversationKeys = {
	all: ['tcymc-conversations'] as const,
	lists: () => [...conversationKeys.all, 'list'] as const,
	list: (page: number, q = '', scope = 'all') => [...conversationKeys.lists(), page, q, scope] as const,
	// Attachment bytes live below a detail key (chatAttachmentQuery). They never change for an id, so writes
	// invalidate the detail with `exact` instead of downloading every image of the conversation again.
	detail: (id: string) => [...conversationKeys.all, 'detail', id] as const,
}

const projectHistoryKey = ['project-history'] as const

export function conversationsQuery(page: number, q = '', scope: 'all' | 'active' | 'archived' = 'all') {
	return queryOptions({
		queryKey: conversationKeys.list(page, q, scope),
		queryFn: async ({signal}) => (await tcyAiConversationsList({query: {page, q, scope}, signal})).data,
		// Another page keeps the rows on screen while it loads; another search or scope must not show the old rows
		// under its heading.
		placeholderData: (previous, previousQuery) => previousQuery?.queryKey[3] === q && previousQuery.queryKey[4] === scope
			? previous
			: undefined,
		// Each request makes the server decrypt every conversation. Only a running one changes by itself; this tab's
		// own writes invalidate the lists, and the assistant view does so when its run ends.
		refetchInterval: query => query.state.data?.items?.some(item => item.running) ? 3000 : false,
		// A run started on another device shows up when the user comes back to the page.
		refetchOnWindowFocus: true,
		// The history panel shows its own error and retry.
		meta: {handlesError: true},
	})
}

function isRunning(conversation?: Conversation): boolean {
	return Boolean(conversation?.turns?.some(turn => turn.status === 'running'))
}

// A healthy event stream already delivers every change, so polling is only its fallback.
export function conversationQuery(id: string, streaming = false) {
	return queryOptions({
		queryKey: conversationKeys.detail(id),
		queryFn: async ({signal}) => (await tcyAiConversationsRead({path: {id}, signal})).data,
		enabled: Boolean(id),
		meta: {handlesError: true},
		refetchInterval: query => !streaming && (query.state.data?.compacting || isRunning(query.state.data))
			? 1000
			: false,
	})
}

export function promptQuery(projectId: number, mode: 'read' | 'write', allowDelete: boolean, enabled: boolean) {
	return queryOptions({
		queryKey: ['tcymc-ai-prompt', projectId, mode, allowDelete],
		queryFn: async ({signal}) => (await tcyAiPrompt({query: {
			project_id: projectId,
			mode,
			allow_delete: allowDelete,
		}, signal})).data,
		enabled,
	})
}

export function useCreateConversation() {
	return useMutation(contextMutationOptions({
		mutationFn: async () => (await tcyAiConversationsCreate({body: {title: ''}})).data,
		onSuccess: (created, _input, client) => {
			if (created.id) trackNewConversation(client, created.id)
		},
		onSettled: (_, client) => client.invalidateQueries({queryKey: conversationKeys.lists()}),
	}))
}

export function useConversationAction() {
	type Input = {
		id: string
		action: 'rename' | 'delete' | 'stop' | 'fork' | 'compact' | 'organize'
		pinned?: boolean
		archived?: boolean
		title?: string
		turnId?: string
		connectionId?: string
	}
	return useMutation(contextMutationOptions({
		mutationFn: async (input: Input): Promise<Conversation | undefined> => {
			const path = {id: input.id}
			switch (input.action) {
				case 'organize': return (await tcyAiConversationsOrganize({
					path,
					body: {
						pinned: input.pinned,
						archived: input.archived,
					},
				})).data
				case 'rename': return (await tcyAiConversationsRename({path, body: {title: input.title ?? ''}})).data
				case 'delete': await tcyAiConversationsDelete({path}); return
				case 'stop': await tcyAiConversationsStop({path}); return
				case 'fork': return (await tcyAiConversationsFork({path, body: {turn_id: input.turnId!}})).data
				case 'compact': return (await tcyAiConversationsCompact({
					path,
					body: {connection_id: input.connectionId ?? ''},
				})).data
			}
		},
		onSettled: (input, client) => Promise.all([
			client.invalidateQueries({queryKey: conversationKeys.lists()}),
			input.action === 'delete'
				? Promise.resolve()
				: client.invalidateQueries({queryKey: conversationKeys.detail(input.id), exact: true}),
		]),
	}))
}

export function useSendConversation() {
	return useMutation(contextMutationOptions({
		mutationFn: async (input: {
			id: string
			body: TcyAiConversationsSendData['body']
		}) => (await tcyAiConversationsSend({path: {id: input.id}, body: input.body})).data,
		onSuccess: (data, input, client) => client.setQueryData(conversationKeys.detail(input.id), data),
		onSettled: (input, client) => Promise.all([
			client.invalidateQueries({queryKey: conversationKeys.detail(input.id), exact: true}),
			client.invalidateQueries({queryKey: conversationKeys.lists()}),
		]),
	}))
}

// Task, project and label caches follow the receipts the resumed run returns (useAgentReceiptRefresh).
export function useReviewConversation() {
	return useMutation(contextMutationOptions({
		mutationFn: async (input: {id: string; body: ReviewInput}) =>
			(await tcyAiConversationsReview({path: {id: input.id}, body: input.body})).data,
		onSuccess: (data, input, client) => client.setQueryData(conversationKeys.detail(input.id), data),
		onSettled: (input, client) => Promise.all([
			client.invalidateQueries({queryKey: conversationKeys.detail(input.id), exact: true}),
			client.invalidateQueries({queryKey: conversationKeys.lists()}),
		]),
	}))
}

// Agent receipts: refresh caches from what real, successful write tools returned, never from the reply text.

export type AgentReceipt = {
	key: string
	tool: string
	arguments: Record<string, unknown>
	result: unknown
}

type TaskEntity = Task & {id: number, project_id: number}
type ProjectEntity = Project & {id: number, title: string}
type LabelEntity = Label & {id: number}
// A kanban view; saved filter boards keep their negative pseudo project id.
type AgentBoard = {project: number, view: number}

type AgentCacheOperation =
	| {kind: 'task', task: TaskEntity}
	| {kind: 'createdTask', task: TaskEntity}
	| {kind: 'removeTask', id: number}
	| {kind: 'label', label: LabelEntity}
	| {kind: 'taskLabel', task: number, label: number, add: boolean}
	| {kind: 'unassign', task: number, user: number}
	| {kind: 'project', project: ProjectEntity}
	| {kind: 'createdProject', project: ProjectEntity}
	| {kind: 'viewBuckets', project: number, view: number, defaultBucket: number, doneBucket: number}

export type AgentRefreshPlan = {
	operations: AgentCacheOperation[]
	// Tasks whose embedded labels, assignees or relations changed without a task in the receipt.
	fetchTasks: number[]
	refetchTasks: number[]
	refetchProjects: number[]
	// Tasks with a new comment: their comment list refreshes and their count follows the server.
	comments: number[]
	taskLists: false | 'none' | 'active'
	projectList: boolean
	labels: boolean
	history: boolean
	timeline: boolean
	// Projects whose announcement changed, and tasks whose routine summary or history changed.
	announcements: number[]
	routines: number[]
	// Boards whose buckets a bucket tool changed, tasks it moved between buckets (other open boards
	// showing them follow), and buckets renamed or deleted (open task details embedding them reload).
	boards: AgentBoard[]
	movedTasks: number[]
	buckets: number[]
}

const READ_ONLY_TOOLS = new Set(['find_tools', 'ask_user', 'web_search', 'invoke_tool'])
// Fields that move a task on the project timeline (dates, progress, completion, project).
const TIMELINE_FIELDS = ['start_date', 'end_date', 'due_date', 'percent_done', 'done', 'project_id']
// Project fields shown on the timeline and in the lifecycle history.
const PROJECT_DISPLAY_FIELDS = ['title', 'hex_color']
// move_task_to_bucket effects that change a task's done state or dates, which the timeline shows.
const TIMELINE_MOVE_EFFECTS = ['marks_task_done', 'reopens_task', 'repeating_task_advances_dates']

// Mirrors the server's write classification (tcyai.IsWriteTool).
export function isAgentWriteTool(tool: string): boolean {
	return tool !== ''
		&& !tool.startsWith('list_')
		&& !tool.startsWith('get_')
		&& !READ_ONLY_TOOLS.has(tool)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJSON(value?: string): unknown {
	try {
		return JSON.parse(value ?? '')
	} catch {
		return undefined
	}
}

function positiveId(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

// Bucket tools take a real project or a saved filter (negative id); Favorites (-1) has no editable board.
function agentBoard(args: Record<string, unknown>): AgentBoard | undefined {
	const project = args.project_id
	const view = positiveId(args.view_id)
	if (typeof project !== 'number' || !Number.isInteger(project) || project === 0 || project === -1) return undefined
	return view === undefined ? undefined : {project, view}
}

function bucketRef(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

// The view's default and done bucket as the server stored them after set_view_buckets or delete_bucket.
function viewBucketsPatch(board: AgentBoard | undefined, result: unknown): AgentCacheOperation | undefined {
	const view = isRecord(result) && isRecord(result.view) ? result.view : undefined
	if (!board || !view || (view.id !== undefined && view.id !== board.view)) return undefined
	const {default_bucket_id: defaultBucket, done_bucket_id: doneBucket} = view
	if (!bucketRef(defaultBucket) || !bucketRef(doneBucket)) return undefined
	return {
		kind: 'viewBuckets',
		project: board.project,
		view: board.view,
		defaultBucket,
		doneBucket,
	}
}

function isTaskEntity(value: unknown): value is TaskEntity {
	return isRecord(value) && positiveId(value.id) !== undefined && typeof value.project_id === 'number'
}

function isProjectEntity(value: unknown): value is ProjectEntity {
	return isRecord(value) && positiveId(value.id) !== undefined && typeof value.title === 'string'
}

function isLabelEntity(value: unknown): value is LabelEntity {
	return isRecord(value) && positiveId(value.id) !== undefined && typeof value.title === 'string'
}

function touches(changes: unknown, fields: readonly string[]): boolean {
	return isRecord(changes) && fields.some(field => field in changes)
}

export function agentReceipt(key: string, action: Action): AgentReceipt | undefined {
	const tool = action.tool ?? ''
	if (!action.success || !isAgentWriteTool(tool)) return undefined
	const args = parseJSON(action.arguments)
	return {
		key,
		tool,
		arguments: isRecord(args) ? args : {},
		result: parseJSON(action.result),
	}
}

type AgentRunScope = {
	// Account and API the state below belongs to.
	context: string
	// Receipt keys (turn + action index) per conversation already reflected, or present before the chat was observed.
	ledger: Map<string, Set<string>>
	// The account's running conversation: the server runs one model job per account.
	live: Ref<string>
	// Conversations a mounted assistant follows itself; the app-level run observer leaves them alone.
	viewers: Map<string, number>
}

const runScopes = new WeakMap<QueryClient, AgentRunScope>()

function accountContext(): string {
	const {apiBaseUrl, identity, authSessionEpoch} = captureClientRequestContext()
	return JSON.stringify([apiBaseUrl, identity?.id, identity?.type, authSessionEpoch])
}

function liveHintKey(context: string) {
	return `arona-live:${context}`
}

// One scope per query client and account: the client survives a logout, but nothing another account (or an
// earlier session of the same account) observed may suppress or replay receipts.
export function agentRunScope(client: QueryClient): AgentRunScope {
	const context = accountContext()
	let scope = runScopes.get(client)
	if (!scope) {
		scope = {
			context,
			ledger: new Map(),
			live: ref(''),
			viewers: shallowReactive(new Map()),
		}
		runScopes.set(client, scope)
	} else if (scope.context !== context) {
		scope.context = context
		scope.ledger = new Map()
		scope.live.value = ''
	}
	return scope
}

function setLiveRun(scope: AgentRunScope, id: string) {
	if (scope.live.value === id) return
	scope.live.value = id
	try {
		if (id) sessionStorage.setItem(liveHintKey(scope.context), id)
		else sessionStorage.removeItem(liveHintKey(scope.context))
	} catch { /* Browser storage is optional; only a reload during a run loses the hint. */ }
}

// Follows the run again after a reload, until its conversation shows it finished.
export function resumeAgentRun(client: QueryClient) {
	const scope = agentRunScope(client)
	if (scope.live.value) return
	try {
		scope.live.value = sessionStorage.getItem(liveHintKey(scope.context)) ?? ''
	} catch { /* Browser storage is optional. */ }
}

export function endAgentRun(client: QueryClient, id: string) {
	const scope = agentRunScope(client)
	if (scope.live.value === id) setLiveRun(scope, '')
}

function noteAgentRun(client: QueryClient, conversation?: Conversation) {
	if (!conversation?.id) return
	if (isRunning(conversation)) setLiveRun(agentRunScope(client), conversation.id)
	else endAgentRun(client, conversation.id)
}

// A conversation created in this tab has no history, so its first receipts must refresh caches.
export function trackNewConversation(client: QueryClient, id: string) {
	const {ledger} = agentRunScope(client)
	if (!ledger.has(id)) ledger.set(id, new Set())
}

// Returns receipts that appeared since the conversation was last seen. The first sighting of a
// conversation only records its receipts: reopening an old chat replays nothing.
export function takeAgentReceipts(client: QueryClient, conversation?: Conversation): AgentReceipt[] {
	if (!conversation?.id) return []
	const {ledger} = agentRunScope(client)
	const actions = (conversation.turns ?? []).flatMap(turn => (turn.result?.actions ?? [])
		.map((action, index) => ({key: `${turn.id ?? turn.request_id}:${index}`, action})))
	const seen = ledger.get(conversation.id)
	if (!seen) {
		ledger.set(conversation.id, new Set(actions.map(({key}) => key)))
		return []
	}
	return actions.flatMap(({key, action}) => {
		if (seen.has(key)) return []
		seen.add(key)
		const receipt = agentReceipt(key, action)
		return receipt ? [receipt] : []
	})
}

function emptyPlan(): AgentRefreshPlan {
	return {
		operations: [],
		fetchTasks: [],
		refetchTasks: [],
		refetchProjects: [],
		comments: [],
		taskLists: false,
		projectList: false,
		labels: false,
		history: false,
		timeline: false,
		announcements: [],
		routines: [],
		boards: [],
		movedTasks: [],
		buckets: [],
	}
}

export function planAgentRefresh(receipts: readonly AgentReceipt[]): AgentRefreshPlan {
	const plan = emptyPlan()
	const markLists = (refetchType: 'none' | 'active') => {
		if (plan.taskLists !== 'active') plan.taskLists = refetchType
	}
	for (const {tool, arguments: args, result} of receipts) {
		const id = positiveId(args.id)
		switch (tool) {
			case 'update_task':
				if (isTaskEntity(result) && (id === undefined || result.id === id)) {
					plan.operations.push({kind: 'task', task: result})
				} else if (id) {
					plan.refetchTasks.push(id)
					// Without the task the new filter membership is unknown.
					markLists('active')
				}
				plan.timeline ||= touches(args, TIMELINE_FIELDS)
				break
			case 'bulk_update_tasks': {
				const updates = (Array.isArray(args.updates) ? args.updates : []).filter(isRecord)
				if (Array.isArray(result) && result.length && result.every(isTaskEntity)) {
					result.forEach(task => plan.operations.push({kind: 'task', task}))
				} else {
					updates.forEach(update => {
						const target = positiveId(update.id)
						if (target) plan.refetchTasks.push(target)
					})
					markLists('active')
				}
				plan.timeline ||= updates.some(update => touches(update.changes, TIMELINE_FIELDS))
				break
			}
			case 'create_task':
				if (isTaskEntity(result)) plan.operations.push({kind: 'createdTask', task: result})
				else markLists('active')
				plan.timeline = true
				break
			case 'delete_task':
				if (id) plan.operations.push({kind: 'removeTask', id})
				else markLists('active')
				plan.timeline = true
				break
			case 'add_task_label':
			case 'remove_task_label': {
				const label = positiveId(args.label_id)
				if (id && label) plan.operations.push({kind: 'taskLabel', task: id, label, add: tool === 'add_task_label'})
				markLists('none')
				break
			}
			case 'assign_task':
				if (id) plan.fetchTasks.push(id)
				markLists('none')
				break
			case 'unassign_task': {
				const user = positiveId(args.user_id)
				if (id && user) plan.operations.push({kind: 'unassign', task: id, user})
				else if (id) plan.fetchTasks.push(id)
				markLists('none')
				break
			}
			case 'relate_tasks':
			case 'unrelate_tasks': {
				const other = positiveId(args.other_task_id)
				plan.fetchTasks.push(...[id, other].filter((task): task is number => task !== undefined))
				// Subtask relations change which tasks a list shows at the top level.
				markLists('active')
				break
			}
			case 'add_comment':
				if (id) plan.comments.push(id)
				markLists('none')
				break
			case 'create_label':
				if (isLabelEntity(result)) plan.operations.push({kind: 'label', label: result})
				plan.labels = true
				break
			case 'create_project':
				if (isProjectEntity(result)) plan.operations.push({kind: 'createdProject', project: result})
				plan.projectList = true
				break
			case 'update_project':
			case 'set_project_completed': {
				if (isProjectEntity(result) && (id === undefined || result.id === id)) {
					plan.operations.push({kind: 'project', project: result})
				} else if (id) {
					plan.refetchProjects.push(id)
				}
				plan.projectList = true
				const shown = tool === 'set_project_completed' || touches(args, PROJECT_DISPLAY_FIELDS)
				plan.history ||= shown
				plan.timeline ||= shown
				break
			}
			case 'update_project_announcement': {
				// Only that project's announcement; nothing else derives from it.
				const project = positiveId(args.project_id) ?? id
					?? (isRecord(result) ? positiveId(result.project_id) : undefined)
				if (project) plan.announcements.push(project)
				break
			}
			case 'configure_task_routine':
			case 'check_in_task_routine': {
				// The full task comes back: patched like any task change. The routine never moves done or
				// list membership, so open lists are not marked stale.
				const task = positiveId(args.task_id) ?? id
				if (isTaskEntity(result) && (task === undefined || result.id === task)) {
					plan.operations.push({kind: 'task', task: result})
					plan.routines.push(result.id)
				} else if (task) {
					plan.refetchTasks.push(task)
					plan.routines.push(task)
				}
				break
			}
			case 'move_task_to_bucket': {
				const task = positiveId(args.task_id)
				const board = agentBoard(args)
				if (task) {
					plan.refetchTasks.push(task)
					plan.movedTasks.push(task)
				}
				if (board) plan.boards.push(board)
				// Entering or leaving the done bucket marks the task done or reopens it: filters may now differ.
				markLists('active')
				const effects = isRecord(result) && Array.isArray(result.effects) ? result.effects : undefined
				plan.timeline ||= !effects
					|| effects.some((effect: unknown) => typeof effect === 'string' && TIMELINE_MOVE_EFFECTS.includes(effect))
				break
			}
			case 'create_bucket':
			case 'update_bucket':
			case 'set_view_buckets':
			case 'delete_bucket': {
				const board = agentBoard(args)
				if (board) plan.boards.push(board)
				else markLists('none')
				const bucket = positiveId(args.bucket_id)
				if (bucket && (tool === 'update_bucket' || tool === 'delete_bucket')) plan.buckets.push(bucket)
				if (tool === 'set_view_buckets' || tool === 'delete_bucket') {
					// The view's default and done bucket live in the project caches.
					const patch = viewBucketsPatch(board, result)
					if (patch) plan.operations.push(patch)
					else if (board && board.project > 0) plan.refetchProjects.push(board.project)
					plan.projectList = true
				}
				// The deleted bucket's tasks move without changing their done state.
				if (tool === 'delete_bucket') markLists('none')
				break
			}
			default: {
				// Unknown write: the named records and stale lists only, never a refetch of everything.
				const task = id ?? positiveId(args.task_id)
				const project = positiveId(args.project_id) ?? id
				if (task) plan.refetchTasks.push(task)
				if (project) plan.refetchProjects.push(project)
				markLists('none')
				plan.projectList = true
				plan.history = true
				plan.timeline = true
			}
		}
	}
	plan.fetchTasks = [...new Set(plan.fetchTasks)]
	plan.refetchTasks = [...new Set(plan.refetchTasks)]
	plan.refetchProjects = [...new Set(plan.refetchProjects)]
	plan.comments = [...new Set(plan.comments)]
	plan.announcements = [...new Set(plan.announcements)]
	plan.routines = [...new Set(plan.routines)]
	plan.boards = [...new Map(plan.boards.map(board => [`${board.project}:${board.view}`, board])).values()]
	plan.movedTasks = [...new Set(plan.movedTasks)]
	plan.buckets = [...new Set(plan.buckets)]
	return plan
}

function cachedLabel(client: QueryClient, id: number): Label | undefined {
	return client.getQueryData<Label[]>(labelKeys.all)?.find(label => label.id === id)
}

function mergeProject(previous: ProjectResponse, updated: ProjectEntity): ProjectResponse {
	return normalizeProject({
		...previous,
		...updated,
		max_permission: updated.max_permission ?? previous.max_permission,
		views: updated.views?.length ? updated.views : previous.views,
	})
}

// Task entities go through applyServerTaskChanges in onSettled; these are the remaining in-place patches.
function patchAgentChanges(client: QueryClient, plan: AgentRefreshPlan) {
	for (const operation of plan.operations) {
		switch (operation.kind) {
			case 'label':
				client.setQueryData<Label[]>(labelKeys.all, current => current
					? [...current.filter(label => label.id !== operation.label.id), operation.label]
					: current)
				break
			case 'taskLabel': {
				const label = operation.add ? cachedLabel(client, operation.label) : undefined
				if (operation.add && !label) break
				mapTaskEverywhere(client, operation.task, task => ({
					...task,
					labels: [
						...task.labels.filter(item => item.id !== operation.label),
						...(label ? [label] : []),
					],
				}))
				break
			}
			case 'unassign':
				mapTaskEverywhere(client, operation.task, task => ({
					...task,
					assignees: task.assignees.filter(user => user.id !== operation.user),
				}))
				break
			case 'project':
				client.setQueryData<ProjectListResult>(projectKeys.list(), current => current
					? mapProjectNavigationItem(current, operation.project.id, previous => mergeProject(previous, operation.project))
					: current)
				client.setQueryData<ProjectResponse>(projectKeys.detail(operation.project.id), current => current
					? mergeProject(current, operation.project)
					: current)
				break
			case 'viewBuckets': {
				const {project, view, defaultBucket, doneBucket} = operation
				const update = (current: ProjectResponse): ProjectResponse => ({
					...current,
					views: current.views.map(item => item.id === view
						? {...item, default_bucket_id: defaultBucket, done_bucket_id: doneBucket}
						: item),
				})
				// Saved filters exist only in the navigation list; they have no detail query.
				client.setQueryData<ProjectListResult>(projectKeys.list(), current => current
					? mapProjectNavigationItem(current, project, update)
					: current)
				if (project > 0) {
					client.setQueryData<ProjectResponse>(projectKeys.detail(project), current => current
						? update(current)
						: current)
				}
				break
			}
			case 'createdProject': {
				// The creating account administrates the new project.
				const created = normalizeProject({...operation.project, max_permission: PERMISSIONS.ADMIN})
				client.setQueryData<ProjectListResult>(projectKeys.list(), current => current
					? {
						...current,
						projects: [...current.projects.filter(project => project.id !== created.id), created]
							.sort((a, b) => a.position - b.position),
					}
					: current)
				break
			}
		}
	}
}

function taskChanges(plan: AgentRefreshPlan): ServerTaskChange[] {
	return plan.operations.flatMap((operation): ServerTaskChange[] => {
		switch (operation.kind) {
			case 'task': return [{kind: 'updated', task: operation.task}]
			case 'createdTask': return [{kind: 'created', task: operation.task}]
			case 'removeTask': return [{kind: 'deleted', id: operation.id}]
			default: return []
		}
	})
}

type EmbeddedField = 'labels' | 'assignees' | 'related_tasks' | 'comment_count'

function sortedIds(items?: readonly {id?: number}[] | null): number[] {
	return (items ?? []).map(item => item.id ?? 0).sort((a, b) => a - b)
}

// Identity of an embedded value, to tell whether a cached copy changed while a request was in flight.
function embeddedSignature(task: Task, field: EmbeddedField): string {
	switch (field) {
		case 'labels': return JSON.stringify(sortedIds(task.labels))
		case 'assignees': return JSON.stringify(sortedIds(task.assignees))
		case 'comment_count': return String(task.comment_count)
		case 'related_tasks': return JSON.stringify(Object.keys(task.related_tasks ?? {})
			.sort()
			.map(kind => [kind, sortedIds(task.related_tasks?.[kind])] as const)
			.filter(([, ids]) => ids.length > 0))
	}
}

function withEmbedded(task: TaskResponse, field: EmbeddedField, source: Task): TaskResponse {
	switch (field) {
		case 'labels': return {...task, labels: source.labels ?? []}
		case 'assignees': return {...task, assignees: source.assignees ?? []}
		case 'related_tasks': return normalizeTask({...task, related_tasks: source.related_tasks ?? {}})
		// Only copies loaded with the count expansion show one.
		case 'comment_count': return task.comment_count === undefined ? task : {...task, comment_count: source.comment_count}
	}
}

const fieldGenerations = new WeakMap<QueryClient, Map<string, number>>()

function fieldGeneration(client: QueryClient, key: string, bump = false): number {
	let generations = fieldGenerations.get(client)
	if (!generations) {
		generations = new Map()
		fieldGenerations.set(client, generations)
	}
	const generation = (generations.get(key) ?? 0) + (bump ? 1 : 0)
	generations.set(key, generation)
	return generation
}

/**
 * Reads tasks whose embedded data (labels, assignees, relations, comment count) changed without a task in
 * the receipt and patches only those fields. A response never overwrites a field that a newer request asked
 * for again, that changed in the cache while it was in flight (a user edit, a fresher response), or a
 * cached copy that is newer than the response.
 */
async function refreshEmbeddedTaskData(client: QueryClient, requests: ReadonlyMap<number, readonly EmbeddedField[]>) {
	const jobs = [...requests].flatMap(([id, wanted]) => {
		const copies = cachedTaskCopies(client, id)
		const counted = copies.some(copy => copy.comment_count !== undefined)
		const fields = wanted.filter(field => field !== 'comment_count' || counted)
		if (!copies.length || !fields.length) return []
		return [{
			id,
			fields,
			before: new Map(fields.map(field => [field, new Set(copies.map(copy => embeddedSignature(copy, field)))])),
			generations: new Map(fields.map(field => [field, fieldGeneration(client, `${id}:${field}`, true)])),
		}]
	})
	if (!jobs.length) return
	const context = captureClientRequestContext()
	const results = await Promise.allSettled(jobs.map(job => tasksRead(job.fields.includes('comment_count')
		? {path: {task: job.id}, query: {expand: ['comment_count']}}
		: {path: {task: job.id}})))
	assertClientRequestContext(context)
	results.forEach((result, index) => {
		const job = jobs[index]
		const task = result.status === 'fulfilled' ? result.value.data : undefined
		if (task?.id !== job.id || isStaleTask(client, task)) return
		const fields = job.fields
			.filter(field => fieldGeneration(client, `${job.id}:${field}`) === job.generations.get(field))
		if (!fields.length) return
		mapTaskEverywhere(client, job.id, current => fields.reduce(
			(next, field) => job.before.get(field)?.has(embeddedSignature(current, field))
				? withEmbedded(next, field, task)
				: next,
			current,
		))
	})
}

function embeddedRequests(client: QueryClient, plan: AgentRefreshPlan): Map<number, EmbeddedField[]> {
	const requests = new Map<number, EmbeddedField[]>()
	const add = (id: number, fields: readonly EmbeddedField[]) =>
		requests.set(id, [...new Set([...(requests.get(id) ?? []), ...fields])])
	plan.fetchTasks.forEach(id => add(id, ['labels', 'assignees', 'related_tasks']))
	plan.operations.forEach(operation => {
		if (operation.kind === 'taskLabel' && operation.add && !cachedLabel(client, operation.label)) {
			add(operation.task, ['labels'])
		}
	})
	// The server count, not a local +1: a concurrent full read may already include the new comment.
	plan.comments.forEach(id => add(id, ['comment_count']))
	return requests
}

// Open boards whose buckets changed, and open boards showing a task moved between buckets.
function changedBoardKeys(client: QueryClient, plan: AgentRefreshPlan): QueryKey[] {
	const keys = new Map<string, QueryKey>()
	const add = (key: QueryKey) => keys.set(hashKey(key), key)
	plan.boards.forEach(({project, view}) => client.getQueryCache()
		.findAll({queryKey: kanbanKeys.view(project, view), type: 'active'})
		.forEach(query => add(query.queryKey)))
	agentBoardKeys(client, {projectIds: [], taskIds: plan.movedTasks}).forEach(add)
	return [...keys.values()]
}

function embedsBucket(task: unknown, buckets: readonly number[]): boolean {
	return isRecord(task) && Array.isArray(task.buckets) && task.buckets.some((bucket: unknown) =>
		isRecord(bucket) && typeof bucket.id === 'number' && buckets.includes(bucket.id))
}

async function settleAgentChanges(client: QueryClient, plan: AgentRefreshPlan) {
	const changes = taskChanges(plan)
	const updated = changes.flatMap(change => change.kind === 'updated' ? [change.task.id!] : [])
	const patchedProjects = plan.operations.flatMap(operation => {
		if (operation.kind === 'project') return [operation.project.id]
		return operation.kind === 'viewBuckets' && operation.project > 0 ? [operation.project] : []
	})
	const boards = changedBoardKeys(client, plan)
	// Task changes refresh membership themselves: affected open lists refetch once, affected boards reload their loaded pages.
	const lists = changes.length ? false : plan.taskLists
	await Promise.all([
		applyServerTaskChanges(client, changes),
		refreshEmbeddedTaskData(client, embeddedRequests(client, plan)),
		...(lists ? [
			client.invalidateQueries({queryKey: taskKeys.lists, refetchType: lists}),
			client.invalidateQueries({queryKey: taskKeys.allLists, refetchType: lists}),
			// A board refetch returns only the first page per bucket, so receipts patch boards instead.
			client.invalidateQueries({queryKey: kanbanKeys.all, refetchType: 'none'}),
		] : []),
		...updated.map(id => client.invalidateQueries({queryKey: [...taskKeys.details, id], refetchType: 'none'})),
		...plan.refetchTasks.map(id => client.invalidateQueries({queryKey: [...taskKeys.details, id]})),
		...plan.comments.map(id => client.invalidateQueries({queryKey: commentKeys.task(id)})),
		...patchedProjects.map(id => client.invalidateQueries({queryKey: projectKeys.detail(id), refetchType: 'none'})),
		...plan.refetchProjects.map(id => client.invalidateQueries({queryKey: projectKeys.detail(id)})),
		plan.projectList ? client.invalidateQueries({queryKey: projectKeys.list(), refetchType: 'none'}) : undefined,
		plan.labels ? client.invalidateQueries({queryKey: labelKeys.all, refetchType: 'none'}) : undefined,
		plan.history ? client.invalidateQueries({queryKey: projectHistoryKey}) : undefined,
		plan.timeline ? client.invalidateQueries({queryKey: projectTimelineKeys.all}) : undefined,
		...plan.announcements.map(id => client.invalidateQueries({queryKey: projectAnnouncementKeys.detail(id)})),
		...plan.routines.map(id => client.invalidateQueries({queryKey: taskRoutineKeys.task(id)})),
		...plan.boards.flatMap(({project, view}) => [
			client.invalidateQueries({queryKey: bucketKeys.list(project, view)}),
			// A closed board reloads when it opens again; open ones are reconciled below.
			client.invalidateQueries({
				queryKey: kanbanKeys.view(project, view),
				refetchType: 'none',
				predicate: query => !query.isActive(),
			}),
		]),
		plan.buckets.length
			? client.invalidateQueries({
				queryKey: taskKeys.details,
				predicate: query => embedsBucket(query.state.data, plan.buckets),
			})
			: undefined,
		// Every loaded page of an open board reloads, as after task writes; a plain refetch keeps only the first page.
		reconcileServerBoards(client, boards),
	])
}

export function agentRefreshMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (plan: AgentRefreshPlan) => plan,
		onSuccess: (plan, _input, client) => patchAgentChanges(client, plan),
		onSettled: (plan, client) => settleAgentChanges(client, plan),
	})
}

export function useAgentRefresh() {
	return useMutation(agentRefreshMutationOptions())
}

// Applies each new receipt of a conversation once, whichever window observes it, and tracks whether its run is live.
export function useApplyAgentReceipts() {
	const client = useQueryClient()
	const refresh = useAgentRefresh()
	return (conversation?: Conversation) => {
		const receipts = takeAgentReceipts(client, conversation)
		if (receipts.length) refresh.mutate(planAgentRefresh(receipts))
		noteAgentRun(client, conversation)
	}
}

/** The account's running conversation, if any: the server runs one model job per account. */
export function useLiveAgentRun() {
	const client = useQueryClient()
	return computed(() => agentRunScope(client).live.value)
}

// For an assistant view: applies the receipts of the conversation it shows and keeps the app-level
// run observer off that conversation while the view is mounted.
export function useAgentReceiptRefresh(conversation: MaybeRefOrGetter<Conversation | undefined>) {
	const client = useQueryClient()
	const apply = useApplyAgentReceipts()
	let viewing = ''
	function view(id: string) {
		if (id === viewing) return
		const {viewers} = agentRunScope(client)
		if (viewing) {
			const count = (viewers.get(viewing) ?? 1) - 1
			if (count > 0) viewers.set(viewing, count)
			else viewers.delete(viewing)
		}
		if (id) viewers.set(id, (viewers.get(id) ?? 0) + 1)
		viewing = id
	}
	watch(() => toValue(conversation), value => {
		view(value?.id ?? '')
		apply(value)
	}, {immediate: true})
	onScopeDispose(() => view(''))
}
