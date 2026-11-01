<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useEventListener} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {onBeforeRouteLeave, onBeforeRouteUpdate, useRouter, type RouteLocationNormalized} from 'vue-router'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import ModelPicker from './ModelPicker.vue'
import WebSearchEvidence from './WebSearchEvidence.vue'
import SegmentedControl, {type SegmentedOption} from '@/components/input/SegmentedControl.vue'
import Message from '@/components/misc/Message.vue'
import type {ListedModel, WebSearchResult} from '@/client/generated'
import type {AIConnection, AISettings} from '@/client/queries/tcyAi'
import {useFetchAIModels, useSaveAISettings, useTestAIConnection} from '@/client/queries/tcyAi'
import {isRequestContextAbort} from '@/client/requestContext'
import {audioChatFile} from '@/helpers/tcyAudio'

const props = defineProps<{initial: AISettings}>()
const {t, locale} = useI18n({useScope: 'global'})

type Settings = AISettings
type Tab = 'chat' | 'transcription' | 'roles'
type Role = 'assistant' | 'transcription' | 'cleanup'
type Tone = 'neutral' | 'warning' | 'success' | 'danger'

const ROLES: Role[] = ['assistant', 'transcription', 'cleanup']
const MAX_CONNECTIONS = 20
const MAX_TEST_AUDIO_BYTES = 16 * 1024 * 1024

function roleKind(role: Role) {
	return role === 'transcription' ? 'transcription' : 'chat'
}

function initialDraft(source = props.initial): Settings {
	return {
		connections: source.connections.map(c => ({
			...c,
			input_types: [...(c.input_types ?? [])],
			output_token_field: c.output_token_field ?? '',
			web_search_protocol: c.web_search_protocol || '',
			web_search_base_url: c.web_search_base_url || '',
			web_search_model: c.web_search_model || '',
			api_key: '',
		})),
		assistant: source.assistant,
		persona: source.persona || 'arona',
		transcription: source.transcription,
		cleanup: source.cleanup,
	}
}

const draft = ref<Settings>(initialDraft())
const baseline = ref(JSON.stringify(initialDraft()))
const baselineSettings = computed(() => JSON.parse(baseline.value) as Settings)
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)

// A typed API key or base URL exists only in this draft: leaving asks first, and the route is followed only after
// an explicit discard.
const router = useRouter()
const leaveTarget = ref<string | null>(null)
let leaving = false
function confirmLeave(to: RouteLocationNormalized) {
	if (leaving || !dirty.value) return true
	leaveTarget.value = to.fullPath
	return false
}
onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)
async function discardAndLeave() {
	const target = leaveTarget.value
	if (target === null) return
	leaving = true
	leaveTarget.value = null
	const failure = await router.push(target)
	// Another guard stopped the navigation: the draft is still here and still protected.
	if (failure) leaving = false
}
useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
	if (!dirty.value) return
	event.preventDefault()
	// Older browsers only ask when a return value is set.
	event.returnValue = ''
})
const saveError = ref('')
const activeTab = ref<Tab>('chat')
useEventListener(window, 'vikunja:ai-settings-tab', (event: Event) => {
	const tab = (event as CustomEvent).detail
	if (['chat', 'transcription', 'roles'].includes(tab)) activeTab.value = tab
})
const visibleConnections = computed(() => draft.value.connections.filter(c => c.kind === activeTab.value))
const tabOptions = computed<SegmentedOption<Tab>[]>(() => [
	{
		value: 'chat',
		label: t('modelSettings.chat'),
		count: draft.value.connections.filter(c => c.kind === 'chat').length,
	},
	{
		value: 'transcription',
		label: t('modelSettings.transcription'),
		count: draft.value.connections.filter(c => c.kind === 'transcription').length,
	},
	{
		value: 'roles',
		label: t('modelSettings.roles'),
	},
])
const savingPart = ref('')
const cardErrors = ref<Record<string, string>>({})
const savedCards = ref<Record<string, string>>({})
function cardStamp(c: AIConnection) {
	return JSON.stringify(c)
}
function persisted(id: string) {
	return props.initial.connections.some(c => c.id === id)
}

// Never overwrite unsaved edits with a background refetch.
watch(() => props.initial, () => {
	if (dirty.value) return
	draft.value = initialDraft()
	baseline.value = JSON.stringify(draft.value)
})

// Expansion is seeded once per connection so saving or adding another row never collapses an open editor.
const expanded = ref<Record<string, boolean>>({})
watch(() => draft.value.connections.map(c => c.id), () => {
	for (const connection of draft.value.connections) {
		if (connection.id in expanded.value) continue
		const siblings = draft.value.connections.filter(c => c.kind === connection.kind).length
		expanded.value[connection.id] = !persisted(connection.id) || siblings === 1
	}
}, {immediate: true})
function toggleConnection(id: string) {
	expanded.value[id] = !expanded.value[id]
}

const save = useSaveAISettings()
const test = useTestAIConnection()
const testingId = ref('')
const testResults = ref<Record<string, {ok: boolean, text: string, endpoint: string, stamp: string}>>({})
const modelFetcher = useFetchAIModels()
const fetchingId = ref('')
const modelLists = ref<Record<string, {models: string[], details: ListedModel[], fingerprint: string}>>({})
const modelNotice = ref<Record<string, string>>({})
const chatModels = computed(() => draft.value.connections.filter(c => c.kind === 'chat'))
const speechModels = computed(() => draft.value.connections.filter(c => c.kind === 'transcription'))
const testAudio = ref<File>()

