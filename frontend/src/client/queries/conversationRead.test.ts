import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises} from '@vue/test-utils'
import {QueryClient, QueryObserver} from '@tanstack/vue-query'
import type {Conversation, ConversationReadReceipt, PaginatedConversationSummary} from '@/client/generated'

const sdk = vi.hoisted(() => ({tcyAiConversationsMarkRead: vi.fn(), tcyAiConversationsList: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))

import {captureClientRequestContext} from '@/client/requestContext'
import {removeToken, saveToken} from '@/helpers/auth'
import {conversationKeys, conversationsQuery} from './tcyConversations'
import {markConversationReadMutationOptions} from './conversationRead'

function login(id = 1, marker = 'initial') {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1, marker}))}.fixture`, false)
}

function conversation(reply = 'reply-1'): Conversation {
	return {
		id: 'chat-1',
		unread: true,
		latest_reply_id: reply,
		compacting: true,
		turns: [],
	}
}

function receipt(reply = 'reply-1'): {data: ConversationReadReceipt} {
	return {data: {
		id: 'chat-1',
		latest_reply_id: reply,
		read_through_reply_id: reply,
		unread: false,
	}}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

describe('exact conversation read acknowledgements', () => {
	let client: QueryClient
	const detail = conversationKeys.detail('chat-1')
	const list = conversationKeys.list(1)

	function seed(reply = 'reply-1') {
		client.setQueryData(detail, conversation(reply))
		client.setQueryData<PaginatedConversationSummary>(list, {
			items: [
				{
					id: 'chat-1',
					unread: true,
					latest_reply_id: reply,
					running: true,
				},
				{
					id: 'chat-2',
					unread: true,
					latest_reply_id: 'other-reply',
				},
			],
			total: 2,
			page: 1,
			per_page: 25,
			total_pages: 1,
		})
	}

	function execute(replyId = 'reply-1', owner = captureClientRequestContext()) {
		return client.getMutationCache().build(client, markConversationReadMutationOptions()).execute({
			id: 'chat-1',
			replyId,
			owner,
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
		removeToken()
		login()
		window.API_URL = ''
		client = new QueryClient({defaultOptions: {
			queries: {retry: false, staleTime: Infinity},
			mutations: {retry: false},
		}})
		sdk.tcyAiConversationsMarkRead.mockResolvedValue(receipt())
	})

	afterEach(() => {
		client.clear()
		removeToken()
		window.API_URL = ''
		vi.restoreAllMocks()
	})

	it('sends the exact observed reply and patches only matching cached result versions', async () => {
		seed()
		await execute()
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledWith(expect.objectContaining({
			path: {id: 'chat-1'},
			body: {through_reply_id: 'reply-1'},
			fetch: expect.any(Function),
		}))
		expect(client.getQueryData<Conversation>(detail)).toMatchObject({unread: false, compacting: true})
		const rows = client.getQueryData<PaginatedConversationSummary>(list)!.items!
		expect(rows[0]).toMatchObject({unread: false, running: true})
		expect(rows[1]).toMatchObject({unread: true, latest_reply_id: 'other-reply'})
		expect(client.getQueryState(list)?.isInvalidated).toBe(true)
	})

	it('does not let a delayed old acknowledgement consume a newer streamed result', async () => {
		seed()
		const request = deferred<ReturnType<typeof receipt>>()
		sdk.tcyAiConversationsMarkRead.mockImplementationOnce(() => request.promise)
		const pending = execute()
		await flushPromises()
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		seed('reply-2')
		request.resolve(receipt('reply-1'))
		await pending
		expect(client.getQueryData<Conversation>(detail)).toMatchObject({latest_reply_id: 'reply-2', unread: true})
		expect(client.getQueryData<PaginatedConversationSummary>(list)!.items![0])
			.toMatchObject({latest_reply_id: 'reply-2', unread: true})
	})

	it('keeps an acknowledged exact receipt read when an already pending list GET arrives late', async () => {
		seed()
		const stale = structuredClone(client.getQueryData<PaginatedConversationSummary>(list)!)
		const request = deferred<{data: PaginatedConversationSummary}>()
		sdk.tcyAiConversationsList.mockImplementationOnce(() => request.promise)
		const pending = client.fetchQuery({...conversationsQuery(1), staleTime: 0})
		const cancelled = pending.catch(cause => cause)
		await flushPromises()
		expect(sdk.tcyAiConversationsList).toHaveBeenCalledTimes(1)
		await execute()
		const acknowledged = client.getQueryData<PaginatedConversationSummary>(list)!
		expect(acknowledged.items![0].unread).toBe(false)
		request.resolve({data: stale})
		await cancelled
		await flushPromises()
		// The commit-time merge also covers a late cached list snapshot outside that cancelled GET.
		client.setQueryData(list, stale)
		const settled = client.getQueryData<PaginatedConversationSummary>(list)!
		expect(settled).toBe(acknowledged)
		expect(settled.items![0]).toMatchObject({unread: false, latest_reply_id: 'reply-1', running: true})
		expect(settled.items![1].unread).toBe(true)
	})

	it('cancels an initial pending list and refetches active observers after acknowledging its visible reply', async () => {
		client.setQueryData(detail, conversation())
		const old = deferred<{data: PaginatedConversationSummary}>()
		const fresh = deferred<{data: PaginatedConversationSummary}>()
		sdk.tcyAiConversationsList
			.mockImplementationOnce(() => old.promise)
			.mockImplementationOnce(() => fresh.promise)
		const options = conversationsQuery(1)
		// The core observer accepts plain options rather than vue-query's ref-capable option wrapper.
		const observer = new QueryObserver(client, {queryKey: options.queryKey, queryFn: options.queryFn})
		const unsubscribe = observer.subscribe(() => undefined)
		try {
			await flushPromises()
			expect(sdk.tcyAiConversationsList).toHaveBeenCalledTimes(1)
			expect(client.getQueryData(list)).toBeUndefined()
			const acknowledged = execute()
			await flushPromises()
			expect(sdk.tcyAiConversationsList).toHaveBeenCalledTimes(2)
			old.resolve({data: {items: [{id: 'chat-1', latest_reply_id: 'reply-1', unread: true}]}})
			await flushPromises()
			expect(client.getQueryData(list)).toBeUndefined()
			fresh.resolve({data: {items: [{id: 'chat-1', latest_reply_id: 'reply-1', unread: false}]}})
			await acknowledged
			expect(client.getQueryData<PaginatedConversationSummary>(list)?.items?.[0])
				.toMatchObject({latest_reply_id: 'reply-1', unread: false})
		} finally {
			unsubscribe()
		}
	})

	it('allows a new reply or retry receipt to become unread without changing other cached row references', async () => {
		seed()
		await execute()
		const before = client.getQueryData<PaginatedConversationSummary>(list)!
		const next = structuredClone(before)
		next.items![0] = {...next.items![0], latest_reply_id: 'reply-2', unread: true}
		sdk.tcyAiConversationsList.mockResolvedValueOnce({data: next})
		await client.fetchQuery({...conversationsQuery(1), staleTime: 0})
		const after = client.getQueryData<PaginatedConversationSummary>(list)!
		expect(after.items![0]).toMatchObject({latest_reply_id: 'reply-2', unread: true})
		expect(after.items![1]).toBe(before.items![1])
	})

	it.each(['identity', 'session', 'api'] as const)('rejects an old %s owner before calling the SDK', async change => {
		seed()
		const owner = captureClientRequestContext()
		if (change === 'identity') login(2)
		if (change === 'session') {
			removeToken()
			login()
		}
		if (change === 'api') window.API_URL = 'https://another.example'
		await expect(execute('reply-1', owner)).rejects.toMatchObject({name: 'AbortError'})
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		expect(client.getQueryData<Conversation>(detail)?.unread).toBe(true)
	})

	it.each(['identity', 'session', 'api'] as const)('fences the actual fetch after SDK preparation when %s changes', async change => {
		seed()
		const prepared = deferred<void>()
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
		sdk.tcyAiConversationsMarkRead.mockImplementationOnce(async (options: {fetch: typeof globalThis.fetch}) => {
			await prepared.promise
			await options.fetch('https://task.example/api/v2/ai/conversations/chat-1/read')
			return receipt()
		})
		const pending = execute()
		const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'})
		await flushPromises()
		if (change === 'identity') login(2)
		if (change === 'session') {
			removeToken()
			login()
		}
		if (change === 'api') window.API_URL = 'https://another.example'
		prepared.resolve()
		await rejected
		expect(fetch).not.toHaveBeenCalled()
		expect(client.getQueryData<Conversation>(detail)?.unread).toBe(true)
	})

	it('drops a late response after a new login but accepts normal token refresh for the same session', async () => {
		seed()
		const late = deferred<ReturnType<typeof receipt>>()
		sdk.tcyAiConversationsMarkRead.mockImplementationOnce(() => late.promise)
		const pending = execute()
		const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'})
		await flushPromises()
		removeToken()
		login()
		late.resolve(receipt())
		await rejected
		expect(client.getQueryData<Conversation>(detail)?.unread).toBe(true)
		const refresh = deferred<ReturnType<typeof receipt>>()
		sdk.tcyAiConversationsMarkRead.mockImplementationOnce(() => refresh.promise)
		const current = execute()
		await flushPromises()
		login(1, 'rotated-jwt')
		refresh.resolve(receipt())
		await current
		expect(client.getQueryData<Conversation>(detail)?.unread).toBe(false)
	})
})
