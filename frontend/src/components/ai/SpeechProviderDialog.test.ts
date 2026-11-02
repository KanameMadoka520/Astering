/* eslint-disable vue/one-component-per-file -- Button and dialog stubs are separate test fixtures. */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import type {AIConnection, SpeechModel} from '@/client/queries/tcyAi'
import {sameSpeechSecretDestination, type SpeechConnectionPresentation, type SpeechProviderPreset} from '@/helpers/speechProviders'
import SpeechProviderDialog from './SpeechProviderDialog.vue'

vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string) => key,
		locale: {value: 'en'},
	}),
}))
const SlotStub = defineComponent({
	setup: (_, {slots}) => () => h('div', slots.default?.()),
})
const ButtonStub = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
enableAutoUnmount(afterEach)

const model: SpeechModel = {
	id: 'actual-asr-wire-id',
	name: 'A readable model label',
	protocol: 'dashscope-asr',
	base_url: 'wss://{workspace_id}.provider.example/inference',
	recommended: true,
	sample_rate: 16000,
	language: true,
	prompt: true,
	hotwords: true,
	vocabulary: false,
	workspace: true,
	app_id: false,
	resource_id: false,
}
const provider: SpeechProviderPreset = {
	id: 'aliyun',
	name: 'Alibaba Cloud',
	mark: 'A',
	tone: 'orange',
	models: [model],
}
const connection: AIConnection = {
	id: 'speech-id',
	name: 'My recognizer',
	kind: 'transcription',
	protocol: 'dashscope-asr',
	base_url: 'wss://{workspace_id}.provider.example/inference',
	model: model.id,
	api_key: '',
	has_key: true,
	speech: {provider: 'aliyun'},
}
const state: SpeechConnectionPresentation = {
	canAdd: true,
	persisted: true,
	saved: true,
	saving: false,
	testing: false,
	fetching: false,
	canTest: true,
	changedAddress: false,
	modelNotice: '',
	error: '',
	models: [],
}

function mountDialog() {
	return mount(SpeechProviderDialog, {
		props: {
			connection,
			connections: [connection],
			provider,
			defaultId: '',
			state,
			endpoint: 'wss://workspace.provider.example/inference',
			modelsEndpoint: '',
		},
		global: {
			stubs: {
				Modal: SlotStub,
				XButton: ButtonStub,
				Icon: true,
				ModelPicker: true,
			},
		},
	})
}

describe('speech provider dialog', () => {
	it('does not promise reuse of the saved key after its destination changes', async () => {
		const wrapper = mountDialog()
		const key = () => wrapper.get('input[id$="-speech-key"]')
		expect(key().attributes('placeholder')).toBe('tcymc.text.saved_leave_blank_to_keep_the_current_key')
		await wrapper.setProps({state: {...state, changedAddress: true}})
		expect(key().attributes('placeholder')).toBe('speechSettings.keyPlaceholder')
		expect(wrapper.text()).toContain('speechSettings.keyDestinationChanged')
		await wrapper.setProps({state})
		expect(key().attributes('placeholder')).toBe('tcymc.text.saved_leave_blank_to_keep_the_current_key')
		expect(wrapper.text()).not.toContain('speechSettings.keyDestinationChanged')
	})

	it('sets the actual catalog model and connection in one default action', async () => {
		const wrapper = mountDialog()
		const button = wrapper.findAll('.speech-model button')
			.find(candidate => candidate.text() === 'speechSettings.makeDefault')!
		await button.trigger('click')
		expect(wrapper.emitted('default')?.[0]).toEqual([{
			...connection,
			model: 'actual-asr-wire-id',
			protocol: 'dashscope-asr',
			base_url: model.base_url,
			speech: {
				provider: 'aliyun',
				disabled: false,
			},
		}])
	})

	it('exposes only the selected model’s supported options and requires its workspace', async () => {
		const wrapper = mountDialog()
		const workspace = wrapper.findAll('label').find(label => label.text().includes('speechSettings.workspace'))!
		expect(workspace.get('input').attributes('required')).toBeDefined()
		expect(wrapper.text()).toContain('speechSettings.hotwords')
		await wrapper.setProps({
			provider: {
				...provider,
				models: [{
					...model,
					hotwords: false,
					prompt: false,
				}],
			},
		})
		expect(wrapper.text()).not.toContain('speechSettings.hotwords')
		expect(wrapper.text()).not.toContain('speechSettings.promptHint')
	})

	it('emits a disabled draft without mutating the saved connection', async () => {
		const wrapper = mountDialog()
		await wrapper.get('input[role="switch"]').setValue(false)
		expect(wrapper.emitted('update:connection')?.[0]).toEqual([{
			...connection,
			speech: {
				provider: 'aliyun',
				disabled: true,
			},
		}])
		expect(connection.speech?.disabled).toBeUndefined()
	})

	it('never treats an unavailable latency metric as a reported measurement', async () => {
		const wrapper = mountDialog()
		await wrapper.setProps({
			state: {
				...state,
				result: {
					ok: true,
					text: 'A fixture transcript',
					endpoint: '',
					elapsedMs: 250,
					firstTextMs: 0,
					audioDurationMs: 0,
				},
			},
		})
		expect(wrapper.text()).toContain('speechSettings.elapsed')
		expect(wrapper.text()).not.toContain('speechSettings.firstText')
		expect(wrapper.text()).not.toContain('speechSettings.duration')
	})
})


describe('speech credential destinations', () => {
	it('preserves the legacy base-URL-only rule but fences transitions into native speech', () => {
		const legacy: AIConnection = {...connection, protocol: 'openai-transcription', base_url: 'https://provider.example/v1'}
		expect(sameSpeechSecretDestination(legacy, {
			...legacy,
			protocol: 'openai-audio',
			base_url: ' https://provider.example/v1/ ',
			speech: {workspace_id: 'different', app_id: 'different'},
		})).toBe(true)
		expect(sameSpeechSecretDestination(legacy, {...legacy, protocol: 'openai-realtime'})).toBe(false)
		expect(sameSpeechSecretDestination(legacy, {...legacy, base_url: 'https://other.example/v1'})).toBe(false)
	})

	it('does not confuse metadata with a native credential destination', () => {
		const saved: AIConnection = {...connection, speech: {workspace_id: 'workspace-a', app_id: 'app-a'}}
		expect(sameSpeechSecretDestination(saved, {
			...saved,
			model: 'updated-model',
			speech: {...saved.speech, language: 'en', hotwords: ['Arona'], disabled: true},
		})).toBe(true)
		expect(sameSpeechSecretDestination(saved, {
			...saved,
			speech: {...saved.speech, workspace_id: 'workspace-b'},
		})).toBe(false)
	})
})