const searchTest = useTestAIConnection()
const searchingId = ref('')
const searchResults = ref<Record<string, WebSearchResult>>({})
const searchErrors = ref<Record<string, string>>({})
const searchStamps = ref<Record<string, string>>({})
const searchProtocols = {
	'': '',
	deepseek: 'DeepSeek Search API',
	'openai-responses': 'OpenAI Responses · web_search',
	'openai-chat': 'OpenAI Chat · web_search_options',
	anthropic: 'Anthropic · web_search_20250305',
	gemini: 'Gemini · Google Search',
}
function searchFingerprint(c: AIConnection) {
	return JSON.stringify([
		c.base_url,
		c.model,
		c.api_key,
		c.web_search_protocol,
		c.web_search_base_url,
		c.web_search_model,
		c.non_streaming,
		c.max_output_tokens,
	])
}
function searchEndpoint(c: AIConnection) {
	const base = c.web_search_base_url?.trim().replace(/\/+$/, '')
		|| (c.web_search_protocol === 'deepseek' && isOfficialDeepSeek(c)
			? 'https://api.deepseek.com/v1'
			: c.base_url.trim().replace(/\/+$/, ''))
	if (c.web_search_protocol === 'deepseek') return base + '/tools/search'
	return endpoint({
		...c,
		base_url: base,
		protocol: c.web_search_protocol || 'openai-chat',
		model: c.web_search_model || c.model,
	})
}
async function testSearch(c: AIConnection) {
	if (searchTest.isPending.value) return
	const stamp = searchFingerprint(c)
	delete searchResults.value[c.id]
	delete searchErrors.value[c.id]
	searchStamps.value[c.id] = stamp
	searchingId.value = c.id
	try {
		const result = await searchTest.mutateAsync({connection_id: c.id, web_search: true, connection: {...c}})
		if (stamp === searchFingerprint(c) && result.search) searchResults.value[c.id] = result.search
	} catch (e) {
		if (isRequestContextAbort(e)) return
		if (stamp === searchFingerprint(c)) searchErrors.value[c.id] = e instanceof Error ? e.message : t('webSearch.failed')
	} finally {
		searchingId.value = ''
	}
}

function addConnection() {
	const transcription = activeTab.value === 'transcription'
	draft.value.connections.push({
		id: crypto.randomUUID(),
		name: '',
		base_url: '',
		model: '',
		kind: transcription ? 'transcription' : 'chat',
		protocol: transcription ? 'openai-transcription' : 'openai-chat',
		context_window: 0,
		max_output_tokens: 0,
		auto_compact_tokens: 0,
		input_types: [],
		output_token_field: '',
		web_search_protocol: '',
		web_search_base_url: '',
		web_search_model: '',
		api_key: '',
		has_key: false,
	})
}

function savePayload(settings: Settings) {
	return {
		...settings,
		connections: settings.connections.map(c => ({
			web_search_protocol: c.web_search_protocol,
			web_search_base_url: c.web_search_base_url,
			web_search_model: c.web_search_model,
			id: c.id,
			name: c.name,
			kind: c.kind,
			protocol: c.protocol,
			base_url: c.base_url,
			model: c.model,
			api_key: c.api_key,
			non_streaming: c.non_streaming,
			context_window: c.context_window || 0,
			max_output_tokens: c.max_output_tokens || 0,
			auto_compact_tokens: c.auto_compact_tokens || 0,
			disable_auto_compact: c.disable_auto_compact,
			input_types: c.input_types,
			output_token_field: c.output_token_field,
		})),
	}
}

// Saves one connection into the saved baseline so other unfinished drafts are never submitted.
async function saveConnection(connection: AIConnection) {
	if (save.isPending.value) return
	const id = connection.id
	const submitted = cardStamp(connection)
	const payload = initialDraft()
	const index = payload.connections.findIndex(c => c.id === id)
	if (index < 0) payload.connections.push({...connection})
	else payload.connections[index] = {...connection}
	// A changed connection purpose must not leave incompatible role assignments.
	for (const role of ROLES) {
		if (payload[role] === id && connection.kind !== roleKind(role)) payload[role] = ''
	}
	savingPart.value = id
	cardErrors.value[id] = ''
	delete savedCards.value[id]
	try {
		const saved = initialDraft(await save.mutateAsync(savePayload(payload)))
		const currentIndex = draft.value.connections.findIndex(c => c.id === id)
		const clean = saved.connections.find(c => c.id === id)!
		if (currentIndex >= 0 && cardStamp(draft.value.connections[currentIndex]) === submitted) {
			draft.value.connections[currentIndex] = clean
			savedCards.value[id] = cardStamp(clean)
		}
		baseline.value = JSON.stringify(saved)
	} catch (error) {
		if (!isRequestContextAbort(error)) {
			cardErrors.value[id] = error instanceof Error ? error.message : t('settingsDraft.failed')
		}
	} finally {
		savingPart.value = ''
	}
}

const pendingRemove = ref<AIConnection | null>(null)
function dropConnection(id: string) {
	draft.value.connections = draft.value.connections.filter(c => c.id !== id)
	for (const role of ROLES) if (draft.value[role] === id) draft.value[role] = ''
}
function requestRemove(connection: AIConnection) {
	if (save.isPending.value) return
	if (persisted(connection.id)) pendingRemove.value = connection
	else dropConnection(connection.id)
}
// The dialog stays open and busy while the request runs (Modal waits for the returned promise), so a failure is
// reported where the removal was asked for, and not as an unsaved edit of the card.
const removeError = ref('')
function closeRemove() {
	pendingRemove.value = null
	removeError.value = ''
}
async function confirmRemove() {
	const target = pendingRemove.value
	if (!target || save.isPending.value) return
	const id = target.id
	const payload = initialDraft()
	payload.connections = payload.connections.filter(c => c.id !== id)
	for (const role of ROLES) if (payload[role] === id) payload[role] = ''
	removeError.value = ''
	try {
		baseline.value = JSON.stringify(initialDraft(await save.mutateAsync(savePayload(payload))))
	} catch (error) {
		if (!isRequestContextAbort(error) && pendingRemove.value === target) {
			removeError.value = error instanceof Error ? error.message : t('settingsDraft.failed')
		}
		return
	}
	if (pendingRemove.value === target) closeRemove()
	dropConnection(id)
}

function rolesStamp(settings: Settings) {
	return JSON.stringify([settings.assistant, settings.transcription, settings.cleanup, settings.persona])
}
const rolesDirty = computed(() => rolesStamp(draft.value) !== rolesStamp(baselineSettings.value))
const rolesSaved = ref('')
async function saveRoles() {
	if (save.isPending.value) return
	saveError.value = ''
	rolesSaved.value = ''
	const roles = {
		assistant: draft.value.assistant,
		transcription: draft.value.transcription,
		cleanup: draft.value.cleanup,
		persona: draft.value.persona,
	}
	const payload = {...initialDraft(), ...roles}
	if ([roles.assistant, roles.transcription, roles.cleanup].some(id => id && !payload.connections.some(c => c.id === id))) {
		saveError.value = t('modelSettings.saveConnectionFirst')
		return
	}
	savingPart.value = 'roles'
	try {
		const clean = initialDraft(await save.mutateAsync(savePayload(payload)))
		for (const role of ROLES) if (draft.value[role] === roles[role]) draft.value[role] = clean[role]
		baseline.value = JSON.stringify(clean)
		rolesSaved.value = rolesStamp(clean)
	} catch (error) {
		if (!isRequestContextAbort(error)) saveError.value = error instanceof Error ? error.message : t('settingsDraft.failed')
	} finally {
		savingPart.value = ''
	}
}

