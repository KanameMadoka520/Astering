import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getCurrentInstance, nextTick, type MaybeRefOrGetter} from 'vue'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, shallowMount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

const never = vi.hoisted(() => () => new Promise(() => undefined))
const sdk = vi.hoisted(() => ({
	tcyAiConversationsRead: vi.fn<(options: {path: {id: string}}) => Promise<unknown>>(never),
	tcyAiConversationsList: vi.fn(never),
	tcyAiConversationsCreate: vi.fn(never),
	tcyAiConversationsSend: vi.fn(never),
	tcyAiSettings: vi.fn(never),
	tcyAiPreferences: vi.fn(never),
	tcyAiPrompt: vi.fn(never),
}))
vi.mock('@/client/generated', () => sdk)
const stream = vi.hoisted(() => ({id: undefined as undefined | (() => string)}))
vi.mock('@/client/queries/conversationEvents', async () => {
	const {ref: makeRef, toValue: read} = await import('vue')
	return {
		useConversationEvents(id: MaybeRefOrGetter<string>) {
			stream.id = () => read(id)
			return {connected: makeRef(false)}
		},
	}
})
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projectsArray: []})}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: vi.fn(),
	getErrorText: (cause: Error) => cause.message,
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string, params?: object) => params ? `${key} ${JSON.stringify(params)}` : key,
		n: String,
	}),
}))

import type {ChatTurn, Conversation} from '@/client/generated'
import {agentRunScope, conversationKeys} from '@/client/queries/tcyConversations'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import {assistantPreferencesQuery} from '@/client/queries/assistantPreferences'
import AronaWelcome from '@/components/ai/AronaWelcome.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import ChatThread from '@/components/ai/ChatThread.vue'
import ConversationHistory from '@/components/ai/ConversationHistory.vue'
import ConversationMenu from '@/components/ai/ConversationMenu.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import TcyAssistant from './TcyAssistant.vue'

enableAutoUnmount(afterEach)

const CHAT = 'c1'

function streamingTurn(reply: string, status: ChatTurn['status'] = 'running'): ChatTurn {
	return {
		id: 't2',
		request_id: 'r2',
		prompt: 'Write it',
		status,
		result: {reply, stage: 'model'},
	}
}

function conversation(last: ChatTurn): Conversation {
	return {
		id: CHAT,
		title: 'Plans',
		turns: [
			{
				id: 't1',
				request_id: 'r1',
				prompt: 'Hello',
				status: 'completed',
				result: {reply: 'Hi'},
			},
			last,
		],
	}
}

