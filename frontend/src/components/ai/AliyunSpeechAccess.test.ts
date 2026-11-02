import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import type {AIConnection} from '@/client/queries/tcyAi'
import {sameSpeechSecretDestination} from '@/helpers/speechProviders'
import AliyunSpeechAccess from './AliyunSpeechAccess.vue'

vi.mock('vue-i18n', () => ({
	useI18n: () => ({t: (key: string) => key}),
}))
const ButtonStub = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
enableAutoUnmount(afterEach)

const connection: AIConnection = {
	id: 'saved-speech',
	name: 'Existing recognizer',
	kind: 'transcription',
	protocol: 'dashscope-asr',
	model: 'fun-asr-realtime',
	base_url: 'wss://my-proxy.example/inference',
	api_key: '',
	has_key: true,
	speech: {provider: 'aliyun', language: 'zh', vocabulary_id: 'existing-vocabulary'},
}
function mountAccess() {
	return mount(AliyunSpeechAccess, {
		props: {connection},
		global: {stubs: {XButton: ButtonStub}},
	})
}

describe('Alibaba access controls', () => {
	it('does not migrate a saved URL on mount and uses a regional endpoint only after an explicit choice', async () => {
		const wrapper = mountAccess()
		expect(wrapper.emitted('update:connection')).toBeUndefined()
		expect(wrapper.get('select').element.value).toBe('custom')
		await wrapper.get('select').setValue('singapore')
		const selected = wrapper.emitted('update:connection')![0][0] as AIConnection
		expect(selected.base_url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference')
		expect(selected.speech).toEqual(connection.speech)
		expect(sameSpeechSecretDestination(connection, selected)).toBe(false)
		expect(connection.base_url).toBe('wss://my-proxy.example/inference')
	})

	it('keeps dedicated workspace access optional and links the official regional documentation', async () => {
		const wrapper = mountAccess()
		expect(wrapper.get('details').element.open).toBe(false)
		await wrapper.get('button').trigger('click')
		const selected = wrapper.emitted('update:connection')![0][0] as AIConnection
		expect(selected.base_url).toBe('wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')
		expect(selected.speech).toEqual(connection.speech)
		expect(wrapper.get('a').attributes()).toMatchObject({
			href: 'https://help.aliyun.com/zh/model-studio/regions',
			target: '_blank',
			rel: 'noopener noreferrer',
		})
	})
})