async function readAudio(file: Blob) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result).split(',')[1])
		reader.onerror = reject
		reader.readAsDataURL(file)
	})
}

async function testConnection(connection: AIConnection) {
	if (test.isPending.value) return
	const {id, kind} = connection
	const stamp = cardStamp(connection)
	const fail = (text: string) => {
		testResults.value[id] = {ok: false, text, endpoint: '', stamp}
	}
	delete testResults.value[id]
	let audio = ''
	let filename = testAudio.value?.name ?? 'audio.webm'
	if (kind === 'transcription') {
		if (!testAudio.value) return fail(t('tcymc.text.choose_an_audio_file_for_testing_first'))
		if (testAudio.value.size > MAX_TEST_AUDIO_BYTES) return fail(t('tcymc.text.test_audio_must_not_exceed_16_mib'))
		let file: Blob = testAudio.value
		if (connection.protocol === 'openai-audio') {
			try {
				const converted = await audioChatFile(file, filename)
				file = converted.file
				filename = converted.filename
			} catch {
				return fail(t('tcymc.audioConversionFailed'))
			}
		}
		audio = await readAudio(file)
	}
	testingId.value = id
	try {
		const result = await test.mutateAsync({connection_id: id, audio, filename})
		testResults.value[id] = {
			ok: true,
			text: [result.text, result.warning].filter(Boolean).join('\n'),
			endpoint: result.endpoint ?? '',
			stamp,
		}
	} catch (e) {
		if (isRequestContextAbort(e)) return
		fail(e instanceof Error ? e.message : t('tcymc.text.connection_test_failed_check_the_url_key_model'))
	} finally {
		testingId.value = ''
	}
}
function currentTest(c: AIConnection) {
	const result = testResults.value[c.id]
	return result?.stamp === cardStamp(c) ? result : undefined
}