describe('TcyAssistant presentation', () => {
	let client: QueryClient
	let rootUpdates = 0

	// What the event stream does with each frame: an immutable replacement of the cached conversation.
	function frame(last: ChatTurn) {
		client.setQueryData<Conversation>(conversationKeys.detail(CHAT), current => current && {
			...current,
			turns: [current.turns![0], last],
		})
	}
	function shownTurns(wrapper: ReturnType<typeof mountAssistant>) {
		return wrapper.findComponent(ChatThread).props('readTurns')()
	}
	function mountAssistant(presenting: boolean, last = streamingTurn('One')) {
		client.setQueryData(conversationKeys.detail(CHAT), conversation(last))
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{
				path: '/',
				name: 'home',
				component: {render: () => null},
			}],
		})
		return shallowMount(TcyAssistant, {
			props: {
				embedded: true,
				conversationId: CHAT,
				presenting,
			},
			global: {
				plugins: [[VueQueryPlugin, {queryClient: client}], router, createPinia()],
				mixins: [{
					updated() {
						if (getCurrentInstance()?.type.__name === 'TcyAssistant') rootUpdates++
					},
				}],
			},
		})
	}
	function setVisibility(state: DocumentVisibilityState) {
		Object.defineProperty(document, 'visibilityState', {
			value: state,
			configurable: true,
		})
		document.dispatchEvent(new Event('visibilitychange'))
	}

	beforeEach(() => {
		rootUpdates = 0
		stream.id = undefined
		client = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}})
		client.setQueryData(aiSettingsQuery().queryKey, {
			connections: [{
				id: 'm1',
				kind: 'chat',
				name: 'Model',
			}],
			assistant: 'm1',
		} as never)
		client.setQueryData(assistantPreferencesQuery().queryKey, {
			profiles: [],
			default_profile: 'ask',
		})
	})
	afterEach(() => {
		setVisibility('visible')
	})

	it('holds the thread while minimized and shows the latest turns at once when opened', async () => {
		const wrapper = mountAssistant(false)
		// Mounted minimized: nothing is rendered until the panel opens.
		expect(shownTurns(wrapper)).toEqual([])

		await wrapper.setProps({presenting: true})
		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe('One')

		await wrapper.setProps({presenting: false})
		for (const reply of ['One two', 'One two three']) {
			frame(streamingTurn(reply))
			await nextTick()
		}
		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe('One')

		await wrapper.setProps({presenting: true})
		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe('One two three')
	})

	it('holds the thread while the browser tab is hidden', async () => {
		const wrapper = mountAssistant(true)
		setVisibility('hidden')
		await nextTick()
		frame(streamingTurn('One two'))
		await nextTick()
		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe('One')

		setVisibility('visible')
		await nextTick()
		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe('One two')
	})

	it('streams an idle conversation only while it is shown, and running work always', async () => {
		const wrapper = mountAssistant(true, streamingTurn('Done', 'completed'))
		expect(stream.id?.()).toBe(CHAT)

		await wrapper.setProps({presenting: false})
		expect(stream.id?.()).toBe('')

		// A run keeps its stream behind the minimized panel, so its receipts still refresh the page.
		frame(streamingTurn('Again'))
		await nextTick()
		expect(stream.id?.()).toBe(CHAT)

		frame(streamingTurn('Again, done', 'completed'))
		await nextTick()
		expect(stream.id?.()).toBe('')

		await wrapper.setProps({presenting: true})
		expect(stream.id?.()).toBe(CHAT)
	})

	it('does not re-render the whole view for a streamed frame', async () => {
		const wrapper = mountAssistant(true)
		await nextTick()
		const menu = wrapper.findComponent(ConversationMenu)
		const summary = menu.props('conversation')
		rootUpdates = 0

		for (let index = 1; index <= 10; index++) {
			frame(streamingTurn(`One ${'word '.repeat(index)}`))
			await nextTick()
		}

		expect(shownTurns(wrapper).at(-1)?.result?.reply).toBe(`One ${'word '.repeat(10)}`)
		expect(rootUpdates).toBe(0)
		expect(menu.props('conversation')).toBe(summary)
	})

	it('refreshes the history once when the open conversation\'s run ends', async () => {
		mountAssistant(true)
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const listRefreshes = () => invalidate.mock.calls
			.filter(([filters]) => JSON.stringify((filters as {queryKey?: unknown} | undefined)?.queryKey)
				=== JSON.stringify(conversationKeys.lists()))
			.length

		frame(streamingTurn('One two'))
		await nextTick()
		expect(listRefreshes()).toBe(0)

		frame(streamingTurn('One two three', 'completed'))
		await nextTick()
		expect(listRefreshes()).toBe(1)
	})

	it('asks for attention while a paused turn waits for the user', async () => {
		const paused = streamingTurn('Shall I?', 'awaiting_approval')
		const wrapper = mountAssistant(false, {...paused, result: {...paused.result, pause: 'review'}})
		expect(wrapper.emitted('attention')?.at(-1)).toEqual([true])
		expect(wrapper.emitted('activity')?.at(-1)).toEqual([false])

		frame(streamingTurn('Approved, working'))
		await nextTick()
		expect(wrapper.emitted('attention')?.at(-1)).toEqual([false])
		expect(wrapper.emitted('activity')?.at(-1)).toEqual([true])
	})
})

