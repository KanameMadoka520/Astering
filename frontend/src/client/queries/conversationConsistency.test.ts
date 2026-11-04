import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computed, defineComponent} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin, useQuery} from '@tanstack/vue-query'
import type {Conversation} from '@/client/generated'
import {useConversationEvents} from './conversationEvents'
import {
	agentRunScope,
	conversationKeys,
	conversationQuery,
	useConversationAction,
	useReviewConversation,
	useSendConversation,
} from './tcyConversations'
import {
	readConversationSnapshot,
	shareConversationSnapshot,
	writeConversationSnapshot,
} from './conversationSnapshot'

const sdk = vi.hoisted(() => ({
	tcyAiConversationsEvents: vi.fn(),
	tcyAiConversationsRead: vi.fn(),
	tcyAiConversationsSend: vi.fn(),
	tcyAiConversationsReview: vi.fn(),
	tcyAiConversationsCompact: vi.fn(),
}))
const session = vi.hoisted(() => ({
	id: 1,
	epoch: 0,
	api: '/api/v2/',
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('@/helpers/auth', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/auth')>(),
	getToken: () => 'synthetic',
	getTokenIdentity: () => ({id: session.id, type: 1}),
	getAuthSessionEpoch: () => session.epoch,
}))
vi.mock('@/helpers/apiUrl', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/apiUrl')>(),
	getApiBaseUrl: () => session.api,
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return {promise, resolve}
}
const key = conversationKeys.detail('c1')
const initial: Conversation = {
	id: 'c1',
	title: 'Server title',
	turns: [{id: 't1', status: 'running'}],
}
const finished: Conversation = {
	...initial,
	turns: [{
		id: 't1',
		status: 'completed',
		result: {reply: 'Finished'},
	}],
}
let client: QueryClient
let wrapper: VueWrapper | undefined
let sendFrame: (payload: object) => void

function observe() {
	let send!: ReturnType<typeof useSendConversation>
	let review!: ReturnType<typeof useReviewConversation>
	let action!: ReturnType<typeof useConversationAction>
	wrapper = mount(defineComponent({
		setup() {
			const events = useConversationEvents('c1')
			useQuery(computed(() => conversationQuery('c1', events.connected.value)))
			send = useSendConversation()
			review = useReviewConversation()
			action = useConversationAction()
			return () => null
		},
	}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
	return {send, review, action}
}
function activity(turn = finished.turns![0]) {
	return {
		turn,
		compacting: false,
		compactions: [],
	}
}
const cached = () => client.getQueryData<Conversation>(key)

beforeEach(() => {
	vi.clearAllMocks()
	Object.assign(session, {
		id: 1,
		epoch: 0,
		api: '/api/v2/',
	})
	client = new QueryClient({defaultOptions: {queries: {
		retry: false,
		gcTime: Infinity,
	}}})
	sdk.tcyAiConversationsRead.mockResolvedValue({data: finished})
	sdk.tcyAiConversationsEvents.mockImplementation(async ({signal}: {signal: AbortSignal}) => {
		let controller!: ReadableStreamDefaultController<Uint8Array>
		let ended = false
		const data = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value
			},
			cancel() {
				ended = true
			},
		})
		signal.addEventListener('abort', () => {
			if (!ended) {
				ended = true
				controller.error(new DOMException('Aborted', 'AbortError'))
			}
		}, {once: true})
		sendFrame = payload => controller.enqueue(new TextEncoder().encode(`event: activity\ndata: ${JSON.stringify(payload)}\n\n`))
		return {data}
	})
})
afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	client.clear()
})

