import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computed, defineComponent, type Ref} from 'vue'
import {mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin, useQuery, type Query} from '@tanstack/vue-query'
import type {ChatTurn, Conversation} from '@/client/generated'
import {HEALTHY_STREAM_MS, MAX_RETRY_MS, RETRY_MS, SILENT_STREAM_MS, useConversationEvents} from './conversationEvents'
import {conversationKeys, conversationQuery} from './tcyConversations'

const sdk = vi.hoisted(() => ({
	tcyAiConversationsEvents: vi.fn(),
	tcyAiConversationsRead: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))

type ServedStream = {
	send: (payload: object, name?: string) => void
	sendBytes: (bytes: Uint8Array) => void
	close: () => void
	fail: () => void
}

let streams: ServedStream[]

// A server-sent event stream the test drives frame by frame; aborting the request errors it like fetch does.
function serveStream({signal}: {signal: AbortSignal}) {
	const encoder = new TextEncoder()
	let controller!: ReadableStreamDefaultController<Uint8Array>
	const data = new ReadableStream<Uint8Array>({
		start: value => {
			controller = value
		},
	})
	signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
	streams.push({
		send: (payload, name = 'activity') => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)),
		sendBytes: bytes => controller.enqueue(bytes),
		close: () => controller.close(),
		fail: () => controller.error(new TypeError('network error')),
	})
	return {data}
}

const running: Conversation = {
	id: 'c1',
	turns: [{
		id: 't1',
		status: 'running',
	}],
}