describe('TcyAssistant composer', () => {
	let client: QueryClient
	let router: ReturnType<typeof createRouter>

	function seedSettings() {
		client.setQueryData(aiSettingsQuery().queryKey, {
			connections: [{
				id: 'm1',
				kind: 'chat',
				name: 'Model',
			}],
			assistant: 'm1',
		} as never)
	}
	function seedPreferences() {
		client.setQueryData(assistantPreferencesQuery().queryKey, {
			profiles: [],
			default_profile: 'ask',
		})
	}
	function seedConversation(id: string, status: ChatTurn['status'] = 'completed', title = 'Plans') {
		client.setQueryData<Conversation>(conversationKeys.detail(id), {
			id,
			title,
			turns: [{
				id: `${id}-t1`,
				request_id: `${id}-r1`,
				prompt: 'Hello',
				status,
				result: {reply: 'Hi'},
			}],
		})
	}
	const plugins = () => [[VueQueryPlugin, {queryClient: client}], router, createPinia()] as never
	// The floating panel: the parent keeps the conversation id.
	function mountPanel(conversationId: string) {
		const wrapper = shallowMount(TcyAssistant, {
			props: {
				embedded: true,
				conversationId,
				'onUpdate:conversationId': (id: string) => wrapper.setProps({conversationId: id}),
			},
			global: {plugins: plugins()},
		})
		return wrapper
	}
	// The full page reads the conversation from the route.
	function mountPage() {
		return shallowMount(TcyAssistant, {global: {plugins: plugins()}})
	}
	const composer = (wrapper: ReturnType<typeof mountPanel>) => wrapper.find('textarea')
	async function openFromHistory(wrapper: ReturnType<typeof mountPanel>, id: string) {
		if (!wrapper.findComponent(ConversationHistory).exists()) {
			// As on a touch screen: the stubbed history has no search field to focus.
			const media = vi.spyOn(window, 'matchMedia').mockReturnValue({matches: false} as MediaQueryList)
			wrapper.findComponent<typeof BaseButton>('[aria-label="chat.conversations"]').vm.$emit('click', new MouseEvent('click'))
			await flushPromises()
			media.mockRestore()
		}
		wrapper.findComponent(ConversationHistory).vm.$emit('select', id)
		await flushPromises()
	}
	const loadErrors = (wrapper: ReturnType<typeof mountPanel>) => wrapper.findAllComponents(LoadError)
		.map(error => error.props('message'))

	beforeEach(async () => {
		sessionStorage.clear()
		agentRunScope(new QueryClient()).live.value = ''
		client = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}})
		for (const fn of Object.values(sdk)) fn.mockReset().mockImplementation(never)
		router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: '/ai',
					name: 'tcy-ai',
					component: {render: () => null},
				},
				{
					path: '/project',
					name: 'project',
					component: {render: () => null},
				},
			],
		})
		await router.push('/project')
	})

	it('uses the default options when the preferences fail to load, and offers a retry', async () => {
		seedSettings()
		sdk.tcyAiPreferences.mockRejectedValue(new Error('offline'))
		const wrapper = mountPanel('')
		await flushPromises()

		expect(wrapper.find('.profile-switch select').attributes('disabled')).toBeUndefined()
		expect(wrapper.find('.preferences-toggle').attributes('disabled')).toBe('false')
		expect(loadErrors(wrapper)).toEqual(['assistantUI.preferencesLoadFailed'])
	})

	it('reports a failed settings load instead of asking to set up a model', async () => {
		seedPreferences()
		sdk.tcyAiSettings.mockRejectedValue(new Error('offline'))
		const wrapper = mountPanel('')
		await flushPromises()

		expect(wrapper.findComponent(AronaWelcome).props('needsSetup')).toBe(false)
		expect(loadErrors(wrapper)).toEqual(['assistantUI.settingsLoadFailed'])
	})

	it('shows a placeholder, not the welcome, while a conversation loads', async () => {
		seedSettings()
		seedPreferences()
		const wrapper = mountPanel('c1')
		await flushPromises()

		expect(wrapper.find('.thread-skeleton[role="status"]').exists()).toBe(true)
		expect(wrapper.findComponent(AronaWelcome).exists()).toBe(false)
	})

	it('keeps a typed request through Expand and a visit to another page', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		const panel = mountPanel('c1')
		await composer(panel).setValue('Plan my week')
		panel.unmount()

		await router.push('/ai?chat=c1')
		const page = mountPage()
		await flushPromises()
		expect((composer(page).element as HTMLTextAreaElement).value).toBe('Plan my week')

		// Leaving /ai clears the chat in the route before the view unmounts.
		await router.push('/project')
		page.unmount()
		await router.push('/ai?chat=c1')
		const again = mountPage()
		await flushPromises()
		expect((composer(again).element as HTMLTextAreaElement).value).toBe('Plan my week')
	})

	it('keeps one draft per conversation and drops it once sent', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		seedConversation('c2')
		sdk.tcyAiConversationsSend.mockImplementation(async () => ({data: {id: 'c2', turns: []}}))
		// The send refreshes the conversation; the server returns what the cache holds.
		sdk.tcyAiConversationsRead.mockImplementation(async ({path}) => ({
			data: client.getQueryData(conversationKeys.detail(path.id)),
		}))
		const wrapper = mountPanel('c1')
		await flushPromises()
		await composer(wrapper).setValue('For the first')

		await openFromHistory(wrapper, 'c2')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('')
		await composer(wrapper).setValue('For the second')
		await wrapper.find('form.composer').trigger('submit')
		await flushPromises()
		expect(sdk.tcyAiConversationsSend).toHaveBeenCalledTimes(1)

		await openFromHistory(wrapper, 'c1')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('For the first')
		await openFromHistory(wrapper, 'c2')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('')
	})

	it('starts a new chat when the open conversation is gone', async () => {
		seedSettings()
		seedPreferences()
		sdk.tcyAiConversationsRead.mockRejectedValue(Object.assign(new Error('Not found'), {status: 404}))
		const wrapper = mountPanel('deleted')
		await flushPromises()

		expect(wrapper.emitted('update:conversationId')?.at(-1)).toEqual([''])
		expect(wrapper.find('.notice').text()).toContain('assistantUI.conversationGone')
	})

	it('does not create a conversation while another one runs, and points to it', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('busy', 'running', 'Weekly review')
		agentRunScope(client).live.value = 'busy'
		const wrapper = mountPanel('')
		await flushPromises()
		await composer(wrapper).setValue('Another request')

		await wrapper.find('form.composer').trigger('submit')
		await flushPromises()

		expect(sdk.tcyAiConversationsCreate).not.toHaveBeenCalled()
		const note = wrapper.find('.running-elsewhere')
		expect(note.text()).toContain('"title":"Weekly review"')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('Another request')
	})

	it('names a dropped stream as reconnecting unless the conversation is polled', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		const wrapper = mountPanel('c1')
		await flushPromises()
		expect(wrapper.find('.live-label').text()).toBe('assistantUI.statusReconnecting')

		seedConversation('c1', 'running')
		await flushPromises()
		expect(wrapper.find('.live-label').text()).toBe('assistantUI.statusPolling')
	})
})
