import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {mount} from '@vue/test-utils'
import {QueryClient, QueryObserver, VueQueryPlugin} from '@tanstack/vue-query'
import type {Conversation, ConversationSummary, PaginatedConversationSummary} from '@/client/generated'

const sdk = vi.hoisted(() => {
	const conversation = async (): Promise<{data: Conversation}> => ({data: {id: 'c1', turns: []}})
	return {
		tcyAiConversationsList: vi.fn(),
		tcyAiConversationsSend: vi.fn(conversation),
		tcyAiConversationsSteer: vi.fn(conversation),
		tcyAiConversationsReview: vi.fn(conversation),
		tcyAiConversationsOrganize: vi.fn(conversation),
		tcyAiConversationsRename: vi.fn(conversation),
		tcyAiConversationsStop: vi.fn(async () => ({data: undefined})),
		tcyAiConversationsFork: vi.fn(async () => ({data: {id: 'c2', turns: []}})),
		tcyAiConversationsCompact: vi.fn(conversation),
		tcyAiAttachmentsUpload: vi.fn(async () => ({data: {id: 'f2'}})),
		tcyAiAttachmentsFromDrive: vi.fn(async () => ({data: {id: 'f3'}})),
		tcyAiAttachmentsRemove: vi.fn(async () => ({data: undefined})),
	}
})
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))

import {
	agentRunScope,
	conversationKeys,
	conversationsQuery,
	useConversationAction,
	useReviewConversation,
	useSendConversation,
	useSteerConversation,
} from './tcyConversations'
import {chatAttachmentQuery, useAttachDriveFileToChat, useRemoveChatAttachment, useUploadChatAttachment} from './chatAttachments'

function page(items: ConversationSummary[]) {
	return {data: {items, total_pages: 1}}
}

describe('conversation writes and attachment bytes', () => {
	let client: QueryClient
	const blobKey = chatAttachmentQuery('c1', 'f1', true).queryKey
	const detailKey = conversationKeys.detail('c1')

	function hooks() {
		let found!: {
			send: ReturnType<typeof useSendConversation>
			steer: ReturnType<typeof useSteerConversation>
			review: ReturnType<typeof useReviewConversation>
			action: ReturnType<typeof useConversationAction>
			upload: ReturnType<typeof useUploadChatAttachment>
			drive: ReturnType<typeof useAttachDriveFileToChat>
			remove: ReturnType<typeof useRemoveChatAttachment>
		}
		const wrapper = mount(defineComponent({
			setup() {
				found = {
					send: useSendConversation(),
					steer: useSteerConversation(),
					review: useReviewConversation(),
					action: useConversationAction(),
					upload: useUploadChatAttachment(),
					drive: useAttachDriveFileToChat(),
					remove: useRemoveChatAttachment(),
				}
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		return {
			...found,
			unmount: () => wrapper.unmount(),
		}
	}

	beforeEach(() => {
		client = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}})
	})

	it.each([
		['send', (h: ReturnType<typeof hooks>) => h.send.mutateAsync({id: 'c1', body: {message: 'Hi'} as never})],
		['steer', (h: ReturnType<typeof hooks>) => h.steer.mutateAsync({id: 'c1', body: {turn_id: 't1', request_id: 'r1', message: 'Keep the original goal, also do this'}})],
		['review', (h: ReturnType<typeof hooks>) => h.review.mutateAsync({id: 'c1', body: {decision: 'approve'}})],
		['organize', (h: ReturnType<typeof hooks>) => h.action.mutateAsync({id: 'c1', action: 'organize', pinned: true})],
		['rename', (h: ReturnType<typeof hooks>) => h.action.mutateAsync({id: 'c1', action: 'rename', title: 'New'})],
		['stop', (h: ReturnType<typeof hooks>) => h.action.mutateAsync({id: 'c1', action: 'stop'})],
		['fork', (h: ReturnType<typeof hooks>) => h.action.mutateAsync({id: 'c1', action: 'fork', turnId: 't1'})],
		['compact', (h: ReturnType<typeof hooks>) => h.action.mutateAsync({id: 'c1', action: 'compact'})],
		['upload', (h: ReturnType<typeof hooks>) => h.upload.mutateAsync({id: 'c1', file: new File(['x'], 'x.txt')})],
		['drive attach', (h: ReturnType<typeof hooks>) => h.drive.mutateAsync({id: 'c1', fileId: 4})],
		['remove draft', (h: ReturnType<typeof hooks>) => h.remove.mutateAsync({id: 'c1', file: 'f9'})],
	])('%s refreshes the conversation but not the bytes of its attachments', async (_name, run) => {
		client.setQueryData(blobKey, new Blob(['image']))
		client.setQueryData<Conversation>(detailKey, {id: 'c1', turns: []})

		await run(hooks())

		expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true)
		expect(client.getQueryState(blobKey)?.isInvalidated).toBe(false)
	})

	it.each(['send', 'review', 'compact'] as const)('tracks a successful %s even after its initiating view unmounts', async operation => {
		let resolve!: (value: {data: Conversation}) => void
		const response = new Promise<{data: Conversation}>(done => { resolve = done })
		const request = operation === 'send' ? sdk.tcyAiConversationsSend
			: operation === 'review' ? sdk.tcyAiConversationsReview : sdk.tcyAiConversationsCompact
		request.mockImplementationOnce(() => response)
		const h = hooks()
		agentRunScope(client).live.value = ['other']
		const pending = operation === 'compact'
			? h.action.mutateAsync({
				id: 'c1',
				action: 'compact',
			})
			: operation === 'send'
				? h.send.mutateAsync({
					id: 'c1',
					body: {message: 'Continue'} as never,
				})
				: h.review.mutateAsync({
					id: 'c1',
					body: {decision: 'retry'},
				})
		await vi.waitFor(() => expect(request).toHaveBeenCalled())
		h.unmount()
		resolve({data: {
			id: 'c1',
			compacting: operation === 'compact',
			turns: [{
				id: 't1',
				status: operation === 'compact' ? 'completed' : 'running',
			}],
		}})
		await pending
		expect(agentRunScope(client).live.value).toEqual(['other', 'c1'])
		const hint = sessionStorage.getItem(`arona-live:${agentRunScope(client).context}`)
		expect(JSON.parse(hint!)).toEqual(['other', 'c1'])
	})

	it.each(['rename', 'organize'] as const)('does not let a late %s response stop another active snapshot', async operation => {
		let resolve!: (value: {data: Conversation}) => void
		const response = new Promise<{data: Conversation}>(done => { resolve = done })
		const request = operation === 'rename' ? sdk.tcyAiConversationsRename : sdk.tcyAiConversationsOrganize
		request.mockImplementationOnce(() => response)
		const h = hooks()
		const pending = h.action.mutateAsync({
			id: 'c1',
			action: operation,
			title: 'Renamed',
			pinned: true,
		})
		await vi.waitFor(() => expect(request).toHaveBeenCalled())
		client.setQueryData<Conversation>(detailKey, {
			id: 'c1',
			compacting: true,
			turns: [],
		})
		agentRunScope(client).live.value = ['other', 'c1']
		resolve({data: {
			id: 'c1',
			compacting: false,
			turns: [],
		}})
		await pending
		expect(agentRunScope(client).live.value).toEqual(['other', 'c1'])
	})

	it('does not rewind stream progress when an older steering acknowledgement arrives', async () => {
		let resolve!: (value: {data: Conversation}) => void
		sdk.tcyAiConversationsSteer.mockImplementationOnce(() => new Promise(done => { resolve = done }))
		const h = hooks()
		const body = {turn_id: 't1', request_id: 'r1', message: 'Also check dates'}
		client.setQueryData<Conversation>(detailKey, {id: 'c1', turns: [{id: 't1', status: 'running'}]})
		const pending = h.steer.mutateAsync({id: 'c1', body})
		await vi.waitFor(() => expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledWith({path: {id: 'c1'}, body}))
		const completed: Conversation = {id: 'c1', turns: [{id: 't1', status: 'completed', result: {reply: 'Everything is done'}}]}
		client.setQueryData(detailKey, completed)
		resolve({data: {id: 'c1', turns: [{id: 't1', status: 'running'}]}})
		await pending
		expect(client.getQueryData(detailKey)).toEqual(completed)
	})
})

