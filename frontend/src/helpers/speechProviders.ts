import type {
	AIConnection,
	SpeechModel,
	SpeechProvider,
} from '@/client/queries/tcyAi'

export interface SpeechProviderPreset {
	id: string
	name: string
	labelKey?: string
	mark: string
	tone: string
	local?: boolean
	docsURL?: string
	keyURL?: string
	models: SpeechModel[]
}

// Presets describe the service, while a connection retains its own URL, credentials and model.
const providerAppearance = [
	{
		id: 'sensevoice',
		name: 'SenseVoice Small',
		mark: 'S',
		tone: 'violet',
		local: true,
	},
	{
		id: 'volcengine',
		name: 'Volcengine',
		mark: 'V',
		tone: 'blue',
	},
	{
		id: 'aliyun',
		name: 'Alibaba Cloud',
		mark: 'A',
		tone: 'orange',
	},
	{
		id: 'mimo',
		name: 'Xiaomi MiMo',
		mark: 'Mi',
		tone: 'ink',
	},
	{
		id: 'openai',
		name: 'OpenAI',
		mark: 'O',
		tone: 'green',
	},
	{
		id: 'elevenlabs',
		name: 'ElevenLabs',
		mark: 'Ⅱ',
		tone: 'ink',
	},
	{
		id: 'soniox',
		name: 'Soniox',
		mark: 'S',
		tone: 'navy',
	},
	{
		id: 'gemini',
		name: 'Gemini',
		mark: 'G',
		tone: 'blue',
	},
	{
		id: 'custom',
		name: 'Custom',
		mark: '+',
		tone: 'neutral',
	},
] as const

export function speechProviderPresets(catalog: SpeechProvider[]): SpeechProviderPreset[] {
	const presets = catalog.map(provider => {
		const appearance = providerAppearance.find(item => item.id === provider.id)
		return {
			id: provider.id,
			name: provider.name,
			labelKey: appearance ? `speechSettings.providers.${appearance.id}` : undefined,
			mark: appearance?.mark ?? provider.name.slice(0, 1),
			tone: appearance?.tone ?? 'neutral',
			local: provider.local,
			docsURL: provider.docs_url,
			keyURL: provider.key_url,
			models: provider.models,
		}
	})
	if (!presets.some(provider => provider.id === 'custom')) {
		presets.push({
			id: 'custom',
			name: 'Custom',
			labelKey: 'speechSettings.custom',
			mark: '+',
			tone: 'neutral',
			local: false,
			docsURL: '',
			keyURL: '',
			models: [],
		})
	}
	return presets
}

export function speechProviderID(connection: AIConnection): string {
	return connection.speech?.provider || 'custom'
}

export interface SpeechConnectionTestResult {
	ok: boolean
	connectionOnly?: boolean
	text: string
	endpoint: string
	elapsedMs?: number
	audioDurationMs?: number
	firstTextMs?: number
}

export interface SpeechConnectionPresentation {
	canAdd: boolean
	persisted: boolean
	saved: boolean
	saving: boolean
	testing: boolean
	fetching: boolean
	canTest: boolean
	changedAddress: boolean
	modelNotice: string
	error: string
	models: string[]
	result?: SpeechConnectionTestResult
}

export function speechModelCapabilities(
	connection: AIConnection,
	provider: SpeechProviderPreset,
): SpeechModel | undefined {
	return provider.models.find(model => model.id === connection.model && model.protocol === connection.protocol)
}

export function speechAudioLimit(connection: AIConnection): number {
	return (connection.protocol === 'gemini' ? 14 : 16) * 1024 * 1024
}

// Match settings.go's credential destination fence, without treating model/language
// query parameters as a new credential destination.
export function sameSpeechSecretDestination(previous: AIConnection, next: AIConnection): boolean {
	const normalizeBase = (value: string) => value.trim().replace(/\/+$/, '')
	const protocol = (connection: AIConnection) => connection.protocol ||
		(connection.kind === 'transcription' ? 'openai-transcription' : 'openai-chat')
	const native = new Set([
		'dashscope-asr', 'qwen-asr-realtime', 'volcengine-asr', 'openai-realtime',
		'elevenlabs-realtime', 'soniox-realtime', 'dashscope-file-asr',
		'elevenlabs-transcription', 'mimo-asr', 'sensevoice',
	])
	const previousBase = normalizeBase(previous.base_url)
	const nextBase = normalizeBase(next.base_url)
	if (previousBase !== nextBase) return false
	if (!native.has(protocol(previous)) && !native.has(protocol(next))) return true
	const resolvedBase = (base: string, connection: AIConnection) => connection.speech
		? base.replaceAll('{workspace_id}', connection.speech.workspace_id ?? '').replace(/\/+$/, '')
		: base
	return protocol(previous) === protocol(next)
		&& resolvedBase(previousBase, previous) === resolvedBase(nextBase, next)
		&& (previous.speech?.workspace_id ?? '') === (next.speech?.workspace_id ?? '')
		&& (previous.speech?.app_id ?? '') === (next.speech?.app_id ?? '')
}
