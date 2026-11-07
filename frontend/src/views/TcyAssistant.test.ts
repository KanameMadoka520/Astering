import {afterEach, beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest'
import {defineComponent, getCurrentInstance, nextTick, type Component, type MaybeRefOrGetter} from 'vue'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, shallowMount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

const never = vi.hoisted(() => () => new Promise(() => undefined))
type SteerBody = {turn_id: string, request_id: string, message: string}
const sdk = vi.hoisted(() => ({
	tcyAiConversationsRead: vi.fn<(options: {path: {id: string}}) => Promise<unknown>>(never),
	tcyAiConversationsList: vi.fn(never),
	tcyAiConversationsCreate: vi.fn(never),
	tcyAiAttachmentsUpload: vi.fn(never),
	tcyAiConversationsSend: vi.fn(never),
	tcyAiConversationsSteer: vi.fn<(options: {path: {id: string}, body: SteerBody}) => Promise<unknown>>(never),
	tcyAiConversationsStop: vi.fn(never),
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
import {removeToken, saveToken} from '@/helpers/auth'
import {useAuthStore} from '@/stores/auth'
import {useSteeringOutbox} from '@/components/ai/steeringOutbox'
import {agentRunScope, conversationKeys} from '@/client/queries/tcyConversations'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import {assistantPreferencesQuery} from '@/client/queries/assistantPreferences'
import AronaWelcome from '@/components/ai/AronaWelcome.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import ChatThread from '@/components/ai/ChatThread.vue'
import ConversationHistory from '@/components/ai/ConversationHistory.vue'
import ConversationMenu from '@/components/ai/ConversationMenu.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import AssistantPreferences from '@/components/ai/AssistantPreferences.vue'
import ToolModulePicker from '@/components/ai/ToolModulePicker.vue'
import MCPSessionPicker from '@/components/ai/MCPSessionPicker.vue'
import {profileOptions} from '@/helpers/assistantProfiles'
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
	function mountPanel(conversationId: string, stubs: Record<string, Component> = {}, attachTo?: HTMLElement) {
		const wrapper = shallowMount(TcyAssistant, {
			props: {
				embedded: true,
				conversationId,
				'onUpdate:conversationId': (id: string) => wrapper.setProps({conversationId: id}),
			},
			global: {
				plugins: plugins(),
				stubs: {
					Modal: defineComponent({template: '<div><slot /></div>'}),
					...stubs,
				},
			},
			attachTo,
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
	async function openConfiguration(wrapper: ReturnType<typeof mountPanel>) {
		wrapper.findComponent<typeof BaseButton>('.composer-config-trigger').vm.$emit('click', new MouseEvent('click'))
		await nextTick()
	}

	beforeEach(async () => {
		sessionStorage.clear()
		agentRunScope(new QueryClient()).live.value = []
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
		await openConfiguration(wrapper)

		expect(wrapper.find('.profile-switch select').attributes('disabled')).toBeUndefined()
		expect(wrapper.find('.preferences-toggle').attributes('disabled')).toBe('false')
		expect(loadErrors(wrapper)).toEqual(['assistantUI.preferencesLoadFailed'])
	})

	it.each([
		['a running turn', {turns: [streamingTurn('One')]}],
		['a paused review', {turns: [{
			...streamingTurn('One', 'awaiting_approval'),
			result: {pause: 'review'},
		}]}],
		['compaction', {compacting: true}],
		['an archived conversation', {archived: true}],
	] satisfies [string, Partial<Conversation>][])('locks all composer execution settings during %s', async (_name, state) => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		client.setQueryData<Conversation>(conversationKeys.detail('c1'), current => ({
			...current!,
			...state,
		}))
		const wrapper = mountPanel('c1')
		await flushPromises()
		await openConfiguration(wrapper)

		expect(wrapper.findComponent(ToolModulePicker).props('disabled')).toBe(true)
		expect(wrapper.findComponent(MCPSessionPicker).props('disabled')).toBe(true)
		expect(wrapper.find('.profile-switch select').attributes('disabled')).toBeDefined()
		expect(wrapper.find('.model-switch select').attributes('disabled')).toBeDefined()
		expect(wrapper.find('.preferences-toggle').attributes('disabled')).toBe('true')
		// A delayed component event must not bypass the disabled entry point.
		wrapper.findComponent<typeof BaseButton>('.preferences-toggle').vm.$emit('click', new MouseEvent('click'))
		await nextTick()
		expect(wrapper.findComponent(AssistantPreferences).exists()).toBe(false)
	})

	it('rejects an already-open preferences apply and a delayed scenario event after a run starts', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		const wrapper = mountPanel('c1')
		await flushPromises()
		await openConfiguration(wrapper)
		wrapper.findComponent<typeof BaseButton>('.preferences-toggle').vm.$emit('click', new MouseEvent('click'))
		await nextTick()
		const panel = wrapper.findComponent(AssistantPreferences)
		expect(panel.props('locked')).toBeFalsy()
		const original = {...wrapper.findComponent(ToolModulePicker).props('modules')}

		seedConversation('c1', 'running')
		await flushPromises()
		expect(panel.props('locked')).toBe(true)
		const next = {
			...profileOptions('assist'),
			tool_modules: {
				project_tasks: 'off',
				compass: 'write',
			} as const,
		}
		panel.vm.$emit('apply', next, '')
		const scenario = wrapper.find('.profile-switch select').element as HTMLSelectElement
		scenario.value = 'assist'
		scenario.dispatchEvent(new Event('change', {bubbles: true}))
		await nextTick()
		expect(wrapper.findComponent(ToolModulePicker).props('modules')).toEqual(original)
		expect(panel.props('profile')).toBe('ask')
		expect(panel.props('options').mode).toBe('read')
		expect(Object.keys(sessionStorage).filter(key => key.startsWith('tcy-ai-options:'))).toEqual([])

		seedConversation('c1')
		await flushPromises()
		panel.vm.$emit('apply', next, '')
		await nextTick()
		expect(wrapper.findComponent(ToolModulePicker).props('modules')).toEqual(next.tool_modules)
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

	it('restores each draft when a conversation link or browser history changes the route', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c1')
		seedConversation('c2')
		await router.push('/ai?chat=c1')
		const wrapper = mountPage()
		await flushPromises()
		await composer(wrapper).setValue('Draft for the first conversation')
		await openFromHistory(wrapper, 'c2')
		await composer(wrapper).setValue('Draft for the second conversation')

		// Ordinary links in assistant messages use router.push, not the history-list handler.
		await router.push('/ai?chat=c1')
		await flushPromises()
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('Draft for the first conversation')
		router.back()
		await flushPromises()
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('Draft for the second conversation')
		router.forward()
		await flushPromises()
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('Draft for the first conversation')
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

	it('allows a new conversation while another one runs', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('busy', 'running', 'Weekly review')
		agentRunScope(client).live.value = ['busy']
		const wrapper = mountPanel('')
		await flushPromises()
		await composer(wrapper).setValue('Another request')

		await wrapper.find('form.composer').trigger('submit')
		await flushPromises()

		expect(sdk.tcyAiConversationsCreate).toHaveBeenCalledTimes(1)
		expect(wrapper.find('.running-elsewhere').exists()).toBe(false)
	})

	it('carries a new-chat draft into the id created by its first upload, without copying it to another chat', async () => {
		seedSettings()
		seedPreferences()
		seedConversation('c2')
		sdk.tcyAiConversationsCreate.mockImplementation(async () => ({data: {id: 'created', turns: []}}))
		sdk.tcyAiAttachmentsUpload.mockImplementation(async () => ({data: {id: 'file'}}))
		sdk.tcyAiConversationsRead.mockImplementation(async ({path}) => ({
			data: client.getQueryData(conversationKeys.detail(path.id)) || {id: path.id, turns: []},
		}))
		const wrapper = mountPanel('')
		await flushPromises()
		await composer(wrapper).setValue('My upload belongs with this unsent request.')
		const input = wrapper.get('.composer input[type="file"]').element as HTMLInputElement
		Object.defineProperty(input, 'files', {value: [new File(['notes'], 'notes.txt', {type: 'text/plain'})], configurable: true})
		await wrapper.get('.composer input[type="file"]').trigger('change')
		await flushPromises()
		expect(sdk.tcyAiConversationsCreate).toHaveBeenCalledTimes(1)
		expect(sdk.tcyAiAttachmentsUpload).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'created'}}))
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('My upload belongs with this unsent request.')
		await openFromHistory(wrapper, 'c2')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('')
		await openFromHistory(wrapper, 'created')
		expect((composer(wrapper).element as HTMLTextAreaElement).value).toBe('My upload belongs with this unsent request.')
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

	describe('steering a running turn', () => {
		const RUN = 'c1-run'
		function deferred<T = unknown>() {
			let resolve!: (value: T) => void
			let reject!: (cause: unknown) => void
			const promise = new Promise<T>((done, fail) => {
				resolve = done
				reject = fail
			})
			return {promise, resolve, reject}
		}
		function seedRun(id = 'c1', conversation: Partial<Conversation> = {}, turn: Partial<ChatTurn> = {}) {
			client.setQueryData<Conversation>(conversationKeys.detail(id), {
				id,
				title: 'Plans',
				turns: [
					{
						id: `${id}-t1`,
						request_id: `${id}-r1`,
						prompt: 'Hello',
						status: 'completed',
						result: {reply: 'Hi'},
					},
					{
						id: `${id}-run`,
						request_id: `${id}-r2`,
						prompt: 'Tidy my week',
						status: 'running',
						result: {stage: 'model'},
						...turn,
					},
				],
				...conversation,
			})
		}
		// A refetch answers with what the cache holds, as the server would for an unchanged conversation.
		function serveCache() {
			sdk.tcyAiConversationsRead.mockImplementation(async ({path}) => ({
				data: client.getQueryData(conversationKeys.detail(path.id)),
			}))
		}
		async function mountRunning(
			conversation: Partial<Conversation> = {},
			turn: Partial<ChatTurn> = {},
			stubs: Record<string, Component> = {},
			attachTo?: HTMLElement,
		) {
			seedSettings()
			seedPreferences()
			seedRun('c1', conversation, turn)
			serveCache()
			const wrapper = mountPanel('c1', stubs, attachTo)
			await flushPromises()
			return wrapper
		}
		const value = (wrapper: ReturnType<typeof mountPanel>) => (composer(wrapper).element as HTMLTextAreaElement).value
		async function enter(wrapper: ReturnType<typeof mountPanel>, init: KeyboardEventInit = {}) {
			await composer(wrapper).trigger('keydown', {key: 'Enter', ...init})
			await flushPromises()
		}
		const steerBodies = () => sdk.tcyAiConversationsSteer.mock.calls.map(([options]) => options.body)
		const networkError = () => new TypeError('Failed to fetch')

		const signIn = (id: number) => saveToken(`header.${btoa(JSON.stringify({id, type: 1}))}.signature`, false)
		beforeEach(() => {
			signIn(7)
		})
		afterEach(() => {
			removeToken()
		})

		it('adds the text to the running turn instead of starting a new run', async () => {
			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			const wrapper = await mountRunning()
			expect(composer(wrapper).attributes('placeholder')).toBe('aronaSteer.placeholder')
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.hint')

			await composer(wrapper).setValue('  Also check due dates\n')
			await enter(wrapper)

			expect(sdk.tcyAiConversationsSend).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsCreate).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledTimes(1)
			const [{path, body}] = sdk.tcyAiConversationsSteer.mock.calls[0]
			expect(path).toEqual({id: 'c1'})
			// Only the instruction: the run keeps its own model, permissions and budgets.
			expect(Object.keys(body).sort()).toEqual(['message', 'request_id', 'turn_id'])
			expect(body).toEqual({
				turn_id: RUN,
				request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
				message: 'Also check due dates',
			})
			expect(value(wrapper)).toBe('')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
		})

		it('adds on Enter only, not on Shift+Enter or while an input method composes', async () => {
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')

			await enter(wrapper, {shiftKey: true})
			await enter(wrapper, {isComposing: true})
			await enter(wrapper, {keyCode: 229})
			expect(sdk.tcyAiConversationsSteer).not.toHaveBeenCalled()

			await enter(wrapper)
			expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledTimes(1)
		})

		it('keeps stopping available beside the steer button, and sends nothing after a stop', async () => {
			const wrapper = await mountRunning()
			expect(wrapper.find('.composer-stop').exists()).toBe(true)
			expect(wrapper.find('.composer-steer').exists()).toBe(false)

			await composer(wrapper).setValue('Skip Friday')
			expect(wrapper.find('.composer-steer').attributes('type')).toBe('submit')
			expect(wrapper.find('.composer-stop').attributes('aria-disabled')).toBe('false')

			await wrapper.find('.composer-stop').trigger('click')
			await flushPromises()
			expect(sdk.tcyAiConversationsStop).toHaveBeenCalledWith({path: {id: 'c1'}})
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.stopping')

			await enter(wrapper)
			await wrapper.find('form.composer').trigger('submit')
			await flushPromises()
			expect(sdk.tcyAiConversationsSteer).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsSend).not.toHaveBeenCalled()
			expect(value(wrapper)).toBe('Skip Friday')
		})

		it.each([
			['compacting the conversation', {compacting: true}, {status: 'completed' as const}],
			['compacting while a turn reads as running', {compacting: true}, {}],
			['paused for a review', {}, {status: 'awaiting_approval' as const, result: {pause: 'review' as const}}],
		])('does not steer while %s', async (_name, conversation, turn) => {
			const wrapper = await mountRunning(conversation, turn)
			await composer(wrapper).setValue('Also check due dates')

			await enter(wrapper)
			await wrapper.find('form.composer').trigger('submit')
			await flushPromises()

			expect(sdk.tcyAiConversationsSteer).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsSend).not.toHaveBeenCalled()
			expect(wrapper.find('.composer-steer').exists()).toBe(false)
			expect(wrapper.find('.composer-hint.is-steering').exists()).toBe(false)
			expect(value(wrapper)).toBe('Also check due dates')
		})

		it('shows why a compaction blocks the text instead of steering it', async () => {
			const wrapper = await mountRunning({compacting: true}, {status: 'completed'})
			await composer(wrapper).setValue('Also check due dates')
			expect(wrapper.find('.composer-hint').text()).toBe('aronaSteer.compacting')
			expect(wrapper.find('.composer-stop').exists()).toBe(true)
		})

		it('steers the open conversation while another conversation runs', async () => {
			const wrapper = await mountRunning()
			agentRunScope(client).live.value = ['c1', 'other']
			await composer(wrapper).setValue('Also check due dates')

			await enter(wrapper)

			expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledTimes(1)
			expect(sdk.tcyAiConversationsSend).not.toHaveBeenCalled()
		})

		it('does not steer the run its own message is still starting', async () => {
			seedSettings()
			seedPreferences()
			seedConversation('c1')
			const sending = deferred()
			sdk.tcyAiConversationsSend.mockImplementation(() => sending.promise)
			const wrapper = mountPanel('c1')
			await flushPromises()
			await composer(wrapper).setValue('Tidy my week')
			await enter(wrapper)
			expect(sdk.tcyAiConversationsSend).toHaveBeenCalledTimes(1)

			// The stream reports the run before the send's own answer arrives.
			seedRun('c1')
			await flushPromises()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)

			expect(sdk.tcyAiConversationsSteer).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsSend).toHaveBeenCalledTimes(1)
			expect(value(wrapper)).toBe('Also check due dates')
		})

		it('puts failed text back and retries it with the same request id', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)

			expect(value(wrapper)).toBe('Also check due dates')
			const note = wrapper.find('.steer-failure')
			expect(note.text()).toContain('aronaSteer.failed')
			expect(note.text()).toContain('aronaSteer.restoredRetry')
			expect(note.find('.steer-retry').exists()).toBe(true)

			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			await enter(wrapper)
			const [first, again] = steerBodies()
			expect(again).toEqual(first)
			expect(value(wrapper)).toBe('')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)

			await composer(wrapper).setValue('Skip Friday')
			await enter(wrapper)
			expect(steerBodies()[2].request_id).not.toBe(first.request_id)
		})

		it('keeps what was typed meanwhile when an instruction fails, and retries the failed one', async () => {
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			await composer(wrapper).setValue('Then summarize')

			attempt.reject(networkError())
			await flushPromises()

			expect(value(wrapper)).toBe('Then summarize')
			const note = wrapper.find('.steer-failure')
			expect(note.text()).toContain('aronaSteer.kept')
			expect(note.find('q').text()).toBe('Also check due dates')

			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			await note.find('.steer-retry').trigger('click')
			await flushPromises()

			const [first, retried] = steerBodies()
			expect(retried).toEqual(first)
			expect(value(wrapper)).toBe('Then summarize')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
		})

		it('explains a refused instruction without a retry and without starting a new run', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(Object.assign(new Error('refused'), {
				status: 409,
				detail: 'This turn is no longer accepting additional instructions.',
			}))
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)

			expect(value(wrapper)).toBe('Also check due dates')
			const note = wrapper.find('.steer-failure')
			expect(note.text()).toContain('aronaSteer.refused')
			expect(note.text()).toContain('This turn is no longer accepting additional instructions.')
			expect(note.find('.steer-retry').exists()).toBe(false)
			expect(sdk.tcyAiConversationsSend).not.toHaveBeenCalled()
			expect(sdk.tcyAiConversationsCreate).not.toHaveBeenCalled()
		})

		it('ignores the answer to an instruction sent before the account changed', async () => {
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)

			const stored = () => Object.keys(sessionStorage).filter(key => key.startsWith('tcy-ai-steer:'))
				.map(key => [key, JSON.parse(sessionStorage.getItem(key)!).map((entry: {state: string}) => entry.state)])
			expect(stored()).toEqual([[expect.stringContaining('"id":7'), ['sending']]])
			signIn(8)
			attempt.reject(networkError())
			await flushPromises()

			expect(value(wrapper)).toBe('')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expect(wrapper.find('.notice').exists()).toBe(false)
			// Nothing is written into either account after the switch; the first one's next visit finds it unconfirmed.
			expect(stored()).toEqual([[expect.stringContaining('"id":7'), ['sending']]])
		})

		it('files a failed instruction under its own conversation when another one is open', async () => {
			seedRun('c2')
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)

			await openFromHistory(wrapper, 'c2')
			attempt.reject(networkError())
			await flushPromises()

			expect(value(wrapper)).toBe('')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)

			// Back in its conversation the note holds the text and retries it under its own request id.
			await openFromHistory(wrapper, 'c1')
			expect(value(wrapper)).toBe('')
			const note = wrapper.find('.steer-failure')
			expect(note.find('q').text()).toBe('Also check due dates')
			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			await note.find('.steer-retry').trigger('click')
			await flushPromises()
			const [first, retried] = steerBodies()
			expect(retried).toEqual(first)
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
		})

		it('withdraws the failure once the conversation lists the instruction after all', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			expect(wrapper.find('.steer-failure').exists()).toBe(true)
			const [{request_id: requestID}] = steerBodies()

			seedRun('c1', {}, {
				steering: [{
					id: 's1',
					request_id: requestID,
					message: 'Also check due dates',
					created: '2026-11-01T06:03:27Z',
					status: 'pending',
				}],
			})
			await flushPromises()

			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expect(value(wrapper)).toBe('')
			expect(wrapper.find('.notice').text()).toContain('aronaSteer.delivered')
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.waiting {"count":1}')
		})

		it('keeps every failed instruction with its own retry while newer text is typed', async () => {
			const first = deferred()
			const second = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			await composer(wrapper).setValue('Skip Friday')
			first.reject(networkError())
			await flushPromises()
			await enter(wrapper)
			await composer(wrapper).setValue('Then summarize')
			second.reject(Object.assign(new Error('unavailable'), {status: 503}))
			await flushPromises()

			const quoted = () => wrapper.findAll('.steer-failure q').map(quote => quote.text())
			expect(quoted()).toEqual(['Also check due dates', 'Skip Friday'])
			expect(value(wrapper)).toBe('Then summarize')

			// A reload: a new view finds the typed text and both notes again.
			wrapper.unmount()
			const again = mountPanel('c1')
			await flushPromises()
			expect(value(again)).toBe('Then summarize')
			expect(again.findAll('.steer-failure q').map(quote => quote.text())).toEqual(['Also check due dates', 'Skip Friday'])

			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			for (const button of again.findAll('.steer-retry')) {
				await button.trigger('click')
				await flushPromises()
			}
			const [sentA, sentB, retriedA, retriedB] = steerBodies()
			expect(retriedA).toEqual(sentA)
			expect(retriedB).toEqual(sentB)
			expect(sentA.request_id).not.toBe(sentB.request_id)
			expect(again.find('.steer-failure').exists()).toBe(false)
			expect(value(again)).toBe('Then summarize')
		})

		it('finds an instruction a closed view was still sending as unconfirmed, with its request id', async () => {
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning()
			expect(wrapper.emitted('navigationBusy')?.at(-1)).toEqual([false])
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			// The floating panel cannot expand into the full page while the answer is outstanding.
			expect(wrapper.emitted('navigationBusy')?.at(-1)).toEqual([true])

			wrapper.unmount()
			attempt.reject(networkError())
			await flushPromises()

			const again = mountPanel('c1')
			await flushPromises()
			// The closed view put the text back as the conversation's draft, which the note then points to.
			expect(value(again)).toBe('Also check due dates')
			expect(again.find('.steer-failure').text()).toContain('aronaSteer.restoredRetry')
			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			await enter(again)
			const [sent, retried] = steerBodies()
			expect(retried).toEqual(sent)
			expect(value(again)).toBe('')
			expect(again.find('.steer-failure').exists()).toBe(false)
		})

		it('says the text is in the input only while it still is', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			expect(wrapper.find('.steer-failure').text()).toContain('aronaSteer.restoredRetry')

			await composer(wrapper).setValue('Also check due dates and owners')
			const note = wrapper.find('.steer-failure')
			expect(note.text()).not.toContain('aronaSteer.restoredRetry')
			expect(note.find('q').text()).toBe('Also check due dates')

			// The edited text is a new instruction; the earlier one stays until it is retried or dismissed.
			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			await enter(wrapper)
			const [first, edited] = steerBodies()
			expect(edited.request_id).not.toBe(first.request_id)
			expect(wrapper.find('.steer-failure q').text()).toBe('Also check due dates')
			await wrapper.find('.steer-failure .notice-dismiss').trigger('click')
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expect(steerBodies()).toHaveLength(2)
		})

		it('says so when the browser cannot keep a failed instruction', async () => {
			signIn(31)
			vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
				throw new DOMException('Quota exceeded', 'QuotaExceededError')
			})
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			vi.mocked(sessionStorage.setItem).mockRestore()

			expect(wrapper.find('.steer-failure').text()).toContain('aronaSteer.notSaved')
			await wrapper.find('.steer-failure .notice-dismiss').trigger('click')
		})

		it('waits for one instruction before sending the next, and keeps Stop usable meanwhile', async () => {
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning()
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			await composer(wrapper).setValue('Then summarize')
			await enter(wrapper)

			expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledTimes(1)
			expect(value(wrapper)).toBe('Then summarize')
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.sending')
			expect(wrapper.find('.composer-stop').attributes('aria-disabled')).toBe('false')
			await wrapper.find('.composer-stop').trigger('click')
			await flushPromises()
			expect(sdk.tcyAiConversationsStop).toHaveBeenCalledTimes(1)
		})

		it('takes instructions again when a stop fails', async () => {
			sdk.tcyAiConversationsStop.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning()
			await wrapper.find('.composer-stop').trigger('click')
			await flushPromises()
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.hint')

			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			expect(sdk.tcyAiConversationsSteer).toHaveBeenCalledTimes(1)
		})

		it('steers a run that compacts its own context, which waits for the next safe step', async () => {
			const wrapper = await mountRunning({}, {result: {stage: 'compacting'}})
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.autoCompacting')
			await composer(wrapper).setValue('Also check due dates')
			expect(wrapper.find('.composer-steer').exists()).toBe(true)

			await enter(wrapper)
			expect(steerBodies()).toEqual([expect.objectContaining({turn_id: RUN})])
		})

		it('shows its own instructions in the thread until the conversation lists them', async () => {
			let outbox!: ReturnType<typeof useSteeringOutbox>
			const thread = defineComponent({
				setup() {
					outbox = useSteeringOutbox()
					return () => null
				},
			})
			const attempt = deferred()
			sdk.tcyAiConversationsSteer.mockImplementationOnce(() => attempt.promise)
			const wrapper = await mountRunning({}, {}, {ChatThread: thread})
			const states = () => outbox.value.map(entry => [entry.message, entry.state])
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			expect(states()).toEqual([['Also check due dates', 'sending']])
			expect(wrapper.find('.composer-hint.is-steering').text()).not.toContain('aronaSteer.waiting')

			attempt.resolve({data: client.getQueryData(conversationKeys.detail('c1'))})
			await flushPromises()
			expect(states()).toEqual([['Also check due dates', 'sent']])
			expect(wrapper.find('.composer-hint.is-steering').text()).toContain('aronaSteer.waiting {"count":1}')
			expect(wrapper.find('.notice-region').text()).toContain('aronaSteer.accepted')

			seedRun('c1', {}, {status: 'stopped'})
			await flushPromises()
			expect(states()).toEqual([])
		})

		it('returns focus to the request field when a retried note leaves', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning({}, {}, {}, document.body)
			await composer(wrapper).setValue('Also check due dates')
			await enter(wrapper)
			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			const retry = wrapper.find<HTMLButtonElement>('.steer-retry')
			retry.element.focus()
			expect(document.activeElement).toBe(retry.element)

			// As with a mouse or trackpad, where focusing the field opens no on-screen keyboard.
			const media = vi.spyOn(window, 'matchMedia').mockReturnValue({matches: true} as MediaQueryList)
			await retry.trigger('click')
			await flushPromises()
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expect(document.activeElement).toBe(composer(wrapper).element)
			media.mockRestore()
		})

		it('returns focus on touch screens to the composer, not to the keyboard or to Stop', async () => {
			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			const wrapper = await mountRunning({}, {}, {}, document.body)
			// As on a touch screen, where focusing the request field opens the on-screen keyboard.
			const media = vi.spyOn(window, 'matchMedia').mockReturnValue({matches: false} as MediaQueryList)
			onTestFinished(() => media.mockRestore())
			const form = wrapper.find('form.composer').element
			async function sendFromButton(text: string) {
				await composer(wrapper).setValue(text)
				const button = wrapper.find('.composer-steer').element as HTMLElement
				// The stubbed button takes focus as the real one does; it leaves with the text.
				button.tabIndex = -1
				button.focus()
				await wrapper.find('form.composer').trigger('submit')
				await flushPromises()
			}
			const expectComposerFocused = () => {
				expect(document.activeElement).toBe(form)
				expect(document.activeElement).not.toBe(wrapper.find('.composer-stop').element)
			}

			await sendFromButton('Also check due dates')
			expect(wrapper.find('.steer-failure').exists()).toBe(true)
			expectComposerFocused()

			sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
			const retry = wrapper.find<HTMLButtonElement>('.steer-retry')
			retry.element.focus()
			await retry.trigger('click')
			await flushPromises()
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expectComposerFocused()

			await sendFromButton('Then summarize')
			expect(steerBodies().map(body => body.message)).toEqual(['Also check due dates', 'Also check due dates', 'Then summarize'])
			expectComposerFocused()

			sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
			await sendFromButton('Skip Friday')
			const dismiss = wrapper.find<HTMLButtonElement>('.steer-failure .notice-dismiss')
			dismiss.element.focus()
			await dismiss.trigger('click')
			await flushPromises()
			expect(wrapper.find('.steer-failure').exists()).toBe(false)
			expectComposerFocused()
		})

		describe('when the account or server changes after a failure, with nothing pending', () => {
			// What each account and server holds: [api, account id, [request id, state]...].
			const storedSteers = () => Object.keys(sessionStorage).filter(key => key.startsWith('tcy-ai-steer:')).map(key => {
				const [api, identity] = JSON.parse(key.slice('tcy-ai-steer:'.length))
				const entries = JSON.parse(sessionStorage.getItem(key)!) as {requestID: string, state: string}[]
				return [api, identity?.id, entries.map(entry => [entry.requestID, entry.state])]
			})
			const session = (id: number | null) => useAuthStore().setSession(id === null ? null : {id, type: 1} as never)
			async function failOnce(wrapper: ReturnType<typeof mountPanel>) {
				sdk.tcyAiConversationsSteer.mockRejectedValueOnce(networkError())
				await composer(wrapper).setValue('Also check due dates')
				await enter(wrapper)
				expect(wrapper.find('.steer-failure').exists()).toBe(true)
				const [sent] = steerBodies()
				return sent
			}

			it('never shows or acts on the first account\'s notes for the next one', async () => {
				const wrapper = await mountRunning()
				session(7)
				const sent = await failOnce(wrapper)
				const before = storedSteers()
				expect(before).toEqual([[expect.any(String), 7, [[sent.request_id, 'failed']]]])

				// Another account's token arrives before its session does; the note on screen is the first account's.
				signIn(8)
				await wrapper.find('.steer-failure .steer-retry').trigger('click')
				await wrapper.find('.steer-failure .notice-dismiss').trigger('click')
				await flushPromises()
				expect(steerBodies()).toHaveLength(1)
				expect(storedSteers()).toEqual(before)

				session(8)
				await flushPromises()
				expect(wrapper.find('.steer-failure').exists()).toBe(false)

				// The first account signing in again, in a new auth session, finds its note and request id.
				removeToken()
				signIn(7)
				session(7)
				await flushPromises()
				sdk.tcyAiConversationsSteer.mockImplementation(async () => ({data: client.getQueryData(conversationKeys.detail('c1'))}))
				await wrapper.find('.steer-failure .steer-retry').trigger('click')
				await flushPromises()
				expect(steerBodies()).toEqual([sent, sent])
				expect(storedSteers()).toEqual([])
			})

			it('never shows or acts on one server\'s notes for another', async () => {
				const wrapper = await mountRunning()
				session(7)
				const sent = await failOnce(wrapper)
				const before = storedSteers()
				const original = window.API_URL
				try {
					window.API_URL = 'https://other.example'
					await wrapper.find('.steer-failure .steer-retry').trigger('click')
					await wrapper.find('.steer-failure .notice-dismiss').trigger('click')
					await flushPromises()
					expect(steerBodies()).toEqual([sent])
					expect(storedSteers()).toEqual(before)

					// As a server change does: the session ends, then an account with the same id signs in there.
					removeToken()
					session(null)
					signIn(7)
					session(7)
					await flushPromises()
					expect(wrapper.find('.steer-failure').exists()).toBe(false)
				} finally {
					window.API_URL = original
				}
				expect(storedSteers()).toEqual(before)
			})
		})
	})
})