function protocols(kind: string) {
	return kind === 'transcription'
		? ['openai-transcription', 'openai-audio', 'gemini'] as const
		: ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const
}
const protocolNames = {
	'openai-chat': 'OpenAI Chat Completions',
	'openai-responses': 'OpenAI Responses',
	anthropic: 'Anthropic Messages',
	gemini: 'Gemini generateContent',
	'openai-transcription': 'OpenAI Audio Transcriptions',
	'openai-audio': 'OpenAI Chat Audio',
}
function changeKind(c: AIConnection) {
	c.protocol = c.kind === 'chat' ? 'openai-chat' : 'openai-transcription'
	if (c.kind !== 'chat') c.web_search_protocol = ''
	activeTab.value = c.kind
	for (const role of ROLES) {
		if (draft.value[role] === c.id && c.kind !== roleKind(role)) draft.value[role] = ''
	}
}
function endpoint(c: AIConnection, models = false) {
	const base = c.base_url.trim().replace(/\/+$/, '')
	if (!base) return t('tcymc.text.enter_a_base_url_to_see_the_endpoint')
	const geminiModel = encodeURIComponent(c.model.replace(/^models\//, '') || '{model}')
	const paths = {
		'openai-chat': '/chat/completions',
		'openai-responses': '/responses',
		anthropic: '/messages',
		'openai-transcription': '/audio/transcriptions',
		'openai-audio': '/chat/completions',
		gemini: `/models/${geminiModel}:generateContent`,
	}
	if (models && isOfficialDeepSeek(c)) return 'https://api.deepseek.com/models'
	if (models) return base + '/models'
	if (c.protocol === 'gemini' && !c.non_streaming) {
		return base + paths.gemini.replace(':generateContent', ':streamGenerateContent?alt=sse')
	}
	return base + paths[c.protocol]
}
function fingerprint(c: AIConnection) {
	return JSON.stringify([c.base_url, c.protocol, c.kind])
}
function loadedModels(c: AIConnection) {
	const saved = modelLists.value[c.id]
	return saved?.fingerprint === fingerprint(c) ? saved.models : []
}
async function fetchModels(c: AIConnection) {
	if (modelFetcher.isPending.value || !c.base_url) return
	const stamp = fingerprint(c)
	fetchingId.value = c.id
	try {
		const result = await modelFetcher.mutateAsync({
			id: c.id,
			base_url: c.base_url,
			protocol: c.protocol,
			kind: c.kind,
			api_key: c.api_key,
		})
		if (stamp !== fingerprint(c)) return
		modelLists.value[c.id] = {models: result.models ?? [], details: result.details ?? [], fingerprint: stamp}
		modelNotice.value[c.id] = result.truncated
			? t('tcymc.text.the_provider_has_many_models_only_the_first')
			: result.models?.length
				? t('tcymc.text.model_list_updated_you_can_also_enter_a')
				: t('tcymc.text.the_provider_returned_no_models_enter_a_model')
	} catch (e) {
		if (isRequestContextAbort(e)) return
		modelNotice.value[c.id] = t('tcymc.text.could_not_fetch_models_some_providers_do_not')
	} finally {
		fetchingId.value = ''
	}
}
function isOfficialDeepSeek(c: AIConnection) {
	try {
		const url = new URL(c.base_url)
		return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && (!url.port || url.port === '443')
	} catch {
		return false
	}
}
function listedModel(c: AIConnection) {
	const list = modelLists.value[c.id]
	return list?.fingerprint === fingerprint(c) ? list.details.find(m => m.id === c.model) : undefined
}
function applyCapabilities(c: AIConnection) {
	const model = listedModel(c)
	if (!model) return
	if (model.context_window) c.context_window = model.context_window
	if (model.max_output_tokens) c.max_output_tokens = model.max_output_tokens
	if (model.input_types?.length) c.input_types = [...model.input_types]
}
function capabilityKey(c: AIConnection) {
	return JSON.stringify([c.context_window || 0, c.max_output_tokens || 0, c.input_types ?? [], c.output_token_field || ''])
}
function changeInputTypes(c: AIConnection, event: Event) {
	const value = (event.target as HTMLSelectElement).value
	c.input_types = value ? value.split(',') : []
}
function changedAddress(c: AIConnection) {
	const previous = props.initial.connections.find(s => s.id === c.id)
	return previous?.has_key
		&& previous.base_url.replace(/\/+$/, '') !== c.base_url.trim().replace(/\/+$/, '')
		&& !c.api_key
}
function savedMatches(c: AIConnection) {
	const saved = props.initial.connections.find(s => s.id === c.id)
	return saved
		&& saved.base_url === c.base_url
		&& saved.model === c.model
		&& saved.protocol === c.protocol
		&& saved.kind === c.kind
		&& Boolean(saved.non_streaming) === Boolean(c.non_streaming)
		&& capabilityKey(saved) === capabilityKey(c)
		&& !c.api_key
}

const compactNumber = computed(() => new Intl.NumberFormat(locale.value, {
	notation: 'compact',
	maximumFractionDigits: 1,
}))
function host(url: string) {
	try {
		return new URL(url).host
	} catch {
		return url.trim()
	}
}
function capabilityChips(c: AIConnection) {
	const resolved = savedMatches(c) ? c.resolved : undefined
	const inputs = c.input_types?.length ? c.input_types : resolved?.input_types ?? []
	const context = c.context_window || resolved?.context_window || 0
	const output = c.max_output_tokens || resolved?.max_output_tokens || 0
	const chips: string[] = []
	if (inputs.includes('image')) chips.push(t('modelConfig.vision'))
	else if (inputs.includes('text')) chips.push(t('modelConfig.text'))
	if (context) chips.push(t('modelSettings.chipContext', {tokens: compactNumber.value.format(context)}))
	if (output) chips.push(t('modelSettings.chipOutput', {tokens: compactNumber.value.format(output)}))
	if (c.kind === 'chat' && c.web_search_protocol) chips.push(t('webSearch.title'))
	if (c.non_streaming) chips.push(t('modelSettings.chipNonStreaming'))
	if (c.kind === 'chat' && c.disable_auto_compact) chips.push(t('modelConfig.autoCompactOff'))
	return chips
}
function usedBy(c: AIConnection) {
	const names: string[] = []
	if (props.initial.assistant === c.id) names.push(t('tcymc.text.task_ai_assistant'))
	if (props.initial.transcription === c.id) names.push(t('tcymc.text.speech_recognition'))
	if (props.initial.cleanup === c.id) names.push(t('tcymc.text.transcript_cleanup'))
	return names
}
function keyStatus(c: AIConnection) {
	if (c.api_key) return t('modelSettings.keyPending')
	return c.has_key ? t('modelSettings.keyStored') : t('modelSettings.keyMissing')
}
function connectionStatus(c: AIConnection): {tone: Tone, icon: IconProp, text: string} {
	if (!persisted(c.id)) {
		return {tone: 'warning', icon: 'circle-info', text: t('modelSettings.statusDraft')}
	}
	const saved = baselineSettings.value.connections.find(s => s.id === c.id)
	if (!saved || JSON.stringify(saved) !== cardStamp(c)) {
		return {tone: 'warning', icon: 'pen', text: t('modelSettings.statusEdited')}
	}
	const result = currentTest(c)
	if (result?.ok) return {tone: 'success', icon: 'check', text: t('modelSettings.statusTested')}
	if (result) return {tone: 'danger', icon: 'exclamation-circle', text: t('modelSettings.statusTestFailed')}
	return {tone: 'neutral', icon: 'circle-info', text: t('modelSettings.statusSaved')}
}
</script>

<template>
	<div class="tcy-settings">
		<SegmentedControl
			v-model="activeTab"
			class="model-tabs"
			:options="tabOptions"
			:label="t('modelSettings.tabs')"
		/>

		<section
			v-show="activeTab !== 'roles'"
			class="tcy-panel"
			aria-labelledby="ai-connections-title"
		>
			<header class="tcy-panel__header">
				<h2
					id="ai-connections-title"
					class="tcy-panel__title"
					data-tour="ai-connections"
				>
					{{ t('tcymc.text.model_connections') }}
				</h2>
				<p class="tcy-panel__description">
					{{ t('tcymc.text.choose_your_provider_s_protocol_and_include_its') }}
				</p>
			</header>
			<p
				v-if="!visibleConnections.length"
				class="empty"
			>
				{{ t('tcymc.text.no_connections_yet_add_one_then_assign_it') }}
			</p>
			<div
				v-else
				class="connection-list"
			>
				<form
					v-for="connection in visibleConnections"
					:key="connection.id"
					class="connection"
					:class="{'is-expanded': expanded[connection.id]}"
					:aria-labelledby="`${connection.id}-name`"
					@submit.prevent="saveConnection(connection)"
				>
					<div class="connection__summary">
						<div class="connection__identity">
							<h3
								:id="`${connection.id}-name`"
								class="connection__name"
							>
								{{ connection.name || t('tcymc.text.new_model') }}
							</h3>
							<p class="connection__meta">
								<span>{{ protocolNames[connection.protocol] }}</span>
								<span v-if="connection.base_url">{{ host(connection.base_url) }}</span>
								<span
									v-if="connection.model"
									class="connection__model"
								>{{ connection.model }}</span>
							</p>
						</div>
						<ul class="connection__chips">
							<li
								v-for="chip in capabilityChips(connection)"
								:key="chip"
								class="chip"
							>
								{{ chip }}
							</li>
							<li
								v-if="usedBy(connection).length"
								class="chip is-accent"
							>
								{{ t('modelSettings.usedBy', {features: usedBy(connection).join(', ')}) }}
							</li>
							<li class="chip is-quiet">
								{{ keyStatus(connection) }}
							</li>
						</ul>
						<div class="connection__end">
							<span
								class="connection__status"
								:class="`is-${connectionStatus(connection).tone}`"
							>
								<Icon
									:icon="connectionStatus(connection).icon"
									aria-hidden="true"
								/>
								{{ connectionStatus(connection).text }}
							</span>
							<XButton
								variant="tertiary"
								class="is-small connection__toggle"
								:icon="expanded[connection.id] ? 'chevron-up' : 'chevron-down'"
								:aria-expanded="expanded[connection.id] ? 'true' : 'false'"
								:aria-controls="`${connection.id}-body`"
								:aria-describedby="`${connection.id}-name`"
								@click="toggleConnection(connection.id)"
							>
								{{ expanded[connection.id] ? t('modelSettings.collapse') : t('modelSettings.edit') }}
							</XButton>
						</div>
					</div>

					<div
						v-show="expanded[connection.id]"
						:id="`${connection.id}-body`"
						class="connection__body"
					>
						<Message
							v-if="changedAddress(connection)"
							variant="warning"
						>
							{{ t('mailServer.keyChange') }}
						</Message>
						<div class="fields">
							<label class="ai-field">
								<span class="ai-field__label">{{ t('tcymc.text.connection_name') }}</span>
								<input
									v-model="connection.name"
									class="input"
									required
									maxlength="100"
									:placeholder="t('tcymc.text.for_example_my_task_assistant')"
								>
							</label>
							<label class="ai-field">
								<span class="ai-field__label">{{ t('tcymc.text.connection_purpose') }}</span>
								<span class="select is-fullwidth">
									<select
										v-model="connection.kind"
										@change="changeKind(connection)"
									>
										<option value="chat">{{ t('tcymc.text.text_chat_and_tool_calling') }}</option>
										<option value="transcription">{{ t('tcymc.text.speech_recognition_and_transcription') }}</option>
									</select>
								</span>
							</label>
							<label class="ai-field">
								<span class="ai-field__label">{{ t('tcymc.text.request_protocol') }}</span>
								<span class="select is-fullwidth">
									<select v-model="connection.protocol">
										<option
											v-for="protocol in protocols(connection.kind)"
											:key="protocol"
											:value="protocol"
										>{{ protocolNames[protocol] }}</option>
									</select>
								</span>
							</label>
							<label class="ai-field">
								<span class="ai-field__label">{{ t('tcymc.text.api_base_url') }}</span>
								<input
									v-model="connection.base_url"
									class="input"
									required
									type="url"
									placeholder="https://api.example.com/v1"
									autocomplete="off"
								>
							</label>
							<div class="ai-field">
								<ModelPicker
									v-model="connection.model"
									:models="loadedModels(connection)"
									:label="t('tcymc.text.model_id')"
									:placeholder="t('tcymc.text.model_name_provided_by_your_service')"
									required
								/>
							</div>
							<label class="ai-field">
								<span class="ai-field__label">{{ t('tcymc.apiKey') }}</span>
								<input
									v-model="connection.api_key"
									class="input"
									type="password"
									autocomplete="new-password"
									:placeholder="connection.has_key && persisted(connection.id)
										? t('tcymc.text.saved_leave_blank_to_keep_the_current_key')
										: t('tcymc.text.enter_a_key_leave_blank_only_if_the')"
								>
							</label>
							<label
								v-if="connection.protocol !== 'openai-transcription'"
								class="stream-choice"
							>
								<input
									v-model="connection.non_streaming"
									type="checkbox"
								>
								<span>{{ t('flow.nonStreaming') }}</span>
							</label>
						</div>

						<details
							v-if="connection.kind === 'chat'"
							class="model-options"
						>
							<summary>
								{{ t('webSearch.title') }} ·
								{{ connection.web_search_protocol ? t('webSearch.enabled') : t('webSearch.disabled') }}
							</summary>
							<p class="model-options__help">
								{{ t('webSearch.help') }}
							</p>
							<div class="fields">
								<label class="ai-field">
									<span class="ai-field__label">{{ t('webSearch.protocol') }}</span>
									<span class="select is-fullwidth">
										<select
											v-model="connection.web_search_protocol"
											:aria-label="t('webSearch.protocol')"
										>
											<option
												v-for="(name, key) in searchProtocols"
												:key="key"
												:value="key"
											>{{ key ? name : t('webSearch.disabled') }}</option>
										</select>
									</span>
								</label>
								<template v-if="connection.web_search_protocol">
									<div class="ai-field">
										<label class="ai-field">
											<span class="ai-field__label">{{ t('webSearch.base') }}</span>
											<input
												v-model="connection.web_search_base_url"
												:aria-label="t('webSearch.base')"
												:aria-describedby="`${connection.id}-search-base-hint`"
												class="input"
												type="url"
												:placeholder="t('webSearch.inheritBase')"
											>
										</label>
										<p
											:id="`${connection.id}-search-base-hint`"
											class="ai-field__hint"
										>
											{{ t('webSearch.baseHelp') }}
										</p>
									</div>
									<div
										v-if="connection.web_search_protocol !== 'deepseek'"
										class="ai-field"
									>
										<ModelPicker
											v-model="connection.web_search_model"
											:models="loadedModels(connection)"
											:label="t('webSearch.model')"
											:placeholder="connection.model"
										/>
										<p class="ai-field__hint">
											{{ t('webSearch.modelHelp') }}
										</p>
									</div>
								</template>
							</div>
							<template v-if="connection.web_search_protocol">
								<p class="model-options__endpoint">
									{{ t('webSearch.endpoint') }} <code>{{ searchEndpoint(connection) }}</code>
								</p>
								<p class="model-options__help">
									{{ t('webSearch.testHelp') }}
								</p>
								<XButton
									type="button"
									variant="secondary"
									:loading="searchingId === connection.id"
									@click="testSearch(connection)"
								>
									{{ t('webSearch.test') }}
								</XButton>
								<template v-if="searchStamps[connection.id] === searchFingerprint(connection)">
									<Message
										v-if="searchErrors[connection.id]"
										variant="danger"
										class="model-options__result"
									>
										{{ searchErrors[connection.id] }}
									</Message>
									<WebSearchEvidence
										v-if="searchResults[connection.id]"
										:result="searchResults[connection.id]"
									/>
								</template>
								<p
									v-else-if="searchStamps[connection.id]"
									class="model-options__help"
								>
									{{ t('webSearch.changed') }}
								</p>
							</template>
						</details>

						<details
							v-if="connection.kind === 'chat'"
							class="model-options"
						>
							<summary>{{ t('modelConfig.title') }}</summary>
							<p class="model-options__help">
								{{ t('modelConfig.help') }}
							</p>
							<div class="fields">
								<div class="ai-field">
									<label class="ai-field">
										<span class="ai-field__label">{{ t('modelConfig.context') }}</span>
										<input
											v-model.number="connection.context_window"
											:aria-label="t('modelConfig.context')"
											:aria-describedby="`${connection.id}-context-hint`"
											class="input"
											type="number"
											min="0"
											step="1"
											placeholder="0"
										>
									</label>
									<p
										:id="`${connection.id}-context-hint`"
										class="ai-field__hint"
									>
										{{ t('modelConfig.contextHelp') }}
									</p>
								</div>
								<div class="ai-field">
									<label class="ai-field">
										<span class="ai-field__label">{{ t('modelConfig.output') }}</span>
										<input
											v-model.number="connection.max_output_tokens"
											:aria-label="t('modelConfig.output')"
											:aria-describedby="`${connection.id}-output-hint`"
											class="input"
											type="number"
											min="0"
											step="1"
											placeholder="0"
										>
									</label>
									<p
										:id="`${connection.id}-output-hint`"
										class="ai-field__hint"
									>
										{{ t('modelConfig.outputHelp') }}
									</p>
								</div>
								<div class="ai-field">
									<label class="ai-field">
										<span class="ai-field__label">{{ t('modelConfig.inputs') }}</span>
										<span class="select is-fullwidth">
											<select
												:value="connection.input_types?.join(',') || ''"
												:aria-label="t('modelConfig.inputs')"
												:aria-describedby="`${connection.id}-inputs-hint`"
												@change="changeInputTypes(connection, $event)"
											>
												<option value="">{{ t('modelConfig.auto') }}</option>
												<option value="text">{{ t('modelConfig.text') }}</option>
												<option value="text,image">{{ t('modelConfig.vision') }}</option>
											</select>
										</span>
									</label>
									<p
										:id="`${connection.id}-inputs-hint`"
										class="ai-field__hint"
									>
										{{ t('modelConfig.inputsHelp') }}
									</p>
								</div>
								<div
									v-if="connection.protocol === 'openai-chat'"
									class="ai-field"
								>
									<label class="ai-field">
										<span class="ai-field__label">{{ t('modelConfig.outputField') }}</span>
										<span class="select is-fullwidth">
											<select
												v-model="connection.output_token_field"
												:aria-label="t('modelConfig.outputField')"
												:aria-describedby="`${connection.id}-field-hint`"
											>
												<option value="">{{ t('modelConfig.auto') }}</option>
												<option value="max_completion_tokens">max_completion_tokens</option>
												<option value="max_tokens">max_tokens</option>
											</select>
										</span>
									</label>
									<p
										:id="`${connection.id}-field-hint`"
										class="ai-field__hint"
									>
										{{ t('modelConfig.fieldHelp') }}
									</p>
								</div>
							</div>
							<XButton
								v-if="listedModel(connection)"
								type="button"
								variant="secondary"
								class="model-options__apply"
								@click="applyCapabilities(connection)"
							>
								{{ t('modelConfig.useListed') }}
							</XButton>
							<p
								v-if="savedMatches(connection) && connection.resolved"
								class="model-resolved"
							>
								{{ t('modelConfig.effective') }}:
								{{ t('modelConfig.context') }}
								{{ connection.resolved.context_window?.toLocaleString() || t('modelConfig.unknown') }} ·
								{{ t('modelConfig.output') }}
								{{ connection.resolved.max_output_tokens?.toLocaleString() || t('modelConfig.providerDefault') }} ·
								{{ connection.resolved.input_types?.includes('image') ? t('modelConfig.vision') : t('modelConfig.text') }}
							</p>
							<p
								v-else
								class="model-options__help"
							>
								{{ t('modelConfig.saveToResolve') }}
							</p>
							<!-- A trigger policy, kept apart from the capacity fields so it is never read as a capacity. -->
							<fieldset class="compact-policy">
								<legend>{{ t('modelConfig.autoCompactTitle') }}</legend>
								<p class="model-options__help">
									{{ t('modelConfig.autoCompactHelp') }}
								</p>
								<div class="fields">
									<div class="ai-field">
										<label class="ai-field">
											<span class="ai-field__label">{{ t('modelConfig.autoCompactTokens') }}</span>
											<input
												v-model.number="connection.auto_compact_tokens"
												:aria-label="t('modelConfig.autoCompactTokens')"
												:aria-describedby="`${connection.id}-compact-hint`"
												:disabled="connection.disable_auto_compact"
												class="input"
												type="number"
												min="0"
												max="9007199254740991"
												step="1"
												placeholder="0"
											>
										</label>
										<p
											:id="`${connection.id}-compact-hint`"
											class="ai-field__hint"
										>
											{{ t('modelConfig.autoCompactTokensHelp') }}
										</p>
									</div>
									<div class="ai-field">
										<label class="stream-choice compact-choice">
											<input
												v-model="connection.disable_auto_compact"
												type="checkbox"
												:aria-describedby="`${connection.id}-compact-off-hint`"
											>
											<span>{{ t('modelConfig.disableAutoCompact') }}</span>
										</label>
										<p
											:id="`${connection.id}-compact-off-hint`"
											class="ai-field__hint"
										>
											{{ t('modelConfig.disableAutoCompactHelp') }}
										</p>
									</div>
								</div>
							</fieldset>
						</details>

						<dl class="endpoint-info">
							<dt>{{ t('tcymc.text.request_endpoint') }}</dt>
							<dd><code>{{ endpoint(connection) }}</code></dd>
							<dt>{{ t('tcymc.text.model_list_endpoint') }}</dt>
							<dd><code>{{ endpoint(connection, true) }}</code></dd>
						</dl>
						<p
							v-if="connection.protocol === 'openai-audio'"
							class="ai-field__hint"
						>
							{{ t('tcymc.text.audio_chat_needs_a_model_that_accepts_audio') }}
						</p>
						<p
							v-if="connection.protocol === 'anthropic'"
							class="ai-field__hint"
						>
							{{ t('tcymc.text.anthropic_messages_does_not_accept_raw_audio_use') }}
						</p>

						<div class="connection__tools">
							<XButton
								variant="secondary"
								icon="cloud-download-alt"
								:loading="fetchingId === connection.id"
								:disabled="!connection.base_url"
								@click="fetchModels(connection)"
							>
								{{ t('tcymc.text.fetch_model_list') }}
							</XButton>
							<XButton
								variant="secondary"
								type="button"
								icon="play"
								:loading="testingId === connection.id"
								:disabled="!savedMatches(connection)"
								:aria-describedby="savedMatches(connection) ? undefined : `${connection.id}-test-hint`"
								@click="testConnection(connection)"
							>
								{{ t('tcymc.text.test_saved_connection') }}
							</XButton>
						</div>
						<p
							v-if="!savedMatches(connection)"
							:id="`${connection.id}-test-hint`"
							class="ai-field__hint"
						>
							{{ t('tcymc.text.save_connection_changes_before_testing_you_can_fetch') }}
						</p>
						<p
							class="connection__notice"
							role="status"
						>
							{{ modelNotice[connection.id] }}
						</p>
						<div
							v-if="currentTest(connection)"
							class="test-result"
							:class="currentTest(connection)?.ok ? 'is-success' : 'is-danger'"
							role="status"
						>
							<Icon
								:icon="currentTest(connection)?.ok ? 'check' : 'exclamation-circle'"
								class="test-result__icon"
								aria-hidden="true"
							/>
							<div class="test-result__body">
								<p>{{ currentTest(connection)?.text || t('modelSettings.statusTested') }}</p>
								<code
									v-if="currentTest(connection)?.endpoint"
									class="endpoint-result"
								>{{ currentTest(connection)?.endpoint }}</code>
							</div>
						</div>

						<div class="connection__footer">
							<XButton
								type="submit"
								icon="save"
								:loading="savingPart === connection.id"
							>
								{{ t('modelSettings.saveConnection') }}
							</XButton>
							<span
								class="connection__saved"
								role="status"
							>{{ savedCards[connection.id] === cardStamp(connection) ? t('modelSettings.saved') : '' }}</span>
							<XButton
								variant="tertiary"
								type="button"
								danger
								class="connection__remove"
								@click="requestRemove(connection)"
							>
								{{ t('tcymc.text.remove_connection') }}
							</XButton>
						</div>
						<Message
							v-if="cardErrors[connection.id]"
							variant="danger"
						>
							{{ t('settingsDraft.retained') }} {{ cardErrors[connection.id] }}
						</Message>
					</div>
				</form>
			</div>
			<div class="tcy-panel__footer">
				<XButton
					variant="secondary"
					type="button"
					icon="plus"
					data-tour="ai-add"
					:disabled="draft.connections.length >= MAX_CONNECTIONS"
					@click="addConnection"
				>
					{{ t('tcymc.text.add_model_connection') }}
				</XButton>
				<label
					v-if="activeTab === 'transcription' && speechModels.length"
					class="audio-test"
				>
					<span class="ai-field__label">{{ t('tcymc.text.audio_file_for_connection_testing') }}</span>
					<input
						type="file"
						accept="audio/*"
						@change="testAudio = ($event.target as HTMLInputElement).files?.[0]"
					>
				</label>
			</div>
		</section>

		<form
			v-show="activeTab === 'roles'"
			class="tcy-panel"
			aria-labelledby="ai-roles-title"
			@submit.prevent="saveRoles"
		>
			<header class="tcy-panel__header">
				<h2
					id="ai-roles-title"
					class="tcy-panel__title"
					data-tour="ai-roles"
				>
					{{ t('tcymc.text.models_for_each_feature') }}
				</h2>
				<p class="tcy-panel__description">
					{{ t('modelSettings.saveConnectionFirst') }}
				</p>
			</header>
			<div class="role-list">
				<div class="role-row">
					<label class="role-row__field">
						<span class="ai-field__label">{{ t('tcymc.text.task_ai_assistant') }}</span>
						<span class="select is-fullwidth">
							<select
								v-model="draft.assistant"
								aria-describedby="ai-role-assistant-hint"
							>
								<option value="">{{ t('tcymc.text.not_enabled') }}</option>
								<option
									v-for="c in chatModels"
									:key="c.id"
									:value="c.id"
									:disabled="!persisted(c.id)"
								>{{ c.name }} · {{ c.model }}</option>
							</select>
						</span>
					</label>
					<p
						id="ai-role-assistant-hint"
						class="ai-field__hint"
					>
						{{ t('tcymc.text.choose_a_model_with_tool_calling_to_read') }}
					</p>
				</div>
				<div class="role-row">
					<label class="role-row__field">
						<span class="ai-field__label">{{ t('chatFiles.persona') }}</span>
						<span class="select is-fullwidth">
							<select
								v-model="draft.persona"
								aria-describedby="ai-role-persona-hint"
							>
								<option value="arona">{{ t('chatFiles.personaArona') }}</option>
								<option value="none">{{ t('chatFiles.personaNone') }}</option>
							</select>
						</span>
					</label>
					<p
						id="ai-role-persona-hint"
						class="ai-field__hint"
					>
						{{ t('chatFiles.personaHint') }}
					</p>
				</div>
				<div class="role-row">
					<label class="role-row__field">
						<span class="ai-field__label">{{ t('tcymc.text.speech_recognition') }}</span>
						<span class="select is-fullwidth">
							<select
								v-model="draft.transcription"
								aria-describedby="ai-role-transcription-hint"
							>
								<option value="">{{ t('tcymc.text.not_enabled') }}</option>
								<option
									v-for="c in speechModels"
									:key="c.id"
									:value="c.id"
									:disabled="!persisted(c.id)"
								>{{ c.name }} · {{ c.model }}</option>
							</select>
						</span>
					</label>
					<p
						id="ai-role-transcription-hint"
						class="ai-field__hint"
					>
						{{ t('tcymc.text.turn_recordings_or_uploaded_audio_into_text') }}
					</p>
				</div>
				<div class="role-row">
					<label class="role-row__field">
						<span class="ai-field__label">{{ t('tcymc.text.transcript_cleanup') }}</span>
						<span class="select is-fullwidth">
							<select
								v-model="draft.cleanup"
								aria-describedby="ai-role-cleanup-hint"
							>
								<option value="">{{ t('tcymc.text.keep_the_original_transcript') }}</option>
								<option
									v-for="c in chatModels"
									:key="c.id"
									:value="c.id"
									:disabled="!persisted(c.id)"
								>{{ c.name }} · {{ c.model }}</option>
							</select>
						</span>
					</label>
					<p
						id="ai-role-cleanup-hint"
						class="ai-field__hint"
					>
						{{ t('tcymc.text.improve_wording_and_punctuation_without_changing_tasks') }}
					</p>
				</div>
			</div>
			<div class="tcy-panel__footer">
				<XButton
					type="submit"
					icon="save"
					data-tour="ai-save"
					:loading="savingPart === 'roles'"
				>
					{{ t('modelSettings.saveRoles') }}
				</XButton>
				<span
					class="connection__saved"
					role="status"
				>{{ rolesDirty
					? t('settingsDraft.unsaved')
					: rolesSaved === rolesStamp(draft) ? t('modelSettings.saved') : '' }}</span>
			</div>
			<Message
				v-if="saveError"
				variant="danger"
			>
				{{ t('settingsDraft.retained') }} {{ saveError }}
			</Message>
		</form>

		<Modal
			danger
			:enabled="pendingRemove !== null"
			:confirm-label="t('tcymc.text.remove_connection')"
			@close="closeRemove"
			@submit="confirmRemove"
		>
			<template #header>
				{{ t('tcymc.text.remove_connection') }}
			</template>
			<template #text>
				<p v-if="pendingRemove">
					<strong>{{ pendingRemove.name || t('tcymc.text.new_model') }}</strong>
				</p>
				<p>{{ t('modelSettings.removeConfirm') }}</p>
				<p
					v-if="removeError"
					class="remove-error"
					role="alert"
				>
					{{ t('modelSettings.removeFailed') }} {{ removeError }}
				</p>
			</template>
		</Modal>
		<Modal
			danger
			:enabled="leaveTarget !== null"
			:confirm-label="t('modelSettings.leaveDiscard')"
			@close="leaveTarget = null"
			@submit="discardAndLeave"
		>
			<template #header>
				{{ t('modelSettings.leaveTitle') }}
			</template>
			<template #text>
				<p>{{ t('modelSettings.leaveText') }}</p>
			</template>
		</Modal>
	</div>
</template>

<style lang="scss" scoped>
.tcy-settings {
	display: grid;
	gap: var(--space-5);
	min-inline-size: 0;
}

.model-tabs {
	justify-self: start;
}

.tcy-panel {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	@media screen and (max-width: $tablet) {
		padding: var(--space-4);
	}
}

.tcy-panel__header {
	display: grid;
	gap: var(--space-1);
}

.tcy-panel__title {
	margin: 0;
	font-size: var(--text-lg);
}

.tcy-panel__description,
.empty {
	color: var(--text-secondary);
	font-size: var(--text-md);
	max-inline-size: 75ch;
}

.tcy-panel__footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
}

.connection-list {
	display: grid;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	min-inline-size: 0;
}

.connection {
	min-inline-size: 0;

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}

	&.is-expanded > .connection__summary {
		background: var(--surface-sunken);
	}

	&:first-child > .connection__summary {
		border-start-start-radius: var(--radius-md);
		border-start-end-radius: var(--radius-md);
	}
}

