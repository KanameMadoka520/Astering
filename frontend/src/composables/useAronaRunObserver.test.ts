import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computed, defineComponent, reactive, type ComputedRef} from 'vue'
import {mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin, useQuery} from '@tanstack/vue-query'
import type {Action, Conversation} from '@/client/generated'
import {
	agentRunScope,
	conversationQuery,
	trackNewConversation,
	useAgentReceiptRefresh,
} from '@/client/queries/tcyConversations'
import {normalizeTask, taskKeys, type PaginatedTaskResponse} from '@/client/queries/tasks'
import {removeToken, saveToken} from '@/helpers/auth'
import {useAronaRunObserver} from './useAronaRunObserver'

const sdk = vi.hoisted(() => ({
	tcyAiConversationsRead: vi.fn(),
	tcyAiConversationsEvents: vi.fn(),
	tasksRead: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
const auth = reactive({
	info: {id: 1},
	session: 0,
})
vi.mock('@/stores/auth', () => ({
	useAuthStore: () => auth,
}))

const listKey = taskKeys.list({project: 1})

function update(changes: Record<string, unknown>): Action {
	return {
		tool: 'update_task',
		arguments: JSON.stringify({id: 3, ...changes}),
		result: JSON.stringify({id: 3, project_id: 1, title: 'Before', priority: 1, ...changes}),
		success: true,
	}
}

// A mutable stand-in for the server's conversation record.
type ServerConversation = {
	id: string
	compacting?: boolean
	turns: {
		id: string
		status: string
		result: {actions: Action[]}
	}[]
}

let server: ServerConversation
const listed = (client: QueryClient) => client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0]
const reads = () => sdk.tcyAiConversationsRead.mock.calls.length
const streams = () => sdk.tcyAiConversationsEvents.mock.calls.length

// What TcyAssistant does for the conversation it shows (full page or floating panel).
const AssistantView = defineComponent({
	props: {
		chat: {
			type: String,
			required: true,
		},
	},
	setup(props) {
		const query = useQuery(computed(() => conversationQuery(props.chat)))
		useAgentReceiptRefresh(query.data)
		return () => null
	},
})

describe('Arona run observer', () => {
	let client: QueryClient
	let following: ComputedRef<string[]>
	const mounted: {unmount: () => void}[] = []

	function mountView(chat: string) {
		const wrapper = mount(AssistantView, {
			props: {chat},
			global: {plugins: [[VueQueryPlugin, {queryClient: client}]]},
		})
		mounted.push(wrapper)
		return wrapper
	}

	function mountObserver() {
		const wrapper = mount(defineComponent({
			setup() {
				following = useAronaRunObserver().following
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		mounted.push(wrapper)
		return wrapper
	}

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']})
		vi.clearAllMocks()
		removeToken()
		saveToken(`fixture.${btoa(JSON.stringify({id: 1, type: 1}))}.fixture`, false)
		auth.info.id = 1
		auth.session++
		sessionStorage.clear()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		client.setQueryData<PaginatedTaskResponse>(listKey, {
			items: [normalizeTask({id: 3, project_id: 1, title: 'Before', priority: 1})],
			total: 1,
			page: 1,
			per_page: 50,
			total_pages: 1,
		})
		server = {
			id: 'c1',
			turns: [{
				id: 't1',
				status: 'running',
				result: {actions: [update({priority: 5})]},
			}],
		}
		sdk.tcyAiConversationsRead.mockImplementation(async () => ({data: structuredClone(server)}))
		// The event stream never connects here, so the observer relies on its polling fallback.
		sdk.tcyAiConversationsEvents.mockImplementation(({signal}: {signal: AbortSignal}) => new Promise((_, reject) => {
			signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
		}))
	})

	afterEach(() => {
		mounted.splice(0).forEach(wrapper => wrapper.unmount())
		client.clear()
		vi.useRealTimers()
	})

	it('takes over a running chat when its view goes away and applies each new receipt once', async () => {
		const view = mountView('c1')
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		// The view shows the live chat: the observer neither streams nor polls it.
		expect(agentRunScope(client).live.value).toEqual(['c1'])
		expect(following.value).toEqual([])
		expect(reads()).toBe(1)
		expect(streams()).toBe(0)

		// The run continues after the user leaves the assistant.
		view.unmount()
		server.turns[0].result.actions.push(update({title: 'Renamed by Arona'}))
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c1'])
		expect(streams()).toBe(1)
		await vi.waitFor(() => expect(listed(client).title).toBe('Renamed by Arona'))
		// The receipt that existed when the chat was first seen is never replayed.
		expect(listed(client).priority).toBe(1)

		server.turns[0].status = 'completed'
		await vi.advanceTimersByTimeAsync(1000)
		expect(following.value).toEqual([])
		expect(agentRunScope(client).live.value).toEqual([])
		const settled = reads()
		await vi.advanceTimersByTimeAsync(5000)
		expect(reads()).toBe(settled)

		// Opening the chat again (floating panel, full page) replays nothing.
		mountView('c1')
		await vi.advanceTimersByTimeAsync(10)
		expect(client.getMutationCache().getAll()).toHaveLength(1)
	})

	it('hands a followed chat back to a view without applying a receipt twice', async () => {
		trackNewConversation(client, 'c1')
		agentRunScope(client).live.value = ['c1']
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c1'])
		await vi.waitFor(() => expect(listed(client).priority).toBe(5))

		mountView('c1')
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual([])
		server.turns[0].result.actions.push(update({title: 'Renamed by Arona'}))
		await vi.advanceTimersByTimeAsync(1000)
		await vi.waitFor(() => expect(listed(client).title).toBe('Renamed by Arona'))
		// One plan per new receipt, whichever of the two saw it.
		expect(client.getMutationCache().getAll()).toHaveLength(2)
	})

	it('resumes following a run after a reload until the chat shows it finished', async () => {
		server.turns[0].status = 'completed'
		sessionStorage.setItem(`arona-live:${agentRunScope(client).context}`, 'c1')
		mountObserver()
		expect(following.value).toEqual(['c1'])
		await vi.advanceTimersByTimeAsync(10)
		expect(reads()).toBe(1)
		expect(following.value).toEqual([])
		expect(sessionStorage.getItem(`arona-live:${agentRunScope(client).context}`)).toBeNull()
		// First sighting after the reload: the old receipt is recorded, not replayed.
		expect(listed(client).priority).toBe(1)
	})

	it('stops following a conversation that no longer exists', async () => {
		sdk.tcyAiConversationsRead.mockRejectedValue(Object.assign(new Error('Not found'), {status: 404}))
		agentRunScope(client).live.value = ['gone']
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual([])
	})

	it('keeps two SSE streams independent when A finishes and B hands back to its view', async () => {
		const second: ServerConversation = {
			id: 'c2',
			turns: [{
				id: 't2',
				status: 'running',
				result: {actions: []},
			}],
		}
		server.turns[0].result.actions = []
		const records = new Map([
			['c1', server],
			['c2', second],
		])
		sdk.tcyAiConversationsRead.mockImplementation(async ({path}: {path: {id: string}}) => ({
			data: structuredClone(records.get(path.id)),
		}))
		const liveStreams = new Map<string, {
			send: (record: ServerConversation) => void
			signal: AbortSignal
		}>()
		sdk.tcyAiConversationsEvents.mockImplementation(async ({path, signal}: {
			path: {id: string}
			signal: AbortSignal
		}) => {
			let controller!: ReadableStreamDefaultController<Uint8Array>
			const data = new ReadableStream<Uint8Array>({
				start: value => { controller = value },
			})
			signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
			liveStreams.set(path.id, {
				signal,
				send: record => {
					const activity = {
						turn: record.turns[0],
						compacting: false,
						compactions: [],
					}
					controller.enqueue(new TextEncoder().encode(`event: activity\ndata: ${JSON.stringify(activity)}\n\n`))
				},
			})
			return {data}
		})
		for (const id of ['c1', 'c2']) trackNewConversation(client, id)
		agentRunScope(client).live.value = ['c1']
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		const first = liveStreams.get('c1')!
		agentRunScope(client).live.value = ['c1', 'c2']
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c1', 'c2'])
		expect(first.signal.aborted).toBe(false)
		expect(streams()).toBe(2)
		const other = liveStreams.get('c2')!
		server.turns[0].status = 'completed'
		server.turns[0].result.actions.push(update({title: 'Completed in A'}))
		first.send(server)
		await vi.advanceTimersByTimeAsync(10)
		expect(first.signal.aborted).toBe(true)
		expect(following.value).toEqual(['c2'])
		expect(other.signal.aborted).toBe(false)
		expect(streams()).toBe(2)
		expect(listed(client).title).toBe('Completed in A')
		second.turns[0].result.actions.push(update({priority: 4}))
		other.send(second)
		await vi.advanceTimersByTimeAsync(10)
		expect(listed(client).priority).toBe(4)
		const view = mountView('c2')
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual([])
		expect(other.signal.aborted).toBe(true)
		view.unmount()
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c2'])
		expect(streams()).toBe(3)
		expect(client.getMutationCache().getAll()).toHaveLength(2)
	})

	it('stops only an unreadable conversation while another compaction keeps polling', async () => {
		server.compacting = true
		server.id = 'c2'
		server.turns[0].status = 'completed'
		sdk.tcyAiConversationsRead.mockImplementation(async ({path}: {path: {id: string}}) => {
			if (path.id === 'gone') throw Object.assign(new Error('Forbidden'), {status: 403})
			return {data: structuredClone(server)}
		})
		agentRunScope(client).live.value = ['gone', 'c2']
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c2'])
		const other = sdk.tcyAiConversationsEvents.mock.calls.find(([input]) => input.path.id === 'c2')![0]
		expect(other.signal.aborted).toBe(false)
		const before = reads()
		await vi.advanceTimersByTimeAsync(1000)
		expect(reads()).toBeGreaterThan(before)
		server.compacting = false
		await vi.advanceTimersByTimeAsync(1000)
		expect(following.value).toEqual([])
		expect(other.signal.aborted).toBe(true)
	})

	it('resumes every saved conversation and removes each finished hint independently', async () => {
		server.turns[0].status = 'completed'
		const second = structuredClone(server)
		second.id = 'c2'
		second.turns[0].status = 'running'
		sdk.tcyAiConversationsRead.mockImplementation(async ({path}: {path: {id: string}}) => ({
			data: structuredClone(path.id === 'c1' ? server : second),
		}))
		const key = `arona-live:${agentRunScope(client).context}`
		sessionStorage.setItem(key, JSON.stringify(['c1', 'c2']))
		mountObserver()
		expect(following.value).toEqual(['c1', 'c2'])
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual(['c2'])
		expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(['c2'])
		second.turns[0].status = 'completed'
		await vi.advanceTimersByTimeAsync(1000)
		expect(following.value).toEqual([])
		expect(sessionStorage.getItem(key)).toBeNull()
	})

	it('aborts every previous-account stream and does not let an old view release the new viewer', async () => {
		agentRunScope(client).live.value = ['c1', 'c2']
		sdk.tcyAiConversationsRead.mockImplementation(() => new Promise(() => undefined))
		mountObserver()
		await vi.advanceTimersByTimeAsync(10)
		const oldRequests = [...sdk.tcyAiConversationsEvents.mock.calls]
		expect(oldRequests).toHaveLength(2)
		// The old view owns c3 in the previous account.
		client.setQueryData<Conversation>(conversationQuery('c3').queryKey, {
			id: 'c3',
			turns: [],
		})
		const oldView = mountView('c3')
		await vi.advanceTimersByTimeAsync(10)
		removeToken()
		saveToken(`fixture.${btoa(JSON.stringify({id: 2, type: 1}))}.fixture`, false)
		auth.info.id = 2
		auth.session++
		await vi.advanceTimersByTimeAsync(10)
		expect(following.value).toEqual([])
		oldRequests.forEach(([input]) => expect(input.signal.aborted).toBe(true))
		const scope = agentRunScope(client)
		scope.viewers.set('c3', 1)
		oldView.unmount()
		expect(scope.viewers.get('c3')).toBe(1)
	})
})
