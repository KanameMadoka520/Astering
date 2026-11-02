/* eslint-disable vue/one-component-per-file -- Router hosts and native control stubs are scoped test fixtures. */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin, useQuery} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter, RouterView} from 'vue-router'

const sdk = vi.hoisted(() => ({
	tcyAiSaveSettings: vi.fn(),
	tcyAiSettings: vi.fn(),
	tcyAiModels: vi.fn(),
	tcyAiTest: vi.fn(),
	tcyAiSpeechProviders: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('vue-i18n', async importOriginal => {
	const {ref} = await import('vue')
	return {
		...await importOriginal<typeof import('vue-i18n')>(),
		useI18n: () => ({
			t: (key: string) => key,
			locale: ref('en'),
		}),
	}
})

import type {AIConnection, AISettings} from '@/client/queries/tcyAi'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import TcyAISettingsForm from './TcyAISettingsForm.vue'
import SpeechProviderDialog from './SpeechProviderDialog.vue'

enableAutoUnmount(afterEach)

const SAVED: AISettings = {
	persona: 'arona',
	connections: [{
		id: 'llm',
		name: 'Saved LLM',
		kind: 'chat',
		protocol: 'openai-chat',
		base_url: 'https://llm.example/v1',
		model: 'model',
		api_key: '',
		has_key: true,
	}],
	assistant: 'llm',
	transcription: '',
	cleanup: '',
}

// The shared dialog's built-in layout: header, text and a confirm button that runs the submit handler.
const ModalStub = defineComponent({
	props: {
		enabled: {
			type: Boolean,
			default: true,
		},
		confirmLabel: {
			type: String,
			default: '',
		},
		onSubmit: {
			type: Function,
			default: undefined,
		},
	},
	emits: ['close'],
	setup: (props, {slots}) => () => props.enabled
		? h('div', {class: 'modal-stub'}, [
			slots.default?.(),
			slots.header?.(),
			slots.text?.(),
			h('button', {
				class: 'modal-primary',
				onClick: () => props.onSubmit?.(),
			}, props.confirmLabel),
		])
		: null,
})
const ButtonStub = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})

describe('TcyAISettingsForm', () => {
	let router: ReturnType<typeof createRouter>

	async function mountForm(fromQuery = false) {
		const SettingsHost = defineComponent({
			setup() {
				const query = useQuery(aiSettingsQuery())
				return () => query.data.value ? h(TcyAISettingsForm, {initial: query.data.value}) : null
			},
		})
		router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: '/settings',
					component: fromQuery ? SettingsHost : () => h(TcyAISettingsForm, {initial: SAVED}),
				},
				{
					path: '/other',
					component: {render: () => null},
				},
			],
		})
		await router.push('/settings')
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const wrapper = mount(RouterView, {
			global: {
				plugins: [router, [VueQueryPlugin, {queryClient: client}], createPinia()],
				stubs: {
					Modal: ModalStub,
					Icon: true,
					ModelPicker: true,
					WebSearchEvidence: true,
					XButton: ButtonStub,
				},
			},
		})
		await flushPromises()
		return wrapper
	}
	const dialogs = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.findAll('.modal-stub')

	beforeEach(() => {
		sdk.tcyAiSaveSettings.mockReset()
		sdk.tcyAiSettings.mockResolvedValue({data: SAVED})
		sdk.tcyAiSpeechProviders.mockResolvedValue({data: [{
			id: 'openai',
			name: 'OpenAI',
			docs_url: 'https://provider.example/docs',
			key_url: 'https://provider.example/keys',
			local: false,
			models: [{
				id: 'wire-speech-id',
				name: 'A model label',
				protocol: 'openai-transcription',
				base_url: 'https://provider.example/v1',
				recommended: true,
				sample_rate: 0,
				language: true,
				prompt: true,
				hotwords: false,
				vocabulary: false,
				workspace: false,
				app_id: false,
				resource_id: false,
			}],
		}]})
	})

	it('duplicates saved chat settings without returning a key or submitting the source draft', async () => {
		const wrapper = await mountForm()
		await wrapper.get('.ai-field input').setValue('Unfinished source name')
		await wrapper.get('.connection__copy').trigger('click')
		await flushPromises()
		const copy = wrapper.findAll('form.connection')[1]
		expect(copy.text()).toContain('modelSettings.keyWillCopy')
		expect(copy.get('input[type="password"]').element).toHaveProperty('value', '')
		await copy.trigger('submit')
		await flushPromises()
		const body = sdk.tcyAiSaveSettings.mock.calls[0][0].body
		expect(body.assistant).toBe('llm')
		expect(body.connections[0].name).toBe('Saved LLM')
		expect(body.connections[1]).toMatchObject({
			copy_key_from: 'llm',
			api_key: '',
			protocol: 'openai-chat',
			base_url: 'https://llm.example/v1',
			model: 'model',
		})
		expect(body.connections[1].id).not.toBe('llm')
		expect(wrapper.get('.ai-field input').element).toHaveProperty('value', 'Unfinished source name')
	})

	it.each(['address', 'protocol'])('requires a replacement key if a duplicate changes its %s before saving', async field => {
		const wrapper = await mountForm()
		await wrapper.get('.connection__copy').trigger('click')
		await flushPromises()
		const copy = wrapper.findAll('form.connection')[1]
		if (field === 'address') await copy.findAll('.ai-field input')[1].setValue('https://another.example/v1')
		else await copy.findAll('.ai-field select')[1].setValue('anthropic')
		await copy.trigger('submit')
		expect(sdk.tcyAiSaveSettings).not.toHaveBeenCalled()
		expect(copy.text()).toContain('modelSettings.copyKeyChanged')
		await copy.get('input[type="password"]').setValue('replacement-fixture-key')
		await copy.trigger('submit')
		await flushPromises()
		expect(sdk.tcyAiSaveSettings.mock.calls[0][0].body.connections[1]).toMatchObject({
			api_key: 'replacement-fixture-key',
			copy_key_from: undefined,
		})
	})

	it.each([
		['workspace', {speech: {provider: 'openai', workspace_id: 'workspace-b', app_id: 'app-a'}}],
		['native protocol', {protocol: 'qwen-asr-realtime'}],
		['app ID', {speech: {provider: 'openai', workspace_id: 'workspace-a', app_id: 'app-b'}}],
	] satisfies [string, Partial<AIConnection>][])('requires a new key when %s changes at the same base URL', async (_, patch) => {
		const saved: AIConnection = {
			id: 'native-speech',
			name: 'Native speech',
			kind: 'transcription',
			protocol: 'dashscope-asr',
			base_url: 'https://provider.example',
			model: 'native-model',
			api_key: '',
			has_key: true,
			speech: {provider: 'openai', workspace_id: 'workspace-a', app_id: 'app-a'},
		}
		sdk.tcyAiSettings.mockResolvedValue({data: {...SAVED, connections: [...SAVED.connections, saved]}})
		const wrapper = await mountForm(true)
		await wrapper.findAll('button').find(button => button.text().includes('modelSettings.transcription'))!.trigger('click')
		await flushPromises()
		await wrapper.get('.speech-provider-card').trigger('click')
		const dialog = wrapper.getComponent(SpeechProviderDialog)
		expect(dialog.props('state').changedAddress).toBe(false)
		dialog.vm.$emit('update:connection', {...saved, ...patch})
		await flushPromises()
		expect(dialog.props('state').changedAddress).toBe(true)
		expect(dialog.get('input[id$="-speech-key"]').attributes('placeholder')).toBe('speechSettings.keyPlaceholder')
		expect(dialog.text()).toContain('speechSettings.keyDestinationChanged')
		dialog.vm.$emit('update:connection', {
			...saved,
			model: 'another-model',
			speech: {...saved.speech, language: 'en'},
		})
		await flushPromises()
		expect(dialog.props('state').changedAddress).toBe(false)
		expect(dialog.get('input[id$="-speech-key"]').attributes('placeholder'))
			.toBe('tcymc.text.saved_leave_blank_to_keep_the_current_key')
	})

	it('asks before leaving with an unsaved connection, and leaves only after a discard', async () => {
		const wrapper = await mountForm()
		await router.push('/other')
		expect(router.currentRoute.value.path).toBe('/other')

		await router.push('/settings')
		await flushPromises()
		await wrapper.find('.ai-field input').setValue('Renamed LLM')
		await router.push('/other')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/settings')
		const leave = dialogs(wrapper).find(dialog => dialog.text().includes('modelSettings.leaveTitle'))!
		expect(leave.find('.modal-primary').text()).toBe('modelSettings.leaveDiscard')

		await leave.find('.modal-primary').trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/other')
	})

	it('keeps the remove dialog open on failure and reports it as a removal', async () => {
		sdk.tcyAiSaveSettings.mockRejectedValue(new Error('Server unavailable'))
		const wrapper = await mountForm()
		const remove = wrapper.findAll('.connection__remove')[0]
		await remove.trigger('click')
		const dialog = () => dialogs(wrapper).find(candidate => candidate.text().includes('modelSettings.removeConfirm'))
		expect(dialog()!.find('.modal-primary').text()).toBe('tcymc.text.remove_connection')

		await dialog()!.find('.modal-primary').trigger('click')
		await flushPromises()

		expect(sdk.tcyAiSaveSettings).toHaveBeenCalledTimes(1)
		expect(dialog()?.find('[role="alert"]').text()).toBe('modelSettings.removeFailed Server unavailable')
		expect(wrapper.text()).not.toContain('settingsDraft.retained')
		expect(wrapper.findAll('form.connection')).toHaveLength(1)
	})

	it('saves a speech default atomically without submitting the unfinished chat draft, then clears a disabled default', async () => {
		sdk.tcyAiSaveSettings.mockImplementation(async ({body}) => ({data: {
			...body,
			connections: body.connections.map((connection: AISettings['connections'][number]) => ({
				...connection,
				api_key: undefined,
				has_key: true,
			})),
		}}))
		const wrapper = await mountForm(true)
		await wrapper.find('.ai-field input').setValue('Unfinished chat rename')
		await wrapper.findAll('button').find(button => button.text().includes('modelSettings.transcription'))!.trigger('click')
		await flushPromises()
		await wrapper.findAll('.speech-provider-card')[0].trigger('click')
		await flushPromises()
		await wrapper.get('input[id$="-speech-key"]').setValue('fixture-private-key')
		await wrapper.findAll('.speech-model button').find(button => button.text() === 'speechSettings.makeDefault')!.trigger('click')
		await flushPromises()
		const submitted = sdk.tcyAiSaveSettings.mock.calls[0][0].body
		const speech = submitted.connections.find((connection: AISettings['connections'][number]) => connection.kind === 'transcription')
		expect(submitted.transcription).toBe(speech.id)
		expect(submitted.connections[0].name).toBe('Saved LLM')
		expect(speech.model).toBe('wire-speech-id')
		expect(wrapper.findAll('.speech-model button').some(button => button.text() === 'speechSettings.currentModel')).toBe(true)
		await wrapper.get('input[role="switch"]').setValue(false)
		await wrapper.get('form.speech-provider-form').trigger('submit')
		await flushPromises()
		const disabled = sdk.tcyAiSaveSettings.mock.calls[1][0].body
		expect(disabled.transcription).toBe('')
		expect(disabled.connections.find((connection: AISettings['connections'][number]) => connection.id === speech.id).speech.disabled).toBe(true)
		await wrapper.findAll('button').find(button => button.text().includes('modelSettings.chat'))!.trigger('click')
		expect(wrapper.find('.ai-field input').element).toHaveProperty('value', 'Unfinished chat rename')
	})

	it.each(['dashscope-asr', 'qwen-asr-realtime'] as const)('probes a saved %s connection without requesting an audio file', async protocol => {
		const saved: AIConnection = {
			id: 'aliyun-probe',
			name: 'Alibaba speech',
			kind: 'transcription',
			protocol,
			base_url: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
			model: 'fixture-model',
			api_key: '',
			has_key: true,
			speech: {provider: 'openai'},
		}
		sdk.tcyAiTest.mockReset()
		sdk.tcyAiTest.mockResolvedValue({data: {
			endpoint: saved.base_url,
			warning: 'Connection handshake only.',
			elapsed_ms: 20,
		}})
		sdk.tcyAiSettings.mockResolvedValue({data: {...SAVED, connections: [...SAVED.connections, saved]}})
		const wrapper = await mountForm(true)
		await wrapper.findAll('button').find(button => button.text().includes('modelSettings.transcription'))!.trigger('click')
		await flushPromises()
		await wrapper.get('.speech-provider-card').trigger('click')
		const dialog = wrapper.getComponent(SpeechProviderDialog)
		dialog.vm.$emit('test', dialog.props('connection'))
		await flushPromises()
		expect(sdk.tcyAiTest).toHaveBeenCalledTimes(1)
		expect(sdk.tcyAiTest.mock.calls[0][0].body).toMatchObject({
			connection_id: saved.id,
			audio: '',
			filename: '',
		})
		expect(wrapper.text()).toContain('Connection handshake only.')
	})
})
