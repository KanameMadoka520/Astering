import {describe, expect, it} from 'vitest'
import type {AIConnection, SpeechModel} from '@/client/queries/tcyAi'
import {
	aliyunSpeechAccess,
	aliyunSpeechBaseURL,
	aliyunSpeechModelConnection,
	speechConnectionCanProbe,
	speechWorkspaceRequired,
} from './aliyunSpeech'

const connection: AIConnection = {
	id: 'aliyun',
	name: 'Alibaba recognizer',
	kind: 'transcription',
	protocol: 'dashscope-asr',
	model: 'qwen-audio-3.1-asr-flash-streaming',
	base_url: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
	api_key: '',
	has_key: true,
	speech: {provider: 'aliyun'},
}
const model: SpeechModel = {
	id: 'qwen3-asr-flash-realtime',
	name: 'Qwen ASR',
	protocol: 'qwen-asr-realtime',
	base_url: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
	recommended: false,
	sample_rate: 16000,
	language: true,
	prompt: false,
	hotwords: false,
	vocabulary: false,
	workspace: true,
	app_id: false,
	resource_id: false,
}

describe('Alibaba speech access', () => {
	it('uses explicit regional endpoints and requires a workspace only for unresolved placeholders', () => {
		expect(aliyunSpeechAccess(connection)).toBe('singapore')
		expect(aliyunSpeechBaseURL('dashscope-asr', 'beijing'))
			.toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference')
		expect(aliyunSpeechBaseURL('dashscope-file-asr', 'singapore'))
			.toBe('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
		const dedicated = {...connection, base_url: aliyunSpeechBaseURL('dashscope-asr', 'singapore', true)!}
		expect(aliyunSpeechAccess(dedicated)).toBe('workspace')
		expect(speechWorkspaceRequired(dedicated)).toBe(true)
		expect(speechWorkspaceRequired(connection)).toBe(false)
		expect(speechWorkspaceRequired({
			...connection,
			base_url: 'wss://existing-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
		})).toBe(false)
	})

	it.each([
		'wss://dashscope-intl.aliyuncs.com.proxy.example/api-ws/v1/inference',
		'wss://dashscope-intl.aliyuncs.com/custom/path',
		'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference?proxy=1',
		'wss://user@dashscope-intl.aliyuncs.com/api-ws/v1/inference',
	])('preserves noncanonical and proxy addresses without rewriting them: %s', baseURL => {
		const custom = {...connection, base_url: baseURL}
		expect(aliyunSpeechAccess(custom)).toBe('custom')
		expect(aliyunSpeechModelConnection(custom, model).base_url).toBe(baseURL)
	})

	it('changes only the protocol path for known regional or dedicated model switches', () => {
		const updated = aliyunSpeechModelConnection(connection, model)
		expect(updated.base_url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime')
		expect(updated.speech).toBe(connection.speech)
		expect(connection.protocol).toBe('dashscope-asr')
		const dedicated = {
			...connection,
			base_url: 'wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
			speech: {...connection.speech, workspace_id: 'existing-workspace'},
		}
		expect(aliyunSpeechModelConnection(dedicated, {...model, protocol: 'dashscope-file-asr'}).base_url)
			.toBe('https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
		expect(aliyunSpeechModelConnection({...connection, base_url: ''}, model).base_url).toBe(model.base_url)
	})

	it('offers no-audio probing only for the two implemented speech WebSocket handshakes', () => {
		expect(speechConnectionCanProbe(connection)).toBe(true)
		expect(speechConnectionCanProbe({...connection, protocol: 'qwen-asr-realtime'})).toBe(true)
		expect(speechConnectionCanProbe({...connection, protocol: 'dashscope-file-asr'})).toBe(false)
		expect(speechConnectionCanProbe({...connection, protocol: 'openai-transcription'})).toBe(false)
		expect(speechConnectionCanProbe({...connection, kind: 'chat'})).toBe(false)
	})
})