describe('conversation history polling', () => {
	let client: QueryClient
	let observers: (() => void)[] = []

	// vue-query's option type allows refs, which the core observer does not take; these options hold none.
	const plain = (options: ReturnType<typeof conversationsQuery>) => options as never
	function observe(options: ReturnType<typeof conversationsQuery>) {
		const observer = new QueryObserver<PaginatedConversationSummary>(client, plain(options))
		observers.push(observer.subscribe(() => undefined))
		return observer
	}

	beforeEach(() => {
		vi.useFakeTimers()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tcyAiConversationsList.mockReset()
	})
	afterEach(() => {
		observers.forEach(unsubscribe => unsubscribe())
		observers = []
		vi.useRealTimers()
	})

	it('does not poll while nothing runs', async () => {
		sdk.tcyAiConversationsList.mockResolvedValue(page([{id: 'c1', running: false}]))
		observe(conversationsQuery(1, '', 'active'))

		await vi.advanceTimersByTimeAsync(30_000)

		expect(sdk.tcyAiConversationsList).toHaveBeenCalledTimes(1)
	})

	it('polls while a listed conversation runs and stops once it ended', async () => {
		sdk.tcyAiConversationsList
			.mockResolvedValueOnce(page([{id: 'c1', running: true}]))
			.mockResolvedValueOnce(page([{id: 'c1', running: true}]))
			.mockResolvedValue(page([{id: 'c1', running: false}]))
		observe(conversationsQuery(1, '', 'active'))

		await vi.advanceTimersByTimeAsync(30_000)

		expect(sdk.tcyAiConversationsList).toHaveBeenCalledTimes(3)
	})

	it('keeps rows on screen for another page, but not under another scope or search', async () => {
		sdk.tcyAiConversationsList.mockResolvedValueOnce(page([{id: 'active-chat'}]))
		const observer = observe(conversationsQuery(1, '', 'active'))
		await vi.advanceTimersByTimeAsync(0)
		sdk.tcyAiConversationsList.mockReturnValue(new Promise(() => undefined))

		observer.setOptions(plain(conversationsQuery(2, '', 'active')))
		expect(observer.getCurrentResult().data?.items?.[0]?.id).toBe('active-chat')

		observer.setOptions(plain(conversationsQuery(1, '', 'archived')))
		expect(observer.getCurrentResult().data).toBeUndefined()

		observer.setOptions(plain(conversationsQuery(1, 'plan', 'all')))
		expect(observer.getCurrentResult().data).toBeUndefined()
	})

	it('leaves load errors to the history panel', () => {
		expect(conversationsQuery(1).meta?.handlesError).toBe(true)
	})
})
