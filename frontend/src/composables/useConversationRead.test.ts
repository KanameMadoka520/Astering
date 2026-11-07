import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, nextTick, ref} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import type {Conversation} from '@/client/generated'

const sdk = vi.hoisted(() => ({tcyAiConversationsMarkRead: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))

import {removeToken, saveToken} from '@/helpers/auth'
import {conversationKeys} from '@/client/queries/tcyConversations'
import {useConversationRead} from './useConversationRead'

class ReadObserver {
	static all: ReadObserver[] = []
	targets = new Set<Element>()
	disconnect = vi.fn(() => { this.targets.clear() })
	constructor(private callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
		ReadObserver.all.push(this)
	}
	observe(target: Element) { this.targets.add(target) }
	unobserve(target: Element) { this.targets.delete(target) }
	// Queued browser callbacks can still arrive after disconnect; tests may report
	// an old target explicitly to exercise that race rather than hiding it here.
	report(target: Element, visible = true, ratio = visible ? 1 : 0) {
		this.callback([{
			target,
			isIntersecting: visible,
			intersectionRatio: ratio,
		} as IntersectionObserverEntry], this as unknown as IntersectionObserver)
	}
}

function login(id = 1) {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1}))}.fixture`, false)
}

function chat(id = 'chat-1', reply = 'reply-1'): Conversation {
	return {
		id,
		unread: true,
		latest_reply_id: reply,
		turns: [],
	}
}

// happy-dom implements showModal() as show(), and does not recognize :modal.
// Keep native open/close events while supplying the missing top-layer selector for this fixture only.
function modalDialog() {
	const dialog = document.createElement('dialog')
	const matches = dialog.matches.bind(dialog)
	vi.spyOn(dialog, 'matches').mockImplementation(selector => selector === ':modal' ? dialog.open : matches(selector))
	document.body.append(dialog)
	return dialog
}

describe('visible conversation result acknowledgement', () => {
	let client: QueryClient
	let wrappers: VueWrapper[]

	function harness({presenting = true}: {presenting?: boolean} = {}) {
		const initial = chat()
		const conversation = ref<Conversation | undefined>(initial)
		const presented = ref(presenting)
		const sentinel = ref<HTMLElement>(document.createElement('div'))
		const scrollRoot = ref<HTMLElement>(document.createElement('section'))
		client.setQueryData(conversationKeys.detail('chat-1'), initial)
		const wrapper = mount(defineComponent({
			setup() {
				useConversationRead({
					conversation,
					presenting: presented,
					sentinel,
					scrollRoot,
				})
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		wrappers.push(wrapper)
		return {
			conversation,
			presented,
			sentinel,
			scrollRoot,
			wrapper,
			observer: () => ReadObserver.all[ReadObserver.all.length - 1],
		}
	}

	async function advance(ms: number) {
		await nextTick()
		await vi.advanceTimersByTimeAsync(ms)
		await flushPromises()
		await nextTick()
	}

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']})
		vi.clearAllMocks()
		ReadObserver.all = []
		vi.stubGlobal('IntersectionObserver', ReadObserver)
		removeToken()
		login()
		window.API_URL = ''
		client = new QueryClient({defaultOptions: {
			queries: {retry: false, staleTime: Infinity},
			mutations: {retry: false},
		}})
		wrappers = []
		sdk.tcyAiConversationsMarkRead.mockImplementation(async (options: {path: {id: string}, body: {through_reply_id: string}}) => ({
			data: {
				id: options.path.id,
				latest_reply_id: options.body.through_reply_id,
				read_through_reply_id: options.body.through_reply_id,
				unread: false,
			},
		}))
	})

	afterEach(() => {
		wrappers.forEach(wrapper => wrapper.unmount())
		client.clear()
		removeToken()
		window.API_URL = ''
		vi.clearAllTimers()
		vi.useRealTimers()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('waits for the fully visible reply end for 700 ms and sends the exact result version', async () => {
		const view = harness()
		await nextTick()
		expect(view.observer().options).toMatchObject({root: view.scrollRoot.value, threshold: 1})
		await advance(1000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.observer().report(view.sentinel.value, true, 0.25)
		await advance(1000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.observer().report(view.sentinel.value)
		await advance(699)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		await advance(1)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledWith(expect.objectContaining({
			path: {id: 'chat-1'},
			body: {through_reply_id: 'reply-1'},
		}))
		expect(client.getQueryData<Conversation>(conversationKeys.detail('chat-1'))?.unread).toBe(false)
	})

	it('does not acknowledge a fetched conversation in a hidden or minimized assistant', async () => {
		const view = harness({presenting: false})
		await nextTick()
		view.observer().report(view.sentinel.value)
		await advance(2000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.presented.value = true
		await advance(699)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.presented.value = false
		await advance(1000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.presented.value = true
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
	})

	it('requires continuous visibility and restarts the delay after scrolling back', async () => {
		const view = harness()
		await nextTick()
		view.observer().report(view.sentinel.value)
		await advance(600)
		view.observer().report(view.sentinel.value, false)
		await advance(1000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.observer().report(view.sentinel.value)
		await advance(699)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		await advance(1)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
	})

	it('keeps a reply unread behind a native image or export dialog, then waits again after closing', async () => {
		const view = harness()
		const dialog = modalDialog()
		try {
			await nextTick()
			view.observer().report(view.sentinel.value)
			await advance(400)
			dialog.showModal()
			await advance(1500)
			expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
			dialog.close()
			await advance(699)
			expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
			await advance(1)
			expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		} finally {
			dialog.remove()
		}
	})

	it('allows reading the floating assistant inside the task dialog that contains it', async () => {
		const view = harness()
		const dialog = modalDialog()
		dialog.append(view.scrollRoot.value)
		view.scrollRoot.value.append(view.sentinel.value)
		try {
			dialog.showModal()
			await nextTick()
			view.observer().report(view.sentinel.value)
			await advance(700)
			expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		} finally {
			dialog.remove()
		}
	})

	it('cancels a pending result version when a newer reply arrives in the same conversation', async () => {
		const view = harness()
		await nextTick()
		view.observer().report(view.sentinel.value)
		await advance(600)
		view.conversation.value = chat('chat-1', 'reply-2')
		await advance(100)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		await advance(600)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledWith(expect.objectContaining({
			body: {through_reply_id: 'reply-2'},
		}))
	})

	it('ignores a queued old observer callback after switching the conversation and its sentinel', async () => {
		const view = harness()
		await nextTick()
		const oldObserver = view.observer()
		const oldSentinel = view.sentinel.value
		oldObserver.report(oldSentinel)
		await advance(600)
		view.conversation.value = chat('chat-2', 'other-result')
		view.sentinel.value = document.createElement('div')
		await nextTick()
		expect(oldObserver.disconnect).toHaveBeenCalled()
		oldObserver.report(oldSentinel)
		await advance(1000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
		view.observer().report(view.sentinel.value)
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledWith(expect.objectContaining({
			path: {id: 'chat-2'},
			body: {through_reply_id: 'other-result'},
		}))
	})

	it.each(['identity', 'session', 'api'] as const)('does not send a visibility timer owned by an old %s', async change => {
		const view = harness()
		await nextTick()
		view.observer().report(view.sentinel.value)
		await advance(600)
		if (change === 'identity') login(2)
		if (change === 'session') {
			removeToken()
			login()
		}
		if (change === 'api') window.API_URL = 'https://another.example'
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
	})

	it('does not retry a failed result indefinitely, but retries after reconnect or reopening', async () => {
		const view = harness()
		sdk.tcyAiConversationsMarkRead.mockRejectedValue(new Error('isolated offline request'))
		await nextTick()
		view.observer().report(view.sentinel.value)
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		view.observer().report(view.sentinel.value, false)
		await advance(100)
		view.observer().report(view.sentinel.value)
		await advance(5000)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(1)
		window.dispatchEvent(new Event('online'))
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(2)
		view.presented.value = false
		await nextTick()
		view.presented.value = true
		await advance(700)
		expect(sdk.tcyAiConversationsMarkRead).toHaveBeenCalledTimes(3)
	})

	it('disconnects the observer, timer and reconnect listener when leaving the view', async () => {
		const view = harness()
		await nextTick()
		const observer = view.observer()
		const sentinel = view.sentinel.value
		observer.report(sentinel)
		await advance(600)
		view.wrapper.unmount()
		wrappers = []
		expect(observer.disconnect).toHaveBeenCalled()
		observer.report(sentinel)
		window.dispatchEvent(new Event('online'))
		await advance(2000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
	})

	it('keeps unread state when intersection observation is unavailable', async () => {
		vi.stubGlobal('IntersectionObserver', undefined)
		harness()
		await advance(2000)
		expect(sdk.tcyAiConversationsMarkRead).not.toHaveBeenCalled()
	})
})