function mountEvents(client: QueryClient, poll = false) {
	let connected!: Ref<boolean>
	const wrapper = mount(defineComponent({
		setup() {
			const events = useConversationEvents('c1')
			connected = events.connected
			if (poll) useQuery(computed(() => conversationQuery('c1', events.connected.value)))
			return () => null
		},
	}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
	return {
		wrapper,
		connected: () => connected.value,
	}
}

const calls = () => sdk.tcyAiConversationsEvents.mock.calls.length

describe('conversation events', () => {
	let client: QueryClient

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']})
		vi.clearAllMocks()
		streams = []
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tcyAiConversationsEvents.mockImplementation(async (options: {signal: AbortSignal}) => serveStream(options))
		sdk.tcyAiConversationsRead.mockImplementation(async () => ({data: running}))
	})

	afterEach(() => {
		client.clear()
		vi.useRealTimers()
	})

	it('reconnects at once after the server ends a healthy stream and stays live meanwhile', async () => {
		const {wrapper, connected} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		expect(calls()).toBe(1)
		streams[0].send({compacting: false, compactions: []})
		await vi.advanceTimersByTimeAsync(10)
		expect(connected()).toBe(true)

		// The server cuts every stream after 25 seconds.
		await vi.advanceTimersByTimeAsync(25_000)
		streams[0].close()
		await vi.advanceTimersByTimeAsync(10)
		expect(calls()).toBe(2)
		expect(connected()).toBe(true)

		streams[1].send({compacting: false, compactions: []})
		await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS + 10)
		expect(connected()).toBe(true)
		wrapper.unmount()
	})

	it('backs off when a stream ends at once without data instead of looping', async () => {
		sdk.tcyAiConversationsEvents.mockImplementation(async (options: {signal: AbortSignal}) => {
			const response = serveStream(options)
			streams.at(-1)!.close()
			return response
		})
		const {wrapper, connected} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		expect(calls()).toBe(1)
		await vi.advanceTimersByTimeAsync(RETRY_MS - 20)
		expect(calls()).toBe(1)
		await vi.advanceTimersByTimeAsync(20)
		expect(calls()).toBe(2)
		// The second empty stream doubles the wait.
		await vi.advanceTimersByTimeAsync(RETRY_MS * 2 - 20)
		expect(calls()).toBe(2)
		await vi.advanceTimersByTimeAsync(20)
		expect(calls()).toBe(3)
		await vi.advanceTimersByTimeAsync(60_000)
		// 6s, 12s, 24s and then the cap: far from a request loop.
		expect(calls()).toBeLessThanOrEqual(7)
		expect(connected()).toBe(false)
		const before = calls()
		await vi.advanceTimersByTimeAsync(MAX_RETRY_MS)
		expect(calls()).toBe(before + 1)
		wrapper.unmount()
	})

	it('backs off after failed requests', async () => {
		sdk.tcyAiConversationsEvents.mockRejectedValue(new TypeError('Failed to fetch'))
		const {wrapper} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(RETRY_MS * 3 + 10)
		// 1.5s and 3s waits: the third request starts at 4.5s.
		expect(calls()).toBe(3)
		wrapper.unmount()
	})

	it('keeps the steady retry cadence after a short stream that delivered state', async () => {
		sdk.tcyAiConversationsEvents.mockImplementation(async (options: {signal: AbortSignal}) => {
			const response = serveStream(options)
			streams.at(-1)!.send({compacting: false, compactions: []})
			streams.at(-1)!.close()
			return response
		})
		const {wrapper, connected} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		expect(calls()).toBe(1)
		expect(connected()).toBe(false)
		await vi.advanceTimersByTimeAsync(RETRY_MS)
		expect(calls()).toBe(2)
		await vi.advanceTimersByTimeAsync(RETRY_MS)
		expect(calls()).toBe(3)
		wrapper.unmount()
	})

	it('drops the live state when a reconnect stays silent', async () => {
		const {wrapper, connected} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		streams[0].send({compacting: false, compactions: []})
		await vi.advanceTimersByTimeAsync(HEALTHY_STREAM_MS)
		streams[0].close()
		await vi.advanceTimersByTimeAsync(10)
		expect(calls()).toBe(2)
		expect(connected()).toBe(true)
		await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS)
		expect(connected()).toBe(false)
		wrapper.unmount()
	})

	it('merges streamed turns into the cached conversation', async () => {
		client.setQueryData(conversationKeys.detail('c1'), running)
		const {wrapper} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		streams[0].send({
			turn: {
				id: 't1',
				status: 'completed',
			},
			compacting: false,
			compactions: [],
		})
		await vi.advanceTimersByTimeAsync(10)
		expect(client.getQueryData<Conversation>(conversationKeys.detail('c1'))?.turns).toEqual([{id: 't1', status: 'completed'}])
		wrapper.unmount()
	})

	it('keeps server unread state as the delta baseline after a local acknowledgement', async () => {
		const key = conversationKeys.detail('c1')
		const reply: ChatTurn = {id: 't1', status: 'completed', result: {reply: 'First reply'}}
		client.setQueryData<Conversation>(key, {
			id: 'c1',
			turns: [reply],
			unread: true,
			latest_reply_id: 't1:first-result',
		})
		const {wrapper} = mountEvents(client)
		await vi.advanceTimersByTimeAsync(10)
		// Acknowledgement reaches the cache before an already-sampled server snapshot arrives.
		client.setQueryData<Conversation>(key, current => ({...current!, unread: false}))
		streams[0].send({
			revision: 1,
			snapshot: {
				turn: reply,
				compacting: false,
				compactions: [],
				unread: true,
				latest_reply_id: 't1:first-result',
			},
		}, 'snapshot')
		await vi.advanceTimersByTimeAsync(10)
		expect(client.getQueryData<Conversation>(key)?.unread).toBe(false)
		streams[0].send({
			base: 1,
			revision: 2,
			patch: [
				{op: 'set', path: ['latest_reply_id'], value: 't2:second-result'},
				{op: 'set', path: ['turn'], value: {id: 't2', status: 'completed', result: {reply: 'New reply'}}},
			],
		}, 'delta')
		await vi.advanceTimersByTimeAsync(10)
		// The server was already unread=true, so its delta legitimately omits that unchanged field.
		expect(client.getQueryData<Conversation>(key)).toMatchObject({
			unread: true,
			latest_reply_id: 't2:second-result',
			turns: [reply, {id: 't2', status: 'completed', result: {reply: 'New reply'}}],
		})
		wrapper.unmount()
	})

		it('negotiates using Accept and anchors deltas to the actual cache without traversing stable tool results', async () => {
			const resultRead = vi.fn(() => 'stable result')
			const action = {
				round: 1,
				tool: 'get_task',
				get result() { return resultRead() },
			}
			const turn: NonNullable<Conversation['turns']>[number] = {
				id: 't1',
				status: 'running',
				result: {
					steps: [{round: 1, text: '你好'}],
					actions: [action],
				},
			}
			client.setQueryData<Conversation>(conversationKeys.detail('c1'), {
				id: 'c1',
				turns: [turn],
			})
			const {wrapper} = mountEvents(client)
			await vi.advanceTimersByTimeAsync(10)
			expect(sdk.tcyAiConversationsEvents).toHaveBeenCalledWith(expect.objectContaining({
				headers: {Accept: 'text/event-stream; vikunja-events=delta-v1'},
			}))
			streams[0].send({
				revision: 1,
				snapshot: {turn, compacting: false, compactions: []},
			}, 'snapshot')
			await vi.advanceTimersByTimeAsync(10)
			const before = client.getQueryData<Conversation>(conversationKeys.detail('c1'))!
			const stable = before.turns![0].result!.actions
			expect(stable![0]).toBe(action)
			resultRead.mockClear()
			streams[0].send({
				base: 1,
				revision: 2,
				patch: [{op: 'append', path: ['turn', 'result', 'steps', '0', 'text'], value: '，世界🌏'}],
			}, 'delta')
			await vi.advanceTimersByTimeAsync(10)
			const after = client.getQueryData<Conversation>(conversationKeys.detail('c1'))!
			expect(after.turns![0].result!.steps![0].text).toBe('你好，世界🌏')
			expect(after.turns![0].result!.actions).toBe(stable)
			expect(resultRead).not.toHaveBeenCalled()
			wrapper.unmount()
		})

		it('retains intermediate replies, receipts and terminal/compaction state across delta frames', async () => {
			client.setQueryData(conversationKeys.detail('c1'), running)
			const {wrapper} = mountEvents(client)
			await vi.advanceTimersByTimeAsync(10)
			streams[0].send({
				revision: 1,
				snapshot: {
					turn: {
						id: 't1',
						status: 'running',
						result: {
							steps: [{round: 1, text: 'Earlier reply', reasoning: 'Earlier reasoning'}],
							actions: [{round: 1, tool: 'get_task', result: 'Found'}],
							pause: 'review',
						},
					},
					compacting: false,
					compactions: [],
				},
			}, 'snapshot')
			await vi.advanceTimersByTimeAsync(10)
			streams[0].send({
				base: 1,
				revision: 2,
				patch: [
					{op: 'set', path: ['turn', 'result', 'steps', '1'], value: {round: 2, text: 'Final answer'}},
					{op: 'set', path: ['turn', 'status'], value: 'completed'},
					{op: 'remove', path: ['turn', 'result', 'pause']},
					{op: 'set', path: ['compacting'], value: true},
					{op: 'set', path: ['compact_text'], value: 'Summarizing'},
					{op: 'set', path: ['compact_progress'], value: {stage: 'model'}},
				],
			}, 'delta')
			await vi.advanceTimersByTimeAsync(10)
			const compacting = client.getQueryData<Conversation>(conversationKeys.detail('c1'))!
			expect(compacting.compacting).toBe(true)
			expect(compacting.compact_text).toBe('Summarizing')
			expect(compacting.turns![0].status).toBe('completed')
			expect(compacting.turns![0].result!.pause).toBeUndefined()
			streams[0].send({
				base: 2,
				revision: 3,
				patch: [
					{op: 'set', path: ['compacting'], value: false},
					{op: 'remove', path: ['compact_text']},
					{op: 'remove', path: ['compact_progress']},
					{op: 'set', path: ['compactions', '0'], value: {summary: 'Saved summary', through: 1}},
				],
			}, 'delta')
			await vi.advanceTimersByTimeAsync(10)
			const completed = client.getQueryData<Conversation>(conversationKeys.detail('c1'))!
			expect(completed.compacting).toBe(false)
			expect(completed.compact_text).toBe('')
			expect(completed.compact_progress).toBeUndefined()
			expect(completed.compactions![0].summary).toBe('Saved summary')
			expect(completed.turns![0].result!.steps).toEqual([
				{round: 1, text: 'Earlier reply', reasoning: 'Earlier reasoning'},
				{round: 2, text: 'Final answer'},
			])
			expect(completed.turns![0].result!.actions![0].result).toBe('Found')
			wrapper.unmount()
		})

		it.each([
			{base: 0, revision: 2, patch: [{op: 'set', path: ['compacting'], value: true}]},
			{base: 1, revision: 1, patch: [{op: 'set', path: ['compacting'], value: true}]},
			{base: 1, revision: 3, patch: [{op: 'set', path: ['compacting'], value: true}]},
			{base: 1, revision: 2, patch: [{op: 'set', path: ['__proto__', 'polluted'], value: true}]},
			{base: 1, revision: 2, patch: [
				{op: 'set', path: ['compacting'], value: true},
				{op: 'set', path: ['compactions', '1'], value: {}},
			]},
		])('resynchronizes invalid deltas without publishing a partial update: %j', async invalid => {
			client.setQueryData(conversationKeys.detail('c1'), running)
			const {wrapper} = mountEvents(client)
			await vi.advanceTimersByTimeAsync(10)
			streams[0].send({
				revision: 1,
				snapshot: {turn: running.turns![0], compacting: false, compactions: []},
			}, 'snapshot')
			await vi.advanceTimersByTimeAsync(10)
			const before = client.getQueryData(conversationKeys.detail('c1'))
			streams[0].send(invalid, 'delta')
			await vi.advanceTimersByTimeAsync(10)
			expect(calls()).toBe(2)
			expect(client.getQueryData(conversationKeys.detail('c1'))).toBe(before)
			expect(Object.prototype).not.toHaveProperty('polluted')
			streams[1].send({
				revision: 1,
				snapshot: {turn: {id: 't1', status: 'completed'}, compacting: false, compactions: []},
			}, 'snapshot')
			await vi.advanceTimersByTimeAsync(10)
			expect(client.getQueryData<Conversation>(conversationKeys.detail('c1'))!.turns![0].status).toBe('completed')
			wrapper.unmount()
		})

		it('accepts an adaptive snapshot within a connection and resets revisions on a healthy reconnect', async () => {
			client.setQueryData(conversationKeys.detail('c1'), running)
			const {wrapper} = mountEvents(client)
			await vi.advanceTimersByTimeAsync(10)
			const snapshot = {turn: running.turns![0], compacting: false, compactions: []}
			streams[0].send({revision: 1, snapshot}, 'snapshot')
			streams[0].send({revision: 2, snapshot: {...snapshot, compact_text: 'New snapshot'}}, 'snapshot')
			await vi.advanceTimersByTimeAsync(HEALTHY_STREAM_MS)
			streams[0].close()
			await vi.advanceTimersByTimeAsync(10)
			streams[1].send({revision: 1, snapshot: {...snapshot, compact_text: 'Reconnected'}}, 'snapshot')
			streams[1].send({
				base: 1,
				revision: 2,
				patch: [{op: 'append', path: ['compact_text'], value: ' safely'}],
			}, 'delta')
			await vi.advanceTimersByTimeAsync(10)
			expect(client.getQueryData<Conversation>(conversationKeys.detail('c1'))!.compact_text).toBe('Reconnected safely')
			wrapper.unmount()
		})

		it('backs off repeated invalid baselines after the first immediate recovery', async () => {
			sdk.tcyAiConversationsEvents.mockImplementation(async (options: {signal: AbortSignal}) => {
				const response = serveStream(options)
				streams.at(-1)!.send({base: 1, revision: 2, patch: []}, 'delta')
				return response
			})
			const {wrapper} = mountEvents(client)
			await vi.advanceTimersByTimeAsync(10)
			expect(calls()).toBe(2)
			await vi.advanceTimersByTimeAsync(RETRY_MS)
			expect(calls()).toBe(3)
			await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
			expect(calls()).toBe(4)
			wrapper.unmount()
		})

		it.runIf(process.env.VIKUNJA_STREAM_BENCH === '1')('measures synthetic snapshot/delta client CPU and retained heap', async () => {
			const encoder = new TextEncoder()
			const steps = Array.from({length: 40}, (_, index) => ({round: index + 1, text: `Round ${index + 1} completed`}))
			const actions = Array.from({length: 200}, (_, index) => ({
				round: Math.floor(index / 5) + 1,
				tool: 'get_task',
				arguments: JSON.stringify({id: index + 1}),
				result: 'r'.repeat(2048),
			}))
			const text = 't'.repeat(80 * 1024)
			const gc = (globalThis as typeof globalThis & {gc?: () => void}).gc
			const measure = async (delta: boolean) => {
				const cache = new QueryClient({defaultOptions: {queries: {retry: false}}})
				cache.setQueryData(conversationKeys.detail('c1'), running)
				const {wrapper} = mountEvents(cache)
				await vi.advanceTimersByTimeAsync(10)
				const target = streams.at(-1)!
				gc?.()
				const beforeHeap = process.memoryUsage().heapUsed
				let bytes = 0
				let cpuMicros = 0
				let wallMs = 0
				let previousLength = 0
				for (let frame = 0; frame < 250; frame++) {
					const length = Math.floor(text.length * (frame + 1) / 250)
					steps[39].text = text.slice(0, length)
					const snapshot = {
						compacting: false,
						compactions: [],
						turn: {id: 't1', status: 'running', result: {steps, actions}},
					}
					const name = delta ? frame ? 'delta' : 'snapshot' : 'activity'
					const payload = !delta ? snapshot : frame ? {
						base: frame,
						revision: frame + 1,
						patch: [{
							op: 'append',
							path: ['turn', 'result', 'steps', '39', 'text'],
							value: text.slice(previousLength, length),
						}],
					} : {revision: 1, snapshot}
					const encoded = encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
					bytes += encoded.byteLength
					const cpu = process.cpuUsage()
					const start = performance.now()
					target.sendBytes(encoded)
					await vi.advanceTimersByTimeAsync(0)
					wallMs += performance.now() - start
					const used = process.cpuUsage(cpu)
					cpuMicros += used.user + used.system
					previousLength = length
				}
				gc?.()
				const retainedHeap = gc ? process.memoryUsage().heapUsed - beforeHeap : null
				expect(actions).toHaveLength(200)
				expect(steps[39].text).toHaveLength(text.length)
				expect(cache.getQueryData<Conversation>(conversationKeys.detail('c1'))!.turns![0].result!.steps![39].text).toBe(text)
				wrapper.unmount()
				cache.clear()
				return {bytes, cpuMs: cpuMicros / 1000, wallMs, retainedHeap}
			}
			const legacy = await measure(false)
			const delta = await measure(true)
			expect(delta.bytes).toBeLessThan(legacy.bytes / 50)
			process.stdout.write('STREAM_SYNTHETIC_CLIENT ' + JSON.stringify({
				frames: 250,
				steps: 40,
				receipts: 200,
				receiptBytes: 2048,
				textBytes: 81920,
				legacy,
				delta,
				gc: Boolean(gc),
				measurement: 'SSE decoding + real QueryClient publication CPU; fixture generation excluded; synthetic only',
			}) + '\n')
		})

	it('skips the conversation poll while the stream is live and polls a running chat otherwise', async () => {
		const {wrapper} = mountEvents(client, true)
		await vi.advanceTimersByTimeAsync(10)
		expect(sdk.tcyAiConversationsRead).toHaveBeenCalledTimes(1)
		streams[0].send({compacting: false, compactions: []})
		await vi.advanceTimersByTimeAsync(5000)
		expect(sdk.tcyAiConversationsRead).toHaveBeenCalledTimes(1)

		sdk.tcyAiConversationsEvents.mockRejectedValue(new TypeError('Failed to fetch'))
		streams[0].fail()
		await vi.advanceTimersByTimeAsync(1010)
		expect(sdk.tcyAiConversationsRead).toHaveBeenCalledTimes(2)
		wrapper.unmount()
	})
})

describe('conversation polling fallback', () => {
	const interval = (streaming: boolean, data: Conversation) => {
		const option = conversationQuery('c1', streaming).refetchInterval as unknown as (query: Query<Conversation>) => number | false
		return option({state: {data}} as Query<Conversation>)
	}

	it('polls only a running or compacting conversation without a live stream', () => {
		expect(interval(false, running)).toBe(1000)
		expect(interval(false, {id: 'c1', compacting: true, turns: []})).toBe(1000)
		expect(interval(false, {id: 'c1', turns: [{id: 't1', status: 'completed'}]})).toBe(false)
		expect(interval(true, running)).toBe(false)
	})
})
