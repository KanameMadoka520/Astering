import {describe, expect, it} from 'vitest'
import type {AIConnection, SpeechModel, SpeechProvider} from '@/client/queries/tcyAi'
import {speechAudioLimit, speechModelCapabilities, speechProviderID, speechProviderPresets} from './speechProviders'

const model: SpeechModel = {
	id: 'wire-model-id',
	name: 'Friendly display label',
	protocol: 'dashscope-asr',
	base_url: 'wss://{workspace_id}.provider.example/inference',
	recommended: true,
	sample_rate: 16000,
	language: true,
	prompt: false,
	hotwords: false,
	vocabulary: true,
	workspace: true,
	app_id: false,
	resource_id: false,
}
const provider: SpeechProvider = {
	id: 'aliyun',
	name: 'Alibaba Cloud',
	docs_url: 'https://docs.example/speech',
	key_url: 'https://console.example/keys',
	local: false,
	models: [model],
}
const connection: AIConnection = {
	id: 'speech',
	name: 'A speech connection',
	kind: 'transcription',
	protocol: 'dashscope-asr',
	base_url: model.base_url,
	model: model.id,
	api_key: '',
	has_key: true,
}

describe('speech provider presentation', () => {
	it('uses the catalog wire model and adds a custom option without changing the preset', () => {
		const presets = speechProviderPresets([provider])
		expect(presets.map(item => item.id)).toEqual(['aliyun', 'custom'])
		expect(presets[0].models[0]).toBe(model)
		expect(presets[0].docsURL).toBe(provider.docs_url)
		expect(presets[0].models[0].id).toBe('wire-model-id')
		expect(provider.models).toEqual([model])
	})

	it('keeps unmarked legacy connections custom and never infers a provider from a model name', () => {
		expect(speechProviderID({...connection, model: 'some-famous-provider-model'})).toBe('custom')
		expect(speechProviderID({...connection, speech: {provider: 'aliyun'}})).toBe('aliyun')
	})

	it('does not advertise another model’s capabilities when a custom model is entered', () => {
		const preset = speechProviderPresets([provider])[0]
		expect(speechModelCapabilities(connection, preset)?.hotwords).toBe(false)
		expect(speechModelCapabilities({...connection, model: 'unknown-model'}, preset)).toBeUndefined()
	})

	it('matches the smaller Gemini inline-audio boundary', () => {
		expect(speechAudioLimit({...connection, protocol: 'gemini'})).toBe(14 * 1024 * 1024)
		expect(speechAudioLimit(connection)).toBe(16 * 1024 * 1024)
	})
})