.connection__summary {
	display: grid;
	grid-template-columns: minmax(10rem, 1.2fr) minmax(0, 1.5fr) auto;
	align-items: center;
	gap: var(--space-2) var(--space-4);
	padding: var(--space-2) var(--space-3);
	min-block-size: 3rem;

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.connection__identity {
	min-inline-size: 0;
}

.connection__name {
	margin: 0;
	font-size: var(--text-md);
	overflow-wrap: anywhere;
}

.connection__meta {
	display: flex;
	flex-wrap: wrap;
	gap: 0 var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);

	> span + span::before {
		content: '·';
		margin-inline-end: var(--space-2);
		color: var(--text-tertiary);
	}
}

.connection__model {
	font-family: var(--font-mono);
	overflow-wrap: anywhere;
}

.connection__chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1);
	margin: 0;
	padding: 0;
	list-style: none;
	min-inline-size: 0;
}

.chip {
	padding: .0625rem var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	background: var(--surface);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: 1.5;
	white-space: nowrap;

	&.is-accent {
		border-color: transparent;
		background: var(--surface-selected);
		color: var(--accent-text);
		font-weight: var(--weight-medium);
	}

	&.is-quiet {
		border-style: dashed;
	}
}

.connection__end {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-2);

	@media screen and (max-width: $tablet) {
		justify-content: space-between;
	}
}