describe('conversation snapshots racing live events', () => {
	it('does not replace a completed SSE turn with an older in-flight GET', async () => {
		client.setQueryData(key, initial)
		const read = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(read.promise)
		observe()
		await flushPromises()
		sendFrame(activity())
		await flushPromises()
		expect(cached()?.turns?.[0].status).toBe('completed')
		read.resolve({data: initial})
		await flushPromises()
		expect(cached()?.turns?.[0].status).toBe('completed')
	})

	it('keeps early activity without inventing a partial conversation before the first GET', async () => {
		const read = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(read.promise)
		observe()
		await flushPromises()
		sendFrame(activity())
		sendFrame(activity({id: 't2', status: 'running'}))
		await flushPromises()
		expect(cached()).toBeUndefined()
		read.resolve({data: initial})
		await flushPromises()
		expect(cached()?.title).toBe('Server title')
		expect(cached()?.turns?.map(turn => [turn.id, turn.status])).toEqual([['t1', 'completed'], ['t2', 'running']])
	})

	it('preserves complete failed-compaction activity when an older first GET arrives afterwards', async () => {
		const read = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(read.promise)
		observe()
		await flushPromises()
		const progress = {
			batch: 1,
			batches: 3,
			attempt: 2,
			error_code: 'MODEL_OUTPUT_LIMIT',
		}
		sendFrame({
			...activity(),
			compact_progress: progress,
			compact_error: 'The model reached its output token limit.',
		})
		await flushPromises()
		read.resolve({data: finished})
		await flushPromises()
		expect(cached()?.compact_progress).toEqual(progress)
		expect(cached()?.compact_error).toBe('The model reached its output token limit.')
		expect(cached()?.turns?.[0].result?.reply).toBe('Finished')
		sendFrame({
			...activity(),
			compacting: true,
			compact_error: '',
			compact_text: '',
		})
		await flushPromises()
		expect(cached()?.compacting).toBe(true)
		expect(cached()?.compact_progress).toBeUndefined()
		expect(cached()?.compact_error).toBe('')
		expect(cached()?.turns?.[0].result?.reply).toBe('Finished')
	})

	it.each(['send', 'review'] as const)('does not replace SSE progress with a late %s acknowledgement', async kind => {
		client.setQueryData(key, initial)
		const actions = observe()
		await flushPromises()
		const post = deferred<{data: Conversation}>()
		const refetch = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(refetch.promise)
		sdk[kind === 'send' ? 'tcyAiConversationsSend' : 'tcyAiConversationsReview'].mockReturnValueOnce(post.promise)
		const pending = kind === 'send'
			? actions.send.mutateAsync({
				id: 'c1',
				body: {
					message: 'Continue',
					request_id: 'synthetic',
				},
			})
			: actions.review.mutateAsync({
				id: 'c1',
				body: {
					turn_id: 't1',
					decision: 'retry',
				},
			})
		await flushPromises()
		sendFrame(activity())
		await flushPromises()
		post.resolve({data: initial})
		await flushPromises()
		expect(cached()?.turns?.[0].status).toBe('completed')
		refetch.resolve({data: finished})
		await pending
	})

	it('does not restart tracking when an old compact acknowledgement follows its final SSE snapshot', async () => {
		client.setQueryDefaults(key, {staleTime: Infinity})
		client.setQueryData(key, {
			...finished,
			compacting: false,
		})
		const {action} = observe()
		await flushPromises()
		const post = deferred<{data: Conversation}>()
		const refetch = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(refetch.promise)
		sdk.tcyAiConversationsCompact.mockReturnValueOnce(post.promise)
		const pending = action.mutateAsync({
			id: 'c1',
			action: 'compact',
		})
		await flushPromises()
		const compactions = [{
			summary: 'Complete',
			through: 1,
		}]
		sendFrame({
			...activity(),
			compact_text: '',
			compactions,
		})
		await flushPromises()
		post.resolve({data: {
			...finished,
			compacting: true,
			compact_text: 'Old draft',
		}})
		await flushPromises()
		expect(cached()?.compacting).toBe(false)
		expect(cached()?.compactions?.[0].summary).toBe('Complete')
		expect(agentRunScope(client).live.value).toEqual([])
		refetch.resolve({data: {
			...finished,
			compacting: false,
			compactions,
		}})
		await pending
	})

	it('still accepts a genuinely later GET, including a new running turn and new metadata', async () => {
		client.setQueryData(key, initial)
		observe()
		await flushPromises()
		sendFrame(activity())
		await flushPromises()
		const later: Conversation = {
			...finished,
			title: 'Changed on another device',
			compacting: true,
			turns: [...finished.turns!, {id: 't2', status: 'running'}],
		}
		sdk.tcyAiConversationsRead.mockResolvedValueOnce({data: later})
		await client.fetchQuery({...conversationQuery('c1'), staleTime: 0})
		expect(cached()).toEqual(later)
	})

	it('keeps a new Send turn when an older GET finished during the write and its later refetch fails', async () => {
		client.setQueryDefaults(key, {staleTime: Infinity})
		client.setQueryData(key, initial)
		const {send} = observe()
		await flushPromises()
		const post = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsSend.mockReturnValueOnce(post.promise)
		const pending = send.mutateAsync({
			id: 'c1',
			body: {
				message: 'New turn',
				request_id: 'new',
			},
		})
		await flushPromises()
		sdk.tcyAiConversationsRead.mockResolvedValueOnce({data: initial})
		await client.fetchQuery({...conversationQuery('c1'), staleTime: 0})
		sdk.tcyAiConversationsRead.mockRejectedValue(new TypeError('Offline'))
		post.resolve({data: {
			...initial,
			turns: [...initial.turns!, {id: 't2', status: 'running'}],
		}})
		await pending
		expect(cached()?.turns?.map(turn => turn.id)).toEqual(['t1', 't2'])
	})

	it('preserves new unique turns from overlapping successful write snapshots', async () => {
		client.setQueryData(key, initial)
		const older = deferred<Conversation>()
		const newer = deferred<Conversation>()
		const first = writeConversationSnapshot(client, key, () => older.promise)
		const second = writeConversationSnapshot(client, key, () => newer.promise)
		newer.resolve({
			...finished,
			turns: [...finished.turns!, {id: 't2', status: 'completed'}],
		})
		await second
		older.resolve({
			...finished,
			turns: [
				...finished.turns!,
				{id: 't2', status: 'completed'},
				{id: 't3', status: 'running'},
			],
		})
		await first
		expect(cached()?.turns?.map(turn => turn.id)).toEqual(['t1', 't2', 't3'])
	})

	it('does not reapply old completed activity over a later confirmed retry when an older GET arrives last', async () => {
		client.setQueryData(key, initial)
		const read = deferred<{data: Conversation}>()
		sdk.tcyAiConversationsRead.mockReturnValueOnce(read.promise)
		observe()
		await flushPromises()
		sendFrame(activity())
		await flushPromises()
		await writeConversationSnapshot(client, key, async () => initial)
		expect(cached()?.turns?.[0].status).toBe('running')
		read.resolve({data: initial})
		await flushPromises()
		expect(cached()?.turns?.[0].status).toBe('running')
	})

	it.each(['clear', 'remove'] as const)('fences a late write after query %s without recreating the removed detail', async kind => {
		if (kind === 'remove') client.setQueryData(key, initial)
		const post = deferred<Conversation>()
		const pending = writeConversationSnapshot(client, key, () => post.promise)
		const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'})
		if (kind === 'clear') client.clear()
		else client.removeQueries({queryKey: key, exact: true})
		post.resolve(finished)
		await rejected
		expect(cached()).toBeUndefined()
		expect(client.getQueryCache().find({queryKey: key, exact: true})).toBeUndefined()
	})

	it.each(['account', 'api', 'epoch'] as const)('rejects an old response after a %s change even without component teardown', async change => {
		client.setQueryData(key, initial)
		const post = deferred<Conversation>()
		const pending = writeConversationSnapshot(client, key, () => post.promise)
		const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'})
		if (change === 'account') session.id++
		else if (change === 'api') session.api = '/other/api/v2/'
		else session.epoch++
		const next: Conversation = {
			...initial,
			title: 'Current context',
		}
		client.setQueryData(key, next)
		post.resolve(finished)
		await rejected
		expect(cached()).toEqual(next)
		sdk.tcyAiConversationsRead.mockResolvedValueOnce({data: next})
		await client.fetchQuery(conversationQuery('c1'))
		expect(cached()).toEqual(next)
	})

	it.each(['remove', 'context'] as const)('fences a fulfilled read invalidated before its cache commit by %s', async invalidation => {
		client.setQueryData(key, initial)
		const response = await readConversationSnapshot(client, key, new AbortController().signal, async () => finished)
		if (invalidation === 'remove') {
			client.removeQueries({queryKey: key, exact: true})
		} else {
			session.epoch++
			await writeConversationSnapshot(client, key, async () => initial)
		}
		expect(() => shareConversationSnapshot(initial, response)).toThrow('Conversation request was superseded')
		expect(cached()?.turns?.[0].status).toBe(invalidation === 'remove' ? undefined : 'running')
		// A later valid read can return the same object (for example, from an SDK fixture or cache).
		const fresh = await readConversationSnapshot(client, key, new AbortController().signal, async () => finished)
		expect(shareConversationSnapshot(initial, fresh)).toEqual(finished)
		// Reusing a normally committed response as a plain cache value must not mark it invalid either.
		expect(shareConversationSnapshot(initial, fresh)).toEqual(finished)
	})

	it.each(['complete', 'cancel'] as const)('releases the read abort listener on %s and ignores a cancelled SDK response', async outcome => {
		client.setQueryData(key, initial)
		const read = deferred<{data: Conversation}>()
		let remove!: ReturnType<typeof vi.spyOn>
		sdk.tcyAiConversationsRead.mockImplementationOnce(({signal}: {signal: AbortSignal}) => {
			remove = vi.spyOn(signal, 'removeEventListener')
			return read.promise
		})
		const pending = client.fetchQuery(conversationQuery('c1')).catch(cause => cause)
		await flushPromises()
		if (outcome === 'cancel') await client.cancelQueries({queryKey: key, exact: true})
		read.resolve({data: finished})
		await pending
		await flushPromises()
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
		// DOM implementations may also call removeEventListener internally for a once listener on abort.
		expect(new Set(remove.mock.calls.map((call: unknown[]) => call[1])).size).toBe(1)
		expect(cached()?.turns?.[0].status).toBe(outcome === 'complete' ? 'completed' : 'running')
		remove.mockRestore()
	})
})
