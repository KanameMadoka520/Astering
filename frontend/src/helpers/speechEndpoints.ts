import type {AIConnection} from '@/client/queries/tcyAi'

const paths: Partial<Record<AIConnection['protocol'], string>> = {
	'dashscope-asr': '/api-ws/v1/inference',
	'qwen-asr-realtime': '/api-ws/v1/realtime',
	'dashscope-file-asr': '/api/v1/services/aigc/multimodal-generation/generation',
	'volcengine-asr': '/api/v3/sauc/bigmodel',
	'openai-realtime': '/realtime',
	'elevenlabs-realtime': '/speech-to-text/realtime',
	'elevenlabs-transcription': '/speech-to-text',
	'soniox-realtime': '/transcribe-websocket',
	'mimo-asr': '/chat/completions',
	sensevoice: '/api/v1/asr',
}

export function speechRequestEndpoint(connection: AIConnection): string {
	const suffix = paths[connection.protocol]
	let base = connection.base_url.trim().replace(/\/+$/, '')
		.replaceAll('{workspace_id}', connection.speech?.workspace_id || '{workspace_id}')
	if (!suffix) return base
	const completeVolcengine = connection.protocol === 'volcengine-asr'
		&& /\/api\/v3\/sauc\/bigmodel(?:_async|_nostream)?$/.test(base)
	if (!base.endsWith(suffix) && !completeVolcengine) base += suffix
	if (['dashscope-asr', 'qwen-asr-realtime', 'volcengine-asr', 'openai-realtime', 'elevenlabs-realtime', 'soniox-realtime']
		.includes(connection.protocol)) {
		base = base.replace(/^https:\/\//, 'wss://')
	}
	const query = new URLSearchParams()
	if (connection.protocol === 'openai-realtime') query.set('intent', 'transcription')
	if (connection.protocol === 'qwen-asr-realtime') query.set('model', connection.model)
	if (connection.protocol === 'elevenlabs-realtime') {
		query.set('audio_format', 'pcm_16000')
		query.set('commit_strategy', 'manual')
		if (connection.speech?.language && connection.speech.language !== 'auto') {
			query.set('language_code', connection.speech.language)
		}
		for (const word of connection.speech?.hotwords ?? []) query.append('keyterms', word)
		query.set('model_id', connection.model)
	}
	return `${base}${query.size ? `?${query.toString()}` : ''}`
}
