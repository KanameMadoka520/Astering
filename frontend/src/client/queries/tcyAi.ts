import {queryOptions, useMutation, useQueryClient} from '@tanstack/vue-query'
import {
	tcyAiModels, tcyAiSettings, tcyAiSaveSettings, tcyAiTest, tcyAiRun, tcyAiTranscribe, tcyAiCleanup,
	tcyAiSpeechProviders,
	type Connection,
	type SpeechProvider as Provider,
	type SpeechModel as ProviderModel,
	type TcyAiSettingsResponse, type ModelCapabilities, type TcyAiModelsData, type TcyAiSaveSettingsData, type TcyAiTestData, type TcyAiRunData, type TcyAiTranscribeData,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {useSecretMutation} from './secretMutation'
import {agentReceipt, planAgentRefresh, useAgentRefresh, type AgentReceipt} from './tcyConversations'

export type AIProtocol = NonNullable<Connection['protocol']>
export type SpeechOptions = NonNullable<Connection['speech']>
export type SpeechModel = Omit<Required<ProviderModel>, 'protocol'> & {protocol: AIProtocol}
export type SpeechProvider = Omit<Required<Provider>, 'models'> & {models: SpeechModel[]}
export type SearchProtocol = '' | 'deepseek' | 'openai-responses' | 'openai-chat' | 'anthropic' | 'gemini'
export type AIConnection = {
	copy_key_from?: string,
	speech?: SpeechOptions,
	web_search_protocol?: SearchProtocol,
	web_search_base_url?: string,
	web_search_model?: string,
	context_window?: number,
	max_output_tokens?: number,
	auto_compact_tokens?: number,
	disable_auto_compact?: boolean,
	input_types?: string[],
	output_token_field?: '' | 'max_tokens' | 'max_completion_tokens',
	resolved?: ModelCapabilities,
	non_streaming?: boolean,
	protocol: AIProtocol,
	id: string,
	name: string,
	base_url: string,
	model: string,
	kind: 'chat' | 'transcription',
	api_key: string,
	has_key: boolean,
}
export type AISettings = {persona?: 'arona' | 'none', connections: AIConnection[], assistant: string, transcription: string, cleanup: string}
export type AIRunResult = {reply: string, actions: {tool: string, arguments: string, result: string, success: boolean}[]}

const settingsKey = ['tcymc-ai', 'settings'] as const

export function normalizeAISettings(s: TcyAiSettingsResponse): AISettings {
	return {
		persona: s.persona || 'arona',
		connections: (s.connections ?? []).map(c => ({
			speech: c.speech ? {...c.speech, hotwords: [...(c.speech.hotwords ?? [])]} : undefined,
			web_search_protocol: c.web_search_protocol || '',
			web_search_base_url: c.web_search_base_url || '',
			web_search_model: c.web_search_model || '',
			context_window: c.context_window,
			max_output_tokens: c.max_output_tokens,
			auto_compact_tokens: c.auto_compact_tokens,
			disable_auto_compact: c.disable_auto_compact,
			input_types: c.input_types ?? [],
			output_token_field: c.output_token_field,
			resolved: c.resolved ?? undefined,
			non_streaming: c.non_streaming,
			protocol: c.protocol ?? (c.kind === 'transcription' ? 'openai-transcription' : 'openai-chat'),
			id: c.id ?? '',
			name: c.name ?? '',
			base_url: c.base_url ?? '',
			model: c.model ?? '',
			kind: c.kind ?? 'chat',
			api_key: '',
			has_key: c.has_key ?? false,
		})),
		assistant: s.assistant ?? '',
		transcription: s.transcription ?? '',
		cleanup: s.cleanup ?? '',
	}
}

export function speechProvidersQuery() {
	return queryOptions({
		queryKey: ['tcymc-ai', 'speech-providers'],
		queryFn: async ({signal}): Promise<SpeechProvider[]> =>
			normalizeSpeechProviders((await tcyAiSpeechProviders({signal})).data ?? []),
		meta: {handlesError: true},
	})
}

const speechProtocols = new Set<AIProtocol>([
	'openai-transcription',
	'openai-audio',
	'gemini',
	'dashscope-asr',
	'qwen-asr-realtime',
	'dashscope-file-asr',
	'volcengine-asr',
	'openai-realtime',
	'elevenlabs-transcription',
	'elevenlabs-realtime',
	'soniox-realtime',
	'mimo-asr',
	'sensevoice',
])

function isSpeechProtocol(protocol: string | undefined): protocol is AIProtocol {
	return speechProtocols.has(protocol as AIProtocol)
}

export function normalizeSpeechProviders(providers: Provider[]): SpeechProvider[] {
	return providers.filter(provider => provider.id && provider.name).map(provider => ({
		id: provider.id!,
		name: provider.name!,
		docs_url: provider.docs_url ?? '',
		key_url: provider.key_url ?? '',
		local: provider.local ?? false,
		models: (provider.models ?? []).flatMap((model): SpeechModel[] => {
			if (!model.id || !model.base_url || !isSpeechProtocol(model.protocol)) return []
			return [{
				id: model.id,
				name: model.name || model.id,
				protocol: model.protocol,
				base_url: model.base_url,
				recommended: model.recommended ?? false,
				sample_rate: model.sample_rate ?? 0,
				language: model.language ?? false,
				prompt: model.prompt ?? false,
				hotwords: model.hotwords ?? false,
				vocabulary: model.vocabulary ?? false,
				workspace: model.workspace ?? false,
				app_id: model.app_id ?? false,
				resource_id: model.resource_id ?? false,
			}]
		}),
	}))
}

export function aiSettingsQuery() {
	return queryOptions({
		queryKey: settingsKey,
		queryFn: async ({signal}): Promise<AISettings> => {
			const s = (await tcyAiSettings({signal})).data
			return normalizeAISettings(s)
		},
		// The settings page and the assistant each show their own error with a retry.
		meta: {handlesError: true},
	})
}

export function useSaveAISettings() {
	const client = useQueryClient()
	return useSecretMutation(contextMutationOptions({
		mutationFn: async (body: TcyAiSaveSettingsData['body']) => {
			await client.cancelQueries({queryKey: settingsKey})
			return normalizeAISettings((await tcyAiSaveSettings({body})).data)
		},
		onSuccess: data => {
			client.setQueryData(settingsKey, data)
			void client.invalidateQueries({queryKey: ['notes', 'live-connections']})
		},
		// The form reports each save on the card or section it saved, so a toast would say it twice.
		toastError: () => false,
	}))
}

export function useTestAIConnection() {
	return useSecretMutation(contextMutationOptions({
		mutationFn: async (body: TcyAiTestData['body']) => (await tcyAiTest({body})).data,
	}))
}

export function useRunAI() {
	const refresh = useAgentRefresh()
	return useMutation(contextMutationOptions({
		mutationFn: async (body: TcyAiRunData['body']): Promise<AIRunResult> => {
			const r = (await tcyAiRun({body})).data
			return {reply: r.reply ?? '', actions: (r.actions ?? []).map(a => ({tool: a.tool ?? '', arguments: a.arguments ?? '', result: a.result ?? '', success: a.success ?? false}))}
		},
		// Only the run's own successful write receipts refresh caches.
		onSuccess: data => {
			const receipts = data.actions.flatMap((action, index): AgentReceipt[] => {
				const receipt = agentReceipt(`run:${index}`, action)
				return receipt ? [receipt] : []
			})
			if (receipts.length) refresh.mutate(planAgentRefresh(receipts))
		},
	}))
}

export function useTranscribeAI() {
	return useSecretMutation(contextMutationOptions({
		mutationFn: async ({signal, ...body}: TcyAiTranscribeData['body'] & {signal?: AbortSignal}) =>
			(await tcyAiTranscribe({body, signal})).data,
	}))
}

export function useCleanupAI() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({text, signal}: {text: string, signal?: AbortSignal}) => (await tcyAiCleanup({body: {text}, signal})).data,
	}))
}

export function useFetchAIModels() {
	return useSecretMutation(contextMutationOptions({
		mutationFn: async (body: TcyAiModelsData['body']) => (await tcyAiModels({body})).data,
	}))
}