.connection__status {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	white-space: nowrap;

	&.is-warning svg {
		color: var(--warning);
	}

	&.is-success svg {
		color: var(--success);
	}

	&.is-danger {
		color: var(--danger-text);
	}
}

.connection__body {
	display: grid;
	gap: var(--space-4);
	padding: var(--space-4) var(--space-3) var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
	min-inline-size: 0;
}

.fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-3) var(--space-4);

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.ai-field {
	display: grid;
	align-content: start;
	gap: var(--space-1);
	min-inline-size: 0;

	:deep(.model-picker > label) {
		display: block;
		margin-block-end: var(--space-1);
	}
}

.ai-field__label,
.ai-field :deep(.model-picker > label) {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.ai-field__hint {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	max-inline-size: 75ch;
}

.stream-choice {
	grid-column: 1 / -1;
	display: flex;
	align-items: center;
	gap: var(--space-2);
	font-size: var(--text-md);
	cursor: pointer;

	input {
		flex: 0 0 auto;
		inline-size: 1rem;
		block-size: 1rem;
		accent-color: var(--primary);
	}
}

.model-options {
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	min-inline-size: 0;

	> summary {
		cursor: pointer;
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
		border-radius: var(--radius-xs);

		&:focus-visible {
			@include focus-ring;
		}
	}

	&[open] {
		display: grid;
		gap: var(--space-3);
	}
}

.model-options__help {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

.model-options__endpoint {
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

.model-options__apply,
.model-options :deep(.button) {
	justify-self: start;
}

.model-resolved {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.compact-policy {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;

	> legend {
		margin-block-end: var(--space-2);
		padding: 0;
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
	}
}

@media (pointer: coarse) {
	.compact-choice {
		min-block-size: var(--target-min);
	}
}

.endpoint-info {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--space-1) var(--space-3);
	margin: 0;
	font-size: var(--text-sm);

	dt {
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}

	dd {
		margin: 0;
		min-inline-size: 0;
	}

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);

		dd + dt {
			margin-block-start: var(--space-1);
		}
	}
}

.endpoint-info code,
.endpoint-result,
.model-options__endpoint code {
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.connection__tools,
.connection__footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
}

.connection__notice:empty {
	display: none;
}

.connection__notice {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.connection__saved {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.connection__remove {
	margin-inline-start: auto;
}

.test-result {
	display: flex;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start-width: 3px;
	border-radius: var(--radius-md);
	font-size: var(--text-md);
	white-space: pre-wrap;
	overflow-wrap: anywhere;

	&.is-success {
		border-inline-start-color: var(--success);
		background: var(--tint-success);
	}

	&.is-danger {
		border-inline-start-color: var(--danger);
		background: var(--tint-danger);
	}
}

.test-result__icon {
	flex-shrink: 0;
	margin-block-start: .2rem;
}

.test-result__body {
	display: grid;
	gap: var(--space-1);
	min-inline-size: 0;
}

.audio-test {
	display: grid;
	gap: var(--space-1);
	min-inline-size: 0;

	input {
		max-inline-size: 100%;
		font-size: var(--text-sm);
	}
}

.role-list {
	display: grid;
	border-block: 1px solid var(--border-subtle);
}

.role-row {
	display: grid;
	gap: var(--space-1);
	padding-block: var(--space-3);

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}
}

.role-row__field {
	display: grid;
	grid-template-columns: minmax(10rem, 2fr) minmax(0, 3fr);
	align-items: center;
	gap: var(--space-1) var(--space-4);

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.role-row .ai-field__hint {
	@media screen and (min-width: $tablet + 1px) {
		margin-inline-start: calc(40% + var(--space-2));
	}
}
</style>
