import {describe, expect, it} from 'vitest'
import {speechRequestEndpoint} from './speechEndpoints'
import type {AIConnection} from '@/client/queries/tcyAi'

const connection = (values: Partial<AIConnection>): AIConnection => ({
	id: 'speech', name: 'Speech', kind: 'transcription', protocol: 'dashscope-asr',
	base_url: 'https://example.com', model: 'speech-model', api_key: '', has_key: true, ...values,
})

describe('actual speech request endpoint', () => {
	it('resolves dedicated Alibaba workspaces and does not duplicate full paths', () => {
		expect(speechRequestEndpoint(connection({
			base_url: 'wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/',
			speech: {workspace_id: 'workspace-42'},
		}))).toBe('wss://workspace-42.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')
		expect(speechRequestEndpoint(connection({protocol: 'qwen-asr-realtime', model: 'qwen3-asr-flash-realtime'})))
			.toBe('wss://example.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
	})

	it('shows transcription intent rather than putting the OpenAI model in the session URL', () => {
		expect(speechRequestEndpoint(connection({protocol: 'openai-realtime', base_url: 'https://api.openai.com/v1'})))
			.toBe('wss://api.openai.com/v1/realtime?intent=transcription')
	})

	it('preserves Volcengine mode-specific endpoints and displays all ElevenLabs query options', () => {
		expect(speechRequestEndpoint(connection({protocol: 'volcengine-asr', base_url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'})))
			.toBe('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream')
		expect(speechRequestEndpoint(connection({protocol: 'elevenlabs-realtime', base_url: 'https://api.elevenlabs.io/v1', model: 'scribe_v2_realtime', speech: {language: 'zh', hotwords: ['project name', 'Astering']}})))
			.toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime?audio_format=pcm_16000&commit_strategy=manual&language_code=zh&keyterms=project+name&keyterms=Astering&model_id=scribe_v2_realtime')
	})
})
