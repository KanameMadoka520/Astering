<script setup lang="ts">
import {computed, onMounted, onBeforeUnmount, ref, shallowRef, watch, nextTick, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter} from 'vue-router'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {useDocumentVisibility, useMediaQuery} from '@vueuse/core'
import {prepareSpeechFile, speechSampleRate} from '@/helpers/tcyAudio'
import {useSpeechRecording} from '@/composables/useSpeechRecording'
import {useConversationEvents} from '@/client/queries/conversationEvents'
import {aiSettingsQuery, useCleanupAI, useTranscribeAI} from '@/client/queries/tcyAi'
import SpeechInputControl from '@/components/ai/SpeechInputControl.vue'
import MCPSessionPicker from '@/components/ai/MCPSessionPicker.vue'
import AssistantPreferences from '@/components/ai/AssistantPreferences.vue'
import {assistantPreferencesQuery} from '@/client/queries/assistantPreferences'
import {builtinProfileIDs, normalizeOptions, profileOptions, validOptions, type AssistantOptions} from '@/helpers/assistantProfiles'
import Modal from '@/components/misc/Modal.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import ConversationHistory from '@/components/ai/ConversationHistory.vue'
import ConversationMenu from '@/components/ai/ConversationMenu.vue'
import AronaAvatar from '@/components/ai/AronaAvatar.vue'
import AronaWelcome from '@/components/ai/AronaWelcome.vue'
import {suggestionOptions, suggestionProfileSwitch, type WelcomeSuggestion} from '@/components/ai/welcomeSuggestions'
import ChatThread from '@/components/ai/ChatThread.vue'
import ChatAttachmentCard from '@/components/ai/attachments/ChatAttachmentCard.vue'
import ChatUploadTray from '@/components/ai/attachments/ChatUploadTray.vue'
import AttachMenu from '@/components/ai/attachments/AttachMenu.vue'
import DrivePicker from '@/components/drive/DrivePicker.vue'
import ConversationExport from '@/components/ai/export/ConversationExport.vue'
import {chatBytes} from '@/components/ai/export/files'
import {useAttachDriveFileToChat, useRemoveChatAttachment} from '@/client/queries/chatAttachments'
import type {DriveEntry} from '@/client/queries/drive'
import {CHAT_UPLOAD_MAX_BYTES, CHAT_UPLOAD_MAX_FILES, useChatAttachmentUploads} from '@/composables/useChatAttachmentUploads'
import {error, translatedError} from '@/message'
import BaseButton from '@/components/base/BaseButton.vue'
import {
	conversationQuery,
	conversationKeys,
	promptQuery,
	endAgentRun,
	useAgentReceiptRefresh,
	useCreateConversation,
	useLiveAgentRun,
	useConversationAction,
	useSendConversation,
	useReviewConversation,
	useSteerConversation,
} from '@/client/queries/tcyConversations'
import {provideSteeringOutbox} from '@/components/ai/steeringOutbox'
import {hasSteeringRequest, pendingSteeringCount, type LocalSteer} from '@/helpers/turnSteering'
import {markSteerInFlight, readSteerQueue, steerQueueOwner, updateSteerQueue, type QueuedSteer} from '@/helpers/steeringQueue'
import {onTokenRefreshed} from '@/helpers/auth'
import {useAuthStore} from '@/stores/auth'
import {useProjects} from '@/composables/useProjects'
import {provideAronaPresenting, usePresentedSnapshot} from '@/composables/useAronaPresentation'
import {useTitle} from '@/composables/useTitle'
import type {ChatAttachment, ChatTurn, ReviewInput, ConversationSummary} from '@/client/generated'
import {openDiagnostics, openCompactDiagnostic} from '@/helpers/diagnostics'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'

const props = withDefaults(defineProps<{
	embedded?: boolean,
	conversationId?: string,
	contextProjectId?: number,
	contextTaskId?: number,
	// False while the floating panel is minimized.
	presenting?: boolean,
}>(), {
	embedded: false,
	conversationId: '',
	contextProjectId: 0,
	contextTaskId: 0,
	presenting: true,
})
const emit = defineEmits<{
	'update:conversationId': [id: string],
	activity: [running: boolean],
	// A paused turn waits for the user's review, answer or budget decision.
	attention: [waiting: boolean],
	navigationBusy: [busy: boolean],
}>()
const {t} = useI18n({useScope: 'global'})

const NO_TURNS: readonly ChatTurn[] = []
const NO_FILES: readonly ChatAttachment[] = []
const promptID = useId()
const composerInput = ref<HTMLTextAreaElement>()
if (!props.embedded) useTitle(() => t('tcymc.text.ai_task_assistant'))
const route = useRoute()
const contextProject = computed(() => props.embedded ? props.contextProjectId : Number(route.query.project) || 0)
const projectID = ref(0)
const contextTaskID = computed(() => props.embedded ? props.contextTaskId : Number(route.query.task) || 0)
// Read through the reactive state: a destructured array would stay the list from setup.
const projectList = useProjects()
const settings = useQuery(aiSettingsQuery())
const router = useRouter()
const queryClient = useQueryClient()
const create = useCreateConversation()
const action = useConversationAction()
const send = useSendConversation()
const review = useReviewConversation()
const steer = useSteerConversation()
const paused = computed(() => active.value?.turns?.at(-1)?.result?.pause)
const chatID = computed(() => props.embedded
	? props.conversationId
	: typeof route.query.chat === 'string' ? route.query.chat : '')
async function navigateConversation(id: string) {
	if (props.embedded) {
		emit('update:conversationId', id)
		await nextTick()
	} else {
		await router.replace({name: 'tcy-ai', query: {...route.query, chat: id || undefined}})
	}
}
function stillHere(location?: string) {
	return !disposed && (props.embedded || route.name === 'tcy-ai' && (!location || route.fullPath === location))
}
watch(contextProject, (value, old) => {
	if (projectID.value === old || projectID.value === 0) projectID.value = value
}, {immediate: true})
const documentVisibility = useDocumentVisibility()
// Whether the conversation is on screen. Only then do streamed frames render; the query cache keeps filling.
const presenting = computed(() => props.presenting && documentVisibility.value === 'visible')
provideAronaPresenting(presenting)
// Set by a watch below, once the conversation is known: a ref, because the stream reads it right away.
const liveWork = ref(false)
// An idle conversation nobody looks at needs no stream (the server re-reads it every few seconds for one).
// Running work keeps it, so receipts still apply while the panel is minimized or the tab is hidden.
const events = useConversationEvents(() => presenting.value || liveWork.value ? chatID.value : '')
// Polls only a running or compacting conversation, and only while the event stream is not live.
const current = useQuery(computed(() => conversationQuery(chatID.value, events.connected.value)))
// Live state for logic; the template reads the narrow computeds below, so a streamed delta does not re-render
// this whole view.
const active = computed(() => current.data.value)
const hasConversation = computed(() => Boolean(active.value))
// Deleted here or on another device, or no longer readable: a retry cannot bring it back, so start a new chat.
watch(() => current.error.value, async cause => {
	const status = (cause as {status?: number} | null)?.status
	const id = chatID.value
	if (!id || (status !== 403 && status !== 404)) return
	endAgentRun(queryClient, id)
	showNotice(t('assistantUI.conversationGone'))
	await navigateConversation('')
	// Once nothing shows it: a later visit asks the server again instead of showing this error.
	queryClient.removeQueries({queryKey: conversationKeys.detail(id), exact: true})
})
const conversationTitle = computed(() => active.value?.title || t('chat.untitled'))
const archived = computed(() => Boolean(active.value?.archived))
const storage = computed(() => active.value?.storage)
const compacting = computed(() => Boolean(active.value?.compacting))
const compactError = computed(() => active.value?.compact_error || '')
const compactProgress = computed(() => active.value?.compact_progress)
const compactText = computed(() => active.value?.compact_text || '')
// Task, project and label caches follow the receipts of successful write tools, once per receipt; while
// this view shows a conversation the app-level run observer leaves it alone.
useAgentReceiptRefresh(active)
const pendingMessage = ref<{chat: string, originChat: string, turn: ChatTurn}>()
const visibleTurns = computed(() => {
	const turns = active.value?.turns ?? []
	const pending = pendingMessage.value
	const showPending = pending
		&& [pending.chat, pending.originChat].includes(chatID.value)
		&& !turns.some(turn => turn.request_id === pending.turn.request_id)
	return showPending ? [...turns, pending.turn] : turns
})
const hasTurns = computed(() => visibleTurns.value.length > 0)
// Without a chat, or once an open chat has loaded without turns; not while one is still loading.
const showWelcome = computed(() => !hasTurns.value && (!chatID.value || hasConversation.value))
// What the thread renders: frozen while hidden, and the latest turns at once when shown again.
const shownTurns = usePresentedSnapshot(visibleTurns, presenting)
const readShownTurns = () => shownTurns.value ?? NO_TURNS
const canCompact = computed(() => (active.value?.turns?.length ?? 0) > (active.value?.compactions?.at(-1)?.through ?? 0))
const activeRun = computed(() => Boolean(active.value?.compacting || active.value?.turns?.some(turn => turn.status === 'running')))
watch(() => activeRun.value || Boolean(pendingMessage.value), value => { liveWork.value = value }, {immediate: true})
// The history polls only while a listed conversation runs; the end of this one's run shows there at once.
watch([chatID, activeRun], ([id, running], [previousID, wasRunning]) => {
	if (id === previousID && wasRunning && !running) void queryClient.invalidateQueries({queryKey: conversationKeys.lists()})
})
const lastCompaction = computed(() => active.value?.compactions?.at(-1))
const hasStatusChips = computed(() => contextTaskID.value > 0
	|| Boolean(active.value?.archived || active.value?.storage || active.value?.compactions?.length))

const sidebarOpen = ref(false)
const wideLayout = useMediaQuery('(min-width: 1100px)')
// Below 1100px the history covers the conversation instead of squeezing it next to the main navigation.
const historyOverlay = computed(() => props.embedded || !wideLayout.value)
onMounted(() => {
	if (!props.embedded && wideLayout.value) {
		try { sidebarOpen.value = localStorage.getItem('arona-history-open') !== 'false' } catch { sidebarOpen.value = true }
	}
})
watch(sidebarOpen, open => {
	if (!props.embedded && wideLayout.value) {
		try { localStorage.setItem('arona-history-open', String(open)) } catch { /* Storage may be unavailable in private browsing. */ }
	}
})
const historyToggle = ref<InstanceType<typeof BaseButton>>()
const historyPanel = ref<InstanceType<typeof ConversationHistory>>()
const sidebar = ref<HTMLElement>()
async function toggleSidebar() {
	sidebarOpen.value = !sidebarOpen.value
	if (!sidebarOpen.value || !historyOverlay.value) return
	await nextTick()
	// Focusing the search field on touch screens would cover the list with the on-screen keyboard.
	if (window.matchMedia('(pointer: fine)').matches) historyPanel.value?.focusSearch()
	else sidebar.value?.focus()
}
async function closeSidebar() {
	sidebarOpen.value = false
	await nextTick()
	historyToggle.value?.focus()
}
function sidebarKeydown(event: KeyboardEvent) {
	if (!historyOverlay.value) return
	// The conversation menu handles its own Escape and a filled search field clears itself
	// first. Neither may reach the floating panel, whose Escape minimizes it.
	if (event.defaultPrevented || (event.target instanceof HTMLInputElement && event.target.type === 'search' && event.target.value)) {
		event.stopPropagation()
		return
	}
	event.preventDefault()
	// Keep the floating panel open: only the overlay closes on this Escape.
	event.stopPropagation()
	void closeSidebar()
}
const connectionID = ref('')
const searchMode = ref<'auto' | 'off' | 'required'>('auto')
const canSearch = computed(() => Boolean(settings.data.value?.connections.find(c => c.id === selectedConnection.value)?.web_search_protocol))
// Without a search-capable model only a leftover "required" choice needs the control, so it can be undone.
const showSearchSwitch = computed(() => canSearch.value || searchMode.value === 'required')
const chatModels = computed(() => settings.data.value?.connections.filter(c => c.kind === 'chat') ?? [])
const selectedConnection = computed(() => connectionID.value || settings.data.value?.assistant || '')
const assignedModelName = computed(() => settings.data.value?.connections.find(c => c.id === settings.data.value?.assistant)?.name
	|| t('chat.defaultModel'))
const exportOpen = ref(false)
const fileInput = ref<HTMLInputElement>()
const removeFile = useRemoveChatAttachment()
const attachDrive = useAttachDriveFileToChat()
const driveOpen = ref(false)
// Set for a whole Drive pick: creating a conversation, opening it and attaching. Between those steps neither
// mutation is pending, and a second pick in a new chat would create another conversation.
const drivePicking = ref(false)
const chatUploads = useChatAttachmentUploads({resolveConversation})
const draftFiles = computed(() => active.value?.draft_attachments ?? NO_FILES)
const imageModel = computed(() => {
	const model = chatModels.value.find(c => c.id === selectedConnection.value)
	return (model?.resolved?.input_types ?? model?.input_types ?? []).includes('image')
})
const imageMismatch = computed(() => !imageModel.value && draftFiles.value.some(f => /^image\/(png|jpeg|webp|gif)$/.test(f.mime || '')))

type Notice = {text: string, tone: 'info' | 'error'}
const notice = ref<Notice>()
let noticeTimer: ReturnType<typeof setTimeout> | undefined
function showNotice(text: string, tone: Notice['tone'] = 'error') {
	clearTimeout(noticeTimer)
	const shown = {text, tone}
	notice.value = shown
	// Confirmations fade on their own; problems stay until dismissed or replaced.
	if (tone === 'info') noticeTimer = setTimeout(() => { if (notice.value === shown) notice.value = undefined }, 6000)
}
function dismissNotice() {
	clearTimeout(noticeTimer)
	notice.value = undefined
}
onBeforeUnmount(() => clearTimeout(noticeTimer))

// Uploads and Drive picks share this: without a conversation, the first file creates one.
async function resolveConversation(): Promise<string | null> {
	if (chatID.value) return chatID.value
	const location = route.fullPath
	const requestContext = captureClientRequestContext()
	const created = await create.mutateAsync()
	if (!stillHere(location) || !isClientRequestContextCurrent(requestContext)) return null
	const id = created.id!
	saveOptions(id, currentOptions.value, selectedProfile.value)
	await navigateConversation(id)
	return id
}
// Oversized files are reported per file in the tray; only the message's file count stops a whole selection.
function exceedsFileLimit(count: number) {
	if (count + draftFiles.value.length <= CHAT_UPLOAD_MAX_FILES) return false
	showNotice(t('chatFiles.limits'))
	return true
}
async function addFiles(files: File[]) {
	if (!files.length || busy.value || exceedsFileLimit(files.length)) return
	await chatUploads.start(files)
}
function chooseFiles(event: Event) {
	const input = event.target as HTMLInputElement
	const files = Array.from(input.files ?? [])
	// Cleared at once, so choosing the same file again still fires a change.
	input.value = ''
	void addFiles(files)
}
function retryUploads(key?: string) {
	const count = key ? 1 : chatUploads.items.value.filter(item => item.retryable && (item.state === 'failed' || item.state === 'cancelled')).length
	if (busy.value || exceedsFileLimit(count)) return
	void (key ? chatUploads.retry(key) : chatUploads.retryFailed())
}
// Like task attachments: the picker stays open on failure, and the mutation's error toast says why.
// The returned attachment is not matched against the picked file: picking content that is already in the draft
// returns the existing entry, whose id is its content hash and whose Drive file may differ.
async function chooseDriveFile(entry: DriveEntry) {
	if (drivePicking.value || attachDrive.isPending.value || create.isPending.value) return
	if ((entry.file?.size ?? 0) > CHAT_UPLOAD_MAX_BYTES || draftFiles.value.length >= CHAT_UPLOAD_MAX_FILES) {
		// The composer notice sits behind the picker, so this one is a toast.
		error(translatedError('chatFiles.limits'))
		return
	}
	drivePicking.value = true
	try {
		const id = await resolveConversation()
		if (!id) return
		await attachDrive.mutateAsync({id, fileId: entry.file_id})
		driveOpen.value = false
	} catch {
		return
	} finally {
		drivePicking.value = false
	}
}
function pasteFiles(event: ClipboardEvent) {
	const files = Array.from(event.clipboardData?.files ?? [])
	if (files.length) {
		event.preventDefault()
		void addFiles(files)
	}
}
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)
function carriesFiles(event: DragEvent) {
	return Boolean(event.dataTransfer?.types.includes('Files'))
}
function dragEnter(event: DragEvent) {
	if (!carriesFiles(event)) return
	event.preventDefault()
	dragDepth.value++
}
function dragLeave(event: DragEvent) {
	if (carriesFiles(event)) dragDepth.value = Math.max(0, dragDepth.value - 1)
}
function dropFiles(event: DragEvent) {
	dragDepth.value = 0
	void addFiles(Array.from(event.dataTransfer?.files ?? []))
}
async function removeDraft(file: string) { try { await removeFile.mutateAsync({id: chatID.value, file}) } catch { return } }
// Upload rows belong to the conversation they were chosen in; a run's own new conversation keeps them.
watch(chatID, (_id, old) => {
	if (old || !chatUploads.running.value) chatUploads.reset()
})
const composerForm = ref<HTMLFormElement>()
// The tray leaves with its last row. Focus inside it (a removed row's button, or the status line it moved to)
// goes to the attach button, or to the request field while attaching is unavailable, instead of the page body.
// Runs before the render, while the tray and its focus are still in the document.
watch(() => chatUploads.items.value.length > 0, (shown, wasShown) => {
	if (shown || !wasShown || !document.activeElement?.closest('.chat-upload-tray')) return
	void nextTick(() => {
		if (document.activeElement && document.activeElement !== document.body) return
		const trigger = composerForm.value?.querySelector<HTMLButtonElement>('.attach-menu-trigger:not(:disabled)')
		if (trigger) trigger.focus()
		// On touch screens the request field would open the on-screen keyboard.
		else if (window.matchMedia('(pointer: fine)').matches) composerInput.value?.focus()
	})
})
const historyDialog = ref<{kind: 'rename' | 'delete', conversation: ConversationSummary}>()
const newTitle = ref('')
const showSystemPrompt = ref(false)
const thread = ref<HTMLElement>()
const threadElement = () => thread.value
const stickToBottom = ref(true)
// Unsent requests per conversation, for the tab: Expand opens the full page in a new view, and leaving /ai
// unmounts it. The map covers browsers without session storage.
const memoryDrafts = new Map<string, string>()
function draftStorageKey(id: string) {
	const context = captureClientRequestContext()
	return `tcy-ai-draft:${JSON.stringify([context.apiBaseUrl, context.identity, id])}`
}
function readDraft(id: string) {
	try {
		return sessionStorage.getItem(draftStorageKey(id)) ?? memoryDrafts.get(id) ?? ''
	} catch {
		return memoryDrafts.get(id) ?? ''
	}
}
function writeDraft(id: string, text: string) {
	if (text) memoryDrafts.set(id, text)
	else memoryDrafts.delete(id)
	try {
		if (text) sessionStorage.setItem(draftStorageKey(id), text)
		else sessionStorage.removeItem(draftStorageKey(id))
	} catch { /* The map above keeps it while this view lives. */ }
}
const transcribe = useTranscribeAI()
const cleanup = useCleanupAI()
// Seeded once; a change of chat swaps the text in selectConversation or moves it in the watch below.
// eslint-disable-next-line vue/no-ref-object-reactivity-loss
const prompt = ref(readDraft(chatID.value))
// Synchronous, so text is filed under the conversation it was typed in even when the chat changes right after.
let draftRevision = 0
watch(prompt, text => { draftRevision++; writeDraft(chatID.value, text) }, {flush: 'sync'})
let switchingChat = false
// Any other change of chat on this page (a chat created for this text by a first upload or send, a deleted chat,
// the browser's back button) keeps the composer text, so its draft moves along. Leaving /ai clears the chat query
// too, and keeps the draft where it is.
watch(chatID, (id, previous) => {
	if (switchingChat || !stillHere()) return
	writeDraft(previous, '')
	writeDraft(id, prompt.value)
}, {flush: 'sync'})
const mode = ref<'read' | 'write'>('read')
const allowDelete = ref(false)
const approval = ref<'smart' | 'review' | 'auto'>('smart')
const writeProjectIDs = ref<number[]>([])
const mcpServerIDs = ref<string[]>([])
const maxRounds = ref(8)
const maxOperations = ref(20)
const timeoutSeconds = ref(120)
const tokenBudget = ref(0)
const stopAtSegmentLimit = ref(false)
const enableSubagents = ref(false)
const preferences = useQuery(assistantPreferencesQuery())
const preferencesOpen = ref(false)
const selectedProfile = ref('ask')
const initializedChat = ref<string | null>(null)
const optionsReady = computed(() => initializedChat.value === chatID.value)
const currentOptions = computed<AssistantOptions>(() => ({
	search_mode: searchMode.value,
	connection_id: connectionID.value,
	project_id: projectID.value,
	mode: mode.value,
	allow_delete: allowDelete.value,
	approval: approval.value,
	write_project_ids: writeProjectIDs.value,
	mcp_server_ids: mcpServerIDs.value,
	max_rounds: maxRounds.value,
	max_operations: maxOperations.value,
	timeout_seconds: timeoutSeconds.value,
	token_budget: tokenBudget.value,
	stop_at_segment_limit: stopAtSegmentLimit.value,
	enable_subagents: enableSubagents.value,
}))
const profiles = computed(() => [
	...builtinProfileIDs.map(id => ({id, name: t(`assistantUI.presets.${id}.name`)})),
	...(preferences.data.value?.profiles ?? []).map(p => ({id: p.id!, name: p.name!})),
])
function applyOptions(o: AssistantOptions, profile: string, remember = true) {
	searchMode.value = o.search_mode || 'auto'
	connectionID.value = o.connection_id
	projectID.value = o.project_id
	mode.value = o.mode
	allowDelete.value = o.allow_delete
	approval.value = o.approval
	writeProjectIDs.value = [...o.write_project_ids]
	mcpServerIDs.value = [...o.mcp_server_ids]
	maxRounds.value = o.max_rounds
	maxOperations.value = o.max_operations
	timeoutSeconds.value = o.timeout_seconds
	tokenBudget.value = o.token_budget
	stopAtSegmentLimit.value = o.stop_at_segment_limit
	enableSubagents.value = o.enable_subagents
	selectedProfile.value = profile
	if (remember) {
		saveOptions(chatID.value, o, profile)
		showNotice(t('assistantUI.applied'), 'info')
	}
}
function selectProfile(id: string) {
	const custom = preferences.data.value?.profiles?.find(p => p.id === id)
	const options = custom
		? normalizeOptions(custom.options)
		: {...profileOptions(id), connection_id: connectionID.value, project_id: projectID.value}
	options.mcp_server_ids = [...mcpServerIDs.value]
	applyOptions(options, id)
}
function optionsStorageKey(id: string) {
	const context = captureClientRequestContext()
	return `tcy-ai-options:${JSON.stringify([context.apiBaseUrl, context.identity, id])}`
}
function saveOptions(id: string, options: AssistantOptions, profile: string) {
	try { sessionStorage.setItem(optionsStorageKey(id), JSON.stringify({options, profile})) } catch { /* The server still retains sent configurations. */ }
}
// Without saved preferences (none loaded, or loading failed) the built-in defaults apply, so the composer works.
watch([() => preferences.data.value, () => preferences.isError.value, active, chatID], ([value, failed, conversation, id]) => {
	if ((!value && !failed) || initializedChat.value === id || (id && conversation?.id !== id)) return
	let saved: {options: AssistantOptions, profile: string} | undefined
	try {
		const candidate = JSON.parse(sessionStorage.getItem(optionsStorageKey(id)) || 'null')
		// Normalized so options stored before newer switches existed still restore them as off.
		if (candidate && validOptions(candidate.options) && ['read', 'write'].includes(candidate.options.mode)) saved = {options: normalizeOptions(candidate.options), profile: candidate.profile}
	} catch { /* Ignore unavailable or obsolete browser preferences. */ }
	const last = conversation?.turns?.at(-1)?.result?.configuration
	const defaultID = value?.default_profile || 'ask'
	const custom = value?.profiles?.find(p => p.id === defaultID)
	const options = saved?.options ?? (last ? normalizeOptions(last) : custom ? normalizeOptions(custom.options) : profileOptions(defaultID))
	if (!saved && !last) options.mcp_server_ids = []
	if (contextProject.value) options.project_id = contextProject.value
	applyOptions(options, saved?.profile ?? (last ? '' : defaultID), false)
	initializedChat.value = id
}, {immediate: true})
watch(mode, value => {if (value === 'read') allowDelete.value = false})
function resizeComposer() {
	const el = composerInput.value
	if (!el) return
	el.style.height = 'auto'
	el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}
watch(prompt, async () => {await nextTick(); resizeComposer()})
const effectivePrompt = useQuery(computed(() => promptQuery(projectID.value, mode.value, allowDelete.value, showSystemPrompt.value)))
const tidy = ref(true)
const original = ref('')
const audioInput = ref<HTMLInputElement>()
const audioStage = ref('')
const microphone = useSpeechRecording({
	capture: captureSpeechOwner,
	isCurrent: speechOwnerIsCurrent,
	onComplete: (blob, name, owner) => { void processAudio(blob, name, owner) },
	onError: kind => showNotice(t(kind === 'unsupported'
		? 'tcymc.text.this_browser_cannot_record_audio_please_upload_an'
		: kind === 'permission' ? 'tcymc.text.cannot_access_the_microphone_check_your_browser_s'
			: kind === 'empty' ? 'tcymc.text.the_recording_is_empty_please_try_again'
				: kind === 'too-large' ? 'tcymc.text.audio_must_not_exceed_16_mib'
					: 'tcymc.text.recording_was_interrupted_please_try_again')),
})
const {recording, requesting: microphonePending, stopping: microphoneStopping, elapsed} = microphone
const editingBusy = computed(() => Boolean(pendingMessage.value)
	|| chatUploads.running.value
	|| drivePicking.value
	|| attachDrive.isPending.value
	|| removeFile.isPending.value
	|| Boolean(audioStage.value)
	|| review.isPending.value
	|| create.isPending.value
	|| send.isPending.value
	|| action.isPending.value
	|| transcribe.isPending.value
	|| cleanup.isPending.value
	|| recording.value || microphonePending.value || microphoneStopping.value)
const busy = computed(() => !optionsReady.value || editingBusy.value || activeRun.value || Boolean(paused.value))
// Dictation edits the draft, including an instruction to steer a running turn.
const voiceBusy = computed(() => !optionsReady.value || editingBusy.value || archived.value)
watch([activeRun, editingBusy, () => steer.isPending.value], ([running, editing, steering]) => {
	emit('activity', running || editing)
	// Expanding unmounts the panel, and an instruction's failure would have no note left to show it.
	emit('navigationBusy', editing || steering)
}, {immediate: true})
watch(() => Boolean(paused.value) && !activeRun.value, waiting => emit('attention', waiting), {immediate: true})
const hasAssistant = computed(() => chatModels.value.some(c => c.id === selectedConnection.value))
// A failed load is not a missing setup: it shows its own error and retry.
const needsSetup = computed(() => settings.isSuccess.value && !hasAssistant.value)
const settingsFailed = computed(() => settings.isError.value && !settings.data.value)
const preferencesFailed = computed(() => preferences.isError.value && !preferences.data.value)
// The server runs one model job per account. Sending elsewhere meanwhile would create a chat and then be refused.
const liveRun = useLiveAgentRun()
const runningElsewhere = computed(() => Boolean(liveRun.value) && liveRun.value !== chatID.value)
// Reads the cache only; the app-level run observer keeps that conversation current.
const liveConversation = useQuery(computed(() => ({
	...conversationQuery(runningElsewhere.value ? liveRun.value : ''),
	enabled: false,
})))
const liveRunTitle = computed(() => liveConversation.data.value?.title || t('chat.untitled'))

// Steering: text for the open conversation's running turn, which takes it in at its next safe step. A path of its
// own, so `busy` still blocks files, options and new runs while the run works.
const steerTurnID = computed(() => {
	const conversation = active.value
	const turn = conversation?.turns?.at(-1)
	// Compacting a whole conversation is no run to steer; a run compacting its own context still takes instructions.
	return conversation?.id === chatID.value && !conversation.compacting && turn?.status === 'running' ? turn.id ?? '' : ''
})
// A send still on its way has no running turn yet, and a run listed elsewhere means this one is stale.
const steering = computed(() => Boolean(steerTurnID.value) && !runningElsewhere.value && !pendingMessage.value)
const stopRequested = ref('')
watch(steerTurnID, () => { stopRequested.value = '' })
const steerBlocked = computed(() => steer.isPending.value || (steering.value && stopRequested.value === steerTurnID.value))
const showSteerSend = computed(() => steering.value && Boolean(prompt.value.trim()))
const steerStage = computed(() => steering.value ? active.value?.turns?.at(-1)?.result?.stage ?? '' : '')
const steerHint = computed(() => {
	if (stopRequested.value && stopRequested.value === steerTurnID.value) return 'aronaSteer.stopping'
	if (steer.isPending.value) return 'aronaSteer.sending'
	return steerStage.value === 'compacting' ? 'aronaSteer.autoCompacting' : 'aronaSteer.hint'
})
// This account's unconfirmed instructions (sending, failed, refused) survive reloads and closed panels. Acknowledged
// ones stay in `sentSteers` only until the conversation lists them.
// The token and server behind a request context are not reactive, so a new session, or a refreshed token that may
// belong to another account by now, reads the queue again.
const auth = useAuthStore()
const tokenRefreshes = ref(0)
onBeforeUnmount(onTokenRefreshed(() => { tokenRefreshes.value++ }))
const steerQueue = computed(() => {
	void auth.session
	void tokenRefreshes.value
	return readSteerQueue(captureClientRequestContext())
})
const sentSteers = shallowRef<readonly LocalSteer[]>([])
provideSteeringOutbox(computed(() => [
	...steerQueue.value.entries.filter(entry => entry.state === 'sending').map(entry => ({
		chat: entry.chat,
		turn: entry.turn,
		request_id: entry.requestID,
		message: entry.message,
		state: 'sending' as const,
	})),
	...sentSteers.value,
]))
const waitingSteers = computed(() => {
	if (!steering.value) return 0
	const turn = active.value?.turns?.at(-1)
	const unlisted = sentSteers.value.filter(entry => entry.chat === chatID.value && entry.turn === steerTurnID.value
		&& !hasSteeringRequest(turn, entry.request_id)).length
	return pendingSteeringCount(turn) + unlisted
})
// An acknowledged instruction leaves once its conversation lists it or its turn stops running.
watch(active, conversation => {
	const id = conversation?.id
	if (!id || !sentSteers.value.some(entry => entry.chat === id)) return
	const kept = sentSteers.value.filter(entry => {
		if (entry.chat !== id) return true
		const turn = conversation.turns?.find(item => item.id === entry.turn)
		return turn?.status === 'running' && !hasSteeringRequest(turn, entry.request_id)
	})
	if (kept.length !== sentSteers.value.length) sentSteers.value = kept
})
// Screen readers hear that an instruction was taken; the thread itself is not a live region.
const steerAnnouncement = ref('')
watch(steerTurnID, () => { steerAnnouncement.value = '' })

// One note per request, each closed only by its own retry, delivery or dismissal. Each keeps the scope it was read
// from: the account or server can change before the notes follow, and a note never acts on another scope.
type SteerFailure = QueuedSteer & {owner: string}
const shownSteerFailures = computed(() => steerQueue.value.entries
	.filter(entry => entry.state !== 'sending' && entry.chat === chatID.value)
	.map((entry): SteerFailure => ({...entry, owner: steerQueue.value.owner})))
function dropSteerFailures(owner: string, keep: (entry: QueuedSteer) => boolean) {
	const context = captureClientRequestContext()
	if (steerQueueOwner(context) !== owner) return
	updateSteerQueue(context, entries => {
		const kept = entries.filter(keep)
		return kept.length === entries.length ? entries : kept
	})
}
function dismissSteerFailure(failure: SteerFailure) {
	dropSteerFailures(failure.owner, entry => entry.requestID !== failure.requestID)
}
// Focus on a note that leaves (retried, delivered, dismissed) returns to the composer instead of the page.
watch(() => shownSteerFailures.value.length, (count, previous) => {
	if (count < previous && document.activeElement?.closest('.steer-failure')) refocusComposer()
})
function refocusComposer() {
	void nextTick(() => {
		if (document.activeElement && document.activeElement !== document.body) return
		// On touch screens the request field would open the on-screen keyboard, so the composer itself takes focus:
		// next to the field, and not on a control such as Stop.
		if (window.matchMedia('(pointer: fine)').matches) composerInput.value?.focus()
		else composerForm.value?.focus()
	})
}
// A request may have arrived even though its answer did not; the conversation listing it settles that.
const deliveredSteerFailures = computed(() => {
	const conversation = active.value
	if (!conversation?.id) return ''
	return shownSteerFailures.value
		.filter(failure => failure.state === 'failed' && failure.chat === conversation.id
			&& hasSteeringRequest(conversation.turns?.find(turn => turn.id === failure.turn), failure.requestID))
		.map(failure => failure.requestID)
		.join(' ')
})
watch(deliveredSteerFailures, ids => {
	if (!ids) return
	const delivered = new Set(ids.split(' '))
	for (const failure of shownSteerFailures.value) {
		if (delivered.has(failure.requestID) && failure.restored && prompt.value === failure.restored) prompt.value = ''
	}
	dropSteerFailures(steerQueue.value.owner, entry => !delivered.has(entry.requestID))
	showNotice(t('aronaSteer.delivered'), 'info')
}, {immediate: true})
// Puts undelivered text back into the composer it was typed in, never over newer text. Returns what it put back.
function keepSteerDraft(id: string, text: string): string {
	if (disposed) {
		// A later visit reads the draft.
		if (readDraft(id).trim()) return ''
		writeDraft(id, text)
		return text
	}
	// In another conversation the composer's text follows route changes, so only the note can keep this one.
	if (id !== chatID.value || !stillHere()) return ''
	if (prompt.value === text) return text
	if (prompt.value.trim()) return ''
	prompt.value = text
	return text
}
// 4xx answers the server gives for a turn that does not take instructions, or for an invalid one.
const REFUSED = new Set([400, 409, 413, 422])
async function sendSteer(retry?: SteerFailure) {
	const id = chatID.value
	if (steer.isPending.value) return
	const request = captureClientRequestContext()
	const owner = steerQueueOwner(request)
	let turn: string
	let message: string
	let requestID: string
	// What to put back if it fails: the text as typed, or what the failure note already restored.
	let typed: string
	if (retry) {
		if (retry.owner !== owner || retry.state !== 'failed' || retry.chat !== id) return
		;({turn, message, requestID} = retry)
		typed = retry.restored || retry.message
	} else {
		turn = steerTurnID.value
		message = prompt.value.trim()
		if (!message || !steering.value || steerBlocked.value) return
		// The same text again keeps its request id: if the first attempt arrived, the server does not queue it twice.
		requestID = shownSteerFailures.value.find(failure => failure.owner === owner && failure.state === 'failed'
			&& failure.turn === turn && failure.message === message)?.requestID ?? crypto.randomUUID()
		typed = prompt.value
		const fromButton = document.activeElement instanceof HTMLElement && document.activeElement.closest('.composer-steer')
		prompt.value = ''
		// The send button leaves with the text.
		if (fromButton) refocusComposer()
	}
	const sending: QueuedSteer = {
		chat: id,
		turn,
		requestID,
		message,
		state: 'sending',
		restored: '',
		reason: '',
	}
	steerAnnouncement.value = ''
	markSteerInFlight(requestID, true)
	// Stored before the request starts, in place for a retry, so nothing depends on this view surviving it.
	updateSteerQueue(request, entries => entries.some(entry => entry.requestID === requestID)
		? entries.map(entry => entry.requestID === requestID ? sending : entry)
		: [...entries, sending])
	try {
		await steer.mutateAsync({
			id,
			body: {
				turn_id: turn,
				request_id: requestID,
				message,
			},
		})
		markSteerInFlight(requestID, false)
		// Another session's storage is never written; its next visit finds the instruction listed or unconfirmed.
		if (!isClientRequestContextCurrent(request)) return
		updateSteerQueue(request, entries => entries.filter(entry => entry.requestID !== requestID))
		sentSteers.value = [...sentSteers.value.filter(entry => entry.request_id !== requestID), {
			chat: id,
			turn,
			request_id: requestID,
			message,
			state: 'sent',
		}]
		// A retry from the failure note delivered the text that note had put back into the composer.
		if (retry?.restored && chatID.value === id && prompt.value === retry.restored) prompt.value = ''
		if (chatID.value === id) steerAnnouncement.value = t('aronaSteer.accepted')
	} catch (cause) {
		markSteerInFlight(requestID, false)
		if (isRequestContextAbort(cause) || !isClientRequestContextCurrent(request)) return
		const {status, detail} = (cause ?? {}) as {status?: number, detail?: string}
		const refused = status !== undefined && REFUSED.has(status)
		const failed: QueuedSteer = {
			...sending,
			state: refused ? 'refused' : 'failed',
			restored: keepSteerDraft(id, typed),
			reason: refused && typeof detail === 'string' ? detail : '',
		}
		updateSteerQueue(request, entries => entries.map(entry => entry.requestID === requestID ? failed : entry))
	}
}
const liveStatus = computed(() => t(events.connected.value ? 'flow.liveConnected' : 'flow.reconnecting'))
// Only a running or compacting conversation is polled while the stream reconnects.
const liveLabel = computed(() => t(events.connected.value
	? 'assistantUI.statusLive'
	: activeRun.value ? 'assistantUI.statusPolling' : 'assistantUI.statusReconnecting'))
const speechConnection = computed(() => settings.data.value?.connections.find(connection =>
	connection.id === settings.data.value?.transcription && connection.kind === 'transcription' && !connection.speech?.disabled))
const hasSpeech = computed(() => Boolean(speechConnection.value))
const nextProjectTitle = computed(() => projectID.value
	? projectList.projectsArray.find(p => p.id === projectID.value)?.title || `#${projectID.value}`
	: '')
let disposed = false

// Only turns appended to the open conversation fade in; opening or switching a chat renders at once, and so does
// catching up with turns that arrived while the panel was minimized.
const revealTurns = ref(false)
let revealFrame = 0
watch([chatID, presenting], ([, shown]) => {
	if (shown) revealTurns.value = false
})
watch([chatID, presenting, () => !chatID.value || active.value?.id === chatID.value], ([, shown, ready]) => {
	cancelAnimationFrame(revealFrame)
	if (shown && ready) revealFrame = requestAnimationFrame(() => { revealTurns.value = true })
}, {immediate: true, flush: 'post'})
onBeforeUnmount(() => cancelAnimationFrame(revealFrame))

async function selectConversation(id: string) {
	if (editingBusy.value) return
	switchingChat = true
	try {
		await navigateConversation(id)
	} finally {
		switchingChat = false
	}
	prompt.value = readDraft(id)
	original.value = ''
	if (historyOverlay.value) sidebarOpen.value = false
	stickToBottom.value = true
}

async function newConversation() {
	if (editingBusy.value) return
	await selectConversation('')
	await nextTick()
	composerInput.value?.focus()
}

async function applySuggestion(suggestion: WelcomeSuggestion) {
	const profile = suggestionProfileSwitch(suggestion, selectedProfile.value)
	if (profile) applyOptions(suggestionOptions(profile, currentOptions.value), profile)
	prompt.value = t(suggestion.prompt)
	await nextTick()
	const input = composerInput.value
	if (!input) return
	input.focus()
	input.setSelectionRange(input.value.length, input.value.length)
}

async function submit() {
	if ((!prompt.value.trim() && !draftFiles.value.length) || busy.value || !hasAssistant.value || imageMismatch.value) return
	if (runningElsewhere.value) return
	if (searchMode.value === 'required' && !canSearch.value) {
		showNotice(t('webSearch.configureFirst'))
		return
	}
	const originalPrompt = prompt.value
	const message = prompt.value.trim() || t('chatFiles.defaultPrompt')
	const id = chatID.value
	const location = route.fullPath
	const request = {
		search_mode: searchMode.value,
		message,
		attachment_ids: draftFiles.value.map(f => f.id!),
		history: [],
		project_id: projectID.value,
		mode: mode.value,
		allow_delete: allowDelete.value && mode.value === 'write',
		approval: approval.value,
		write_project_ids: [...writeProjectIDs.value],
		mcp_server_ids: [...mcpServerIDs.value],
		max_rounds: maxRounds.value,
		max_operations: maxOperations.value,
		timeout_seconds: timeoutSeconds.value,
		token_budget: tokenBudget.value,
		stop_at_segment_limit: stopAtSegmentLimit.value,
		enable_subagents: enableSubagents.value,
		page_context: JSON.stringify({page: route.name, project_id: projectID.value, task_id: contextTaskID.value || undefined}),
		request_id: crypto.randomUUID(),
		connection_id: selectedConnection.value,
	}
	pendingMessage.value = {
		chat: id,
		originChat: id,
		turn: {
			id: request.request_id,
			request_id: request.request_id,
			prompt: message,
			attachments: [...draftFiles.value],
			status: 'running',
		},
	}
	prompt.value = ''
	stickToBottom.value = true
	const requestContext = captureClientRequestContext()
	let target = id
	try {
		if (!target) {
			const created = await create.mutateAsync()
			target = created.id!
			if (pendingMessage.value) pendingMessage.value.chat = target
			if (!stillHere(location)) return
			saveOptions(target, currentOptions.value, selectedProfile.value)
			await navigateConversation(target)
		}
		await send.mutateAsync({id: target, body: request})
		if (chatID.value === target && !prompt.value) original.value = ''
		// Text a failed instruction put back into the composer has now gone out as this message.
		if (originalPrompt.trim()) {
			dropSteerFailures(steerQueueOwner(requestContext), entry => entry.chat !== target || entry.restored !== originalPrompt)
		}
	} catch (e) {
		if (isRequestContextAbort(e) || !isClientRequestContextCurrent(requestContext)) return
		if (chatID.value === target && !prompt.value) prompt.value = originalPrompt
		showNotice(t('chat.sendFailed'))
	} finally { pendingMessage.value = undefined }
}

async function manage(kind: 'stop' | 'compact' | 'fork', turnId?: string) {
	if (!chatID.value || action.isPending.value) return
	if (kind === 'fork' && !window.confirm(t('chat.forkConfirm'))) return
	if (kind === 'compact' && !window.confirm(t('chat.compactConfirm'))) return
	const id = chatID.value
	// No instruction may follow a stop into the run it ends.
	const stopping = kind === 'stop' ? steerTurnID.value : ''
	if (stopping) stopRequested.value = stopping
	try {
		const result = await action.mutateAsync({
			id,
			action: kind,
			title: newTitle.value.trim(),
			turnId,
			connectionId: selectedConnection.value,
		})
		if (!stillHere() || chatID.value !== id) return
		if (kind === 'fork' && result?.id) await selectConversation(result.id)
	} catch {
		if (stopping && stopRequested.value === stopping) stopRequested.value = ''
	}
}

// Kept while the menu's fields stay the same: the conversation object itself changes with every streamed delta.
const currentSummary = computed<ConversationSummary>(previous => {
	const conversation = active.value
	const next: ConversationSummary = {
		id: conversation?.id,
		parent_id: conversation?.parent_id,
		title: conversation?.title,
		pinned: conversation?.pinned,
		archived: conversation?.archived,
		running: activeRun.value,
	}
	const keys = Object.keys(next) as (keyof ConversationSummary)[]
	return previous && keys.every(key => previous[key] === next[key]) ? previous : next
})
async function historyAction(kind: string, conversation: ConversationSummary) {
	if (!conversation.id || action.isPending.value) return
	if (kind === 'rename' || kind === 'delete') {
		newTitle.value = conversation.title ?? ''
		historyDialog.value = {kind, conversation}
		return
	}
	if (kind === 'export') {
		exportOpen.value = true
		return
	}
	if (kind === 'compact') {
		await manage('compact')
		return
	}
	try {
		await action.mutateAsync({
			id: conversation.id,
			action: 'organize',
			...(kind === 'pin' ? {pinned: !conversation.pinned} : {archived: !conversation.archived}),
		})
	} catch { return }
}
async function confirmHistoryAction() {
	const target = historyDialog.value
	if (!target?.conversation.id || action.isPending.value || (target.kind === 'rename' && !newTitle.value.trim())) return
	const id = target.conversation.id
	const owner = steerQueueOwner(captureClientRequestContext())
	try {
		await action.mutateAsync({id, action: target.kind, title: newTitle.value.trim()})
		if (historyDialog.value === target) historyDialog.value = undefined
		if (target.kind === 'delete') {
			writeDraft(id, '')
			dropSteerFailures(owner, failure => failure.chat !== id)
			if (chatID.value === id && stillHere()) {
				prompt.value = ''
				await navigateConversation('')
			}
			await nextTick()
			queryClient.removeQueries({queryKey: conversationKeys.detail(id)})
			try { sessionStorage.removeItem(optionsStorageKey(id)) } catch { /* Browser storage is optional. */ }
		}
	} catch { return }
}

async function reviewOperation(body: ReviewInput) {
	if (!chatID.value || review.isPending.value) return
	try { await review.mutateAsync({id: chatID.value, body}) } catch { return }
}

// While this conversation's run works, the composer steers it; otherwise it sends a new message.
function submitComposer() {
	if (steering.value) void sendSteer()
	else void submit()
}

function composerKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
		event.preventDefault()
		submitComposer()
	}
}

let scrollFrame = 0
// The last position the follow animation set and the last one observed: a position above them is the user's.
let followTop = 0
let lastTop = 0
let interactionAt = -Infinity
function stopFollowing() {
	cancelAnimationFrame(scrollFrame)
	scrollFrame = 0
}
function detach() {
	stopFollowing()
	stickToBottom.value = false
}
function fromBottom(el: HTMLElement) {
	return el.scrollHeight - el.scrollTop - el.clientHeight
}
function trackScroll() {
	const el = thread.value
	if (!el) return
	// Wheel, touch, keys and the scrollbar all move up; content that shrinks only clamps at the very bottom.
	const movedUp = el.scrollTop < (scrollFrame ? followTop : lastTop) - 1 && fromBottom(el) > 2
	lastTop = el.scrollTop
	if (movedUp) detach()
	else if (!scrollFrame) stickToBottom.value = fromBottom(el) < 120
}
function userScroll(event: WheelEvent) {
	if (event.deltaY < 0) detach()
}
function threadKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || !['PageUp', 'ArrowUp', 'Home'].includes(event.key)) return
	if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]')) return
	detach()
}
function markInteraction() {
	interactionAt = performance.now()
}
function followOutput() {
	if (!stickToBottom.value || scrollFrame || !thread.value) return
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	let previous = performance.now()
	followTop = thread.value.scrollTop
	const follow = (now: number) => {
		const el = thread.value
		if (!el || !stickToBottom.value) {
			scrollFrame = 0
			return
		}
		if (el.scrollTop < followTop - 1 && fromBottom(el) > 2) {
			scrollFrame = 0
			stickToBottom.value = false
			return
		}
		const target = el.scrollHeight - el.clientHeight
		const distance = target - el.scrollTop
		if (reducedMotion || Math.abs(distance) < 1 || Math.abs(distance) > el.clientHeight) {
			el.scrollTop = target
			followTop = el.scrollTop
			scrollFrame = 0
			return
		}
		// Time-based easing follows new text without restarting a browser smooth-scroll animation.
		el.scrollTop += distance * (1 - Math.exp(-Math.max(8, now - previous) / 45))
		followTop = el.scrollTop
		previous = now
		scrollFrame = requestAnimationFrame(follow)
	}
	scrollFrame = requestAnimationFrame(follow)
}
function jumpToLatest() {
	stickToBottom.value = true
	thread.value?.scrollTo({top: thread.value.scrollHeight, behavior: 'instant'})
}
watch([shownTurns, () => shownTurns.value?.at(-1)?.result], followOutput, {flush: 'post'})
// Throttled Markdown, decoded images and opened details grow the thread without a data change.
const threadContent = ref<HTMLElement>()
let contentObserver: ResizeObserver | undefined
onMounted(() => {
	if (!threadContent.value || typeof ResizeObserver === 'undefined') return
	contentObserver = new ResizeObserver(() => {
		// Something the user just opened stays where it is instead of scrolling away.
		if (performance.now() - interactionAt > 300) followOutput()
	})
	contentObserver.observe(threadContent.value)
})
onBeforeUnmount(() => {
	stopFollowing()
	contentObserver?.disconnect()
})

function captureSpeechOwner() {
	const connection = speechConnection.value
	return {
		context: captureClientRequestContext(),
		chat: chatID.value,
		connectionID: connection?.id ?? '',
		protocol: connection?.protocol ?? 'openai-transcription',
		configuration: JSON.stringify(connection),
		cleanup: tidy.value,
	}
}
type SpeechOwner = ReturnType<typeof captureSpeechOwner>
function speechOwnerIsCurrent(owner: SpeechOwner) {
	return !disposed && presenting.value && isClientRequestContextCurrent(owner.context) && chatID.value === owner.chat
		&& owner.connectionID !== '' && owner.configuration === JSON.stringify(speechConnection.value)
}
let speechAttempt: SpeechOwner | undefined
let audioOperation = 0
let audioController: AbortController | undefined
let uploadOwner: SpeechOwner | undefined
let cleanupController: AbortController | undefined
let cleanupOwner: {context: ReturnType<typeof captureClientRequestContext>, chat: string} | undefined
function cancelVoice() {
	microphone.cancel()
	audioController?.abort()
	cleanupController?.abort()
	speechAttempt = undefined
	audioOperation++
	audioStage.value = ''
}
function voiceKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || !(recording.value || microphonePending.value || microphoneStopping.value || audioStage.value || cleanupController)) return
	event.preventDefault()
	event.stopPropagation()
	cancelVoice()
}
// A hidden panel or a changed identity must never keep recording or apply a late transcript.
watch([chatID, () => JSON.stringify(speechConnection.value)], () => {
	uploadOwner = undefined
	cancelVoice()
}, {flush: 'sync'})
watch(presenting, shown => { if (!shown) cancelVoice() }, {flush: 'sync'})
watch([() => auth.session, tokenRefreshes], () => {
	if (!speechAttemptIsCurrent() || cleanupOwner && !isClientRequestContextCurrent(cleanupOwner.context)) cancelVoice()
}, {flush: 'sync'})
function speechAttemptIsCurrent() {
	return !speechAttempt || speechOwnerIsCurrent(speechAttempt)
}
// pagehide also covers Safari navigation/BFCache before visibility events have settled.
onMounted(() => window.addEventListener('pagehide', cancelVoice))
onBeforeUnmount(() => window.removeEventListener('pagehide', cancelVoice))
async function processAudio(file: Blob, filename: string, owner = captureSpeechOwner()) {
	if (!speechOwnerIsCurrent(owner) || audioStage.value) return
	if (file.size > 16 * 1024 * 1024) {
		showNotice(t('tcymc.text.audio_must_not_exceed_16_mib'))
		return
	}
	if (!file.size) {
		showNotice(t('tcymc.text.the_recording_is_empty_please_try_again'))
		return
	}
	speechAttempt = owner
	const operation = ++audioOperation
	const controller = new AbortController()
	audioController = controller
	const current = () => operation === audioOperation && !controller.signal.aborted && speechOwnerIsCurrent(owner)
	dismissNotice()
	audioStage.value = 'preparing'
	try {
		if (speechSampleRate(owner.protocol) || ['openai-audio', 'mimo-asr', 'dashscope-file-asr', 'sensevoice'].includes(owner.protocol)) {
			audioStage.value = 'audioConverting'
			try {
				const converted = await prepareSpeechFile(file, filename, owner.protocol)
				file = converted.file
				filename = converted.filename
			} catch {
				if (current()) showNotice(t('tcymc.audioConversionFailed'))
				return
			}
		}
		if (!current()) return
		const audio = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(String(reader.result).split(',')[1])
			reader.onerror = reject
			reader.readAsDataURL(file)
		})
		if (!current()) return
		audioStage.value = 'audioProcessing'
		const result = await transcribe.mutateAsync({audio, filename, connection_id: owner.connectionID, cleanup: owner.cleanup, signal: controller.signal})
		if (!current()) return
		original.value = result.original ?? ''
		prompt.value = [prompt.value, result.text].filter(Boolean).join('\n')
		if (result.warning) showNotice(result.warning)
		else showNotice(t('tcymc.text.transcription_complete_edit_the_text_if_needed_then'), 'info')
	} catch (e) {
		if (!current() || isRequestContextAbort(e)) return
		showNotice(t('tcymc.text.speech_recognition_failed_check_the_model_settings_or'))
	} finally {
		if (operation === audioOperation) { audioStage.value = ''; audioController = undefined }
	}
}

function startRecording() {
	if (voiceBusy.value || !hasSpeech.value || !presenting.value) return
	dismissNotice()
	speechAttempt = captureSpeechOwner()
	void microphone.start()
}

function chooseAudio() {
	if (voiceBusy.value || !hasSpeech.value) return
	uploadOwner = captureSpeechOwner()
	speechAttempt = uploadOwner
	// Keep this synchronous with the user's click (iOS file picker activation).
	audioInput.value?.click()
}
async function upload(event: Event) {
	const input = event.target as HTMLInputElement
	const file = input.files?.[0]
	const owner = uploadOwner
	uploadOwner = undefined
	input.value = ''
	if (file && owner && !voiceBusy.value) await processAudio(file, file.name, owner)
}

async function tidyText() {
	if (voiceBusy.value || !prompt.value.trim() || !settings.data.value?.cleanup) return
	const text = prompt.value
	const revision = draftRevision
	const context = captureClientRequestContext()
	const chat = chatID.value
	const controller = new AbortController()
	cleanupController = controller
	cleanupOwner = {context, chat}
	try {
		const result = await cleanup.mutateAsync({text, signal: controller.signal})
		if (disposed || controller.signal.aborted || !presenting.value || chatID.value !== chat || !isClientRequestContextCurrent(context)) return
		if (draftRevision !== revision) {
			showNotice(t('tcy.voice.draftChanged'), 'info')
			return
		}
		original.value = result.original ?? ''
		prompt.value = result.text ?? ''
	} catch { return } finally {
		if (cleanupController === controller) { cleanupController = undefined; cleanupOwner = undefined }
	}
}

onBeforeUnmount(() => {
	disposed = true
	cancelVoice()
})
</script>

<template>
	<div
		class="tcy-assistant"
		:class="{
			'is-embedded': embedded,
			'has-overlay-history': historyOverlay,
		}"
		@keydown.capture="voiceKeydown"
	>
		<header class="assistant-heading">
			<div class="heading-actions heading-start">
				<BaseButton
					ref="historyToggle"
					class="toolbar-button"
					:title="t('chat.conversations')"
					:aria-label="t('chat.conversations')"
					:aria-expanded="sidebarOpen"
					@click="toggleSidebar"
				>
					<Icon icon="history" />
				</BaseButton>
				<div class="assistant-identity">
					<AronaAvatar size="small" />
					<div class="assistant-title">
						<h1 v-if="!embedded">
							{{ t('tcymc.text.ai_task_assistant') }}
						</h1>
						<template v-else-if="!hasConversation">
							<strong class="panel-title">{{ t('floatingArona.title') }}</strong>
							<span class="panel-hint">{{ t('floatingArona.context') }}</span>
						</template>
						<p
							class="live-connection"
							:class="{
								'is-idle': !chatID,
								'is-running': activeRun,
							}"
							:title="chatID ? `${liveStatus} · ${t('flow.backgroundNote')}` : undefined"
						>
							<template v-if="chatID">
								<span
									class="live-dot"
									:class="{connected: events.connected.value}"
									aria-hidden="true"
								/>
								<span
									class="live-label"
									aria-hidden="true"
								>{{ liveLabel }}</span>
								<span class="is-sr-only">{{ liveStatus }}</span>
								<span
									class="live-separator"
									aria-hidden="true"
								>·</span>
							</template>
							<span class="background-note">{{ t('flow.backgroundNote') }}</span>
						</p>
					</div>
				</div>
			</div>
			<div
				v-if="hasConversation"
				class="conversation-toolbar"
			>
				<strong
					class="conversation-title"
					:title="conversationTitle"
				>{{ conversationTitle }}</strong>
				<ConversationMenu
					:conversation="currentSummary"
					current
					:can-compact="canCompact && !busy"
					:disabled="editingBusy"
					@action="historyAction($event, currentSummary)"
				/>
			</div>
			<div class="heading-actions heading-end">
				<BaseButton
					class="toolbar-button"
					:aria-label="t('chat.new')"
					:title="t('chat.new')"
					:aria-disabled="editingBusy"
					@click="newConversation"
				>
					<Icon icon="plus" />
				</BaseButton>
				<BaseButton
					class="toolbar-button"
					:title="t('debug.title')"
					:aria-label="t('debug.title')"
					@click="openDiagnostics"
				>
					<Icon icon="code" />
				</BaseButton>
				<!-- The floating panel's own controls share this row instead of stacking a second header. -->
				<slot name="panel-actions" />
			</div>
		</header>
		<div
			class="chat-shell"
			:class="{'with-history': sidebarOpen}"
		>
			<button
				v-if="sidebarOpen"
				type="button"
				class="history-backdrop"
				tabindex="-1"
				:aria-label="t('chatHistory.close')"
				@click="closeSidebar"
			/>
			<aside
				v-if="sidebarOpen"
				ref="sidebar"
				class="chat-sidebar"
				tabindex="-1"
				:aria-label="t('chat.conversations')"
				@keydown.esc="sidebarKeydown"
			>
				<ConversationHistory
					ref="historyPanel"
					:selected="chatID"
					:disabled="editingBusy"
					:show-create="historyOverlay"
					@select="selectConversation"
					@create="newConversation"
					@close="closeSidebar"
					@action="historyAction"
				/>
				<div class="sidebar-footer">
					<p class="session-note">
						<Icon icon="lock" /> {{ t('chat.savedOnServer') }}
					</p>
					<details
						class="system-prompt"
						@toggle="showSystemPrompt = ($event.target as HTMLDetailsElement).open"
					>
						<summary><Icon icon="code" /> {{ t('chat.systemPrompt') }}</summary>
						<p v-if="effectivePrompt.isPending.value">
							{{ t('misc.loading') }}
						</p>
						<template v-else>
							<pre>{{ effectivePrompt.data.value?.system_prompt }}</pre>
							<details>
								<summary>{{ t('chat.availableTools') }}</summary><pre>{{ effectivePrompt.data.value?.tool_schema }}</pre>
							</details>
							<p>{{ t('chat.promptNote') }}</p>
						</template>
					</details>
				</div>
			</aside>
			<section
				class="chat-main"
				:aria-label="t('tcymc.text.assistant_conversation')"
			>
				<LoadError
					v-if="chatID && current.isError.value && !hasConversation"
					class="chat-error"
					:message="t('chat.loadFailed')"
					:retry="() => current.refetch()"
				/>
				<div
					v-if="hasStatusChips"
					class="conversation-status"
				>
					<p
						v-if="contextTaskID > 0"
						class="status-chip context-chip"
					>
						<Icon icon="list-check" />{{ t('agent.currentTask') }} <RouterLink :to="{name: 'task.detail', params: {id: contextTaskID}}">
							#{{ contextTaskID }}
						</RouterLink>
					</p>
					<div
						v-if="archived"
						class="status-chip archived-notice"
					>
						<Icon icon="archive" /><span>{{ t('chatHistory.archivedNotice') }}</span><button
							type="button"
							class="chip-action"
							:disabled="action.isPending.value"
							@click="historyAction('archive', currentSummary)"
						>
							{{ t('chatHistory.restore') }}
						</button>
					</div>
					<details
						v-if="storage"
						class="status-chip conversation-storage"
					>
						<summary>{{ t('chatFiles.storageLine', {bytes: chatBytes(storage.total_bytes), count: storage.attachment_count}) }}</summary>
						<p>{{ t('chatFiles.storageDetail', {record: chatBytes(storage.record_bytes), files: chatBytes(storage.attachment_bytes)}) }}</p>
						<p>{{ t('chatFiles.storageHint') }}</p>
						<p v-if="storage.drive_attachment_count">
							{{ t('chatFiles.storageDrive', {count: storage.drive_attachment_count, bytes: chatBytes(storage.drive_attachment_bytes)}) }}
						</p>
						<p v-if="storage.missing_count">
							{{ t('chatFiles.missingCount', {count: storage.missing_count}) }}
						</p>
					</details>
					<details
						v-if="lastCompaction"
						class="status-chip summary-banner"
					>
						<summary><Icon icon="compress" /> {{ t('chat.compacted', {count: lastCompaction.through}) }}</summary>
						<p class="chip-note">
							{{ t('chat.originalsPreserved') }}
						</p>
						<p class="summary-text">
							{{ lastCompaction.summary }}
						</p>
						<p class="chip-note">
							{{ lastCompaction.model }} · {{ t('chat.totalTokens') }}: {{ lastCompaction.usage?.reported ? (lastCompaction.usage?.input ?? 0) + (lastCompaction.usage?.output ?? 0) : t('chat.unavailable') }}
						</p>
					</details>
				</div>
				<section
					v-if="compacting || compactError || compactProgress"
					class="compact-progress"
					:class="{'has-error': Boolean(compactError)}"
					role="status"
				>
					<strong>{{ compacting ? t('flow.compacting') : compactError ? t('flow.compactFailed') : t('flow.compactDone') }}</strong>
					<p v-if="compactProgress">
						{{ t('flow.compactBatch', {batch: compactProgress.batch, total: compactProgress.batches, attempt: compactProgress.attempt}) }}
						· {{ t('chat.totalTokens') }}: {{ compactProgress.usage?.reported ? (compactProgress.usage.input ?? 0) + (compactProgress.usage.output ?? 0) : t('chat.unavailable') }}
						· {{ t('chat.seconds', {value: ((compactProgress.duration_ms ?? 0) / 1000).toFixed(1)}) }}
					</p>
					<progress
						v-if="compacting"
						:aria-label="t('flow.compacting')"
					/>
					<p v-if="compactError">
						{{ compactError }}
					</p>
					<details v-if="compacting && compactText">
						<summary>{{ t('flow.compactDraft') }}</summary>
						<pre>{{ compactText }}</pre>
					</details>
					<div class="compact-actions">
						<button
							v-if="compactError && !busy && canCompact"
							type="button"
							class="text-button"
							@click="manage('compact')"
						>
							{{ t('flow.compactRetry') }}
						</button>
						<button
							type="button"
							class="text-button"
							@click="active && openCompactDiagnostic(active)"
						>
							{{ t('flow.compactDiagnostics') }}
						</button>
					</div>
				</section>
				<div
					ref="thread"
					class="conversation"
					role="log"
					aria-live="off"
					tabindex="0"
					:aria-label="t('assistantUI.messages')"
					@scroll.passive="trackScroll"
					@wheel.passive="userScroll"
					@touchstart.passive="stopFollowing"
					@pointerdown="stopFollowing"
					@keydown="threadKeydown"
					@click.capture="markInteraction"
				>
					<div
						v-if="chatID && current.isPending.value"
						class="thread-skeleton"
						role="status"
					>
						<span class="is-sr-only">{{ t('assistantUI.loadingConversation') }}</span>
						<span
							class="skeleton-bubble is-request"
							aria-hidden="true"
						/>
						<span
							class="skeleton-bubble"
							aria-hidden="true"
						/>
						<span
							class="skeleton-bubble is-short"
							aria-hidden="true"
						/>
					</div>
					<AronaWelcome
						v-if="showWelcome"
						:needs-setup="needsSetup"
						:disabled="!optionsReady"
						@choose="applySuggestion"
					/>
					<!-- Observed for size changes; unstyled, so the turns lay out as before. -->
					<div
						ref="threadContent"
						class="conversation-content"
					>
						<ChatThread
							:read-turns="readShownTurns"
							:pending-turn="pendingMessage?.turn"
							:conversation-id="chatID"
							:busy="busy"
							:review-busy="review.isPending.value || action.isPending.value"
							:reveal="revealTurns"
							:scroll-root="threadElement"
							@review="reviewOperation"
							@fork="manage('fork', $event)"
						/>
					</div>
				</div>
				<div
					v-if="needsSetup && hasTurns"
					class="setup-note"
				>
					<RouterLink to="/user/settings/ai">
						{{ t('tcymc.text.add_a_connection_in_ai_and_voice_settings') }}
					</RouterLink>
				</div>
				<div class="composer-dock">
					<XButton
						v-if="!stickToBottom && hasTurns"
						class="jump-latest is-small"
						variant="secondary"
						icon="arrow-down"
						:shadow="false"
						@click="jumpToLatest"
					>
						{{ t('flow.jumpLatest') }}
					</XButton>
					<LoadError
						v-if="settingsFailed"
						class="composer-load-error"
						:message="t('assistantUI.settingsLoadFailed')"
						:retry="() => settings.refetch()"
					/>
					<LoadError
						v-if="preferencesFailed"
						class="composer-load-error"
						:message="t('assistantUI.preferencesLoadFailed')"
						:retry="() => preferences.refetch()"
					/>
					<p
						v-if="runningElsewhere && !activeRun"
						class="paused-notice running-elsewhere"
						role="status"
					>
						<span>{{ t('assistantUI.runningElsewhere', {title: liveRunTitle}) }}</span>
						<XButton
							variant="secondary"
							class="is-small"
							icon="arrow-right"
							:shadow="false"
							:aria-disabled="editingBusy"
							@click="!editingBusy && selectConversation(liveRun)"
						>
							{{ t('assistantUI.openRunning') }}
						</XButton>
					</p>
					<p
						v-if="paused"
						class="paused-notice"
						role="status"
					>
						<span>{{ t('agent.waitingReview') }}</span>
						<XButton
							variant="secondary"
							class="is-small"
							icon="stop"
							:shadow="false"
							@click="manage('stop')"
						>
							{{ t('chat.stop') }}
						</XButton>
					</p>
					<form
						ref="composerForm"
						class="composer"
						tabindex="-1"
						:class="{'is-drop-target': dragging}"
						@dragenter="dragEnter"
						@dragover.prevent
						@dragleave="dragLeave"
						@drop.prevent="dropFiles"
						@paste="pasteFiles"
						@submit.prevent="submitComposer"
					>
						<input
							ref="fileInput"
							type="file"
							multiple
							class="hidden-input"
							@change="chooseFiles"
						>
						<div
							v-if="draftFiles.length"
							class="chat-attachment-grid draft-files"
						>
							<ChatAttachmentCard
								v-for="file in draftFiles"
								:key="file.id"
								:conversation-id="chatID"
								:file="file"
								removable
								:disabled="busy"
								@remove="removeDraft"
							/>
						</div>
						<ChatUploadTray
							v-if="chatUploads.items.value.length"
							:items="chatUploads.items.value"
							:running="chatUploads.running.value"
							:disabled="busy"
							@retry="retryUploads"
							@retryFailed="retryUploads()"
							@cancel="chatUploads.cancel"
							@dismiss="chatUploads.dismiss"
							@clearFinished="chatUploads.clearFinished"
						/>
						<p
							v-if="draftFiles.length"
							class="attachment-input-hint"
						>
							{{ t(steering ? 'aronaSteer.textOnly' : 'chatFiles.fileInputHint') }}
						</p>
						<p
							v-if="imageMismatch"
							class="composer-warning"
							role="status"
						>
							{{ t('chatFiles.imageModelRequired') }}
						</p>
						<label
							:for="promptID"
							class="composer-label is-sr-only"
						>{{ t('tcymc.text.your_request') }}</label><textarea
							:id="promptID"
							ref="composerInput"
							v-model="prompt"
							data-tour="ai-prompt"
							class="textarea"
							rows="1"
							:maxlength="steering ? 64000 : 12000"
							:placeholder="t(steering ? 'aronaSteer.placeholder' : 'assistantUI.placeholder')"
							@keydown="composerKeydown"
						/>
						<input
							ref="audioInput"
							class="hidden-input"
							type="file"
							accept="audio/*"
							@change="upload"
							@cancel="uploadOwner = undefined"
						>
						<div
							class="composer-tools"
							:class="{'is-steering': showSteerSend}"
							data-tour="ai-voice"
						>
							<div class="composer-context">
								<AttachMenu
									:disabled="busy"
									@device="fileInput?.click()"
									@drive="driveOpen = true"
								/>
								<SpeechInputControl
									v-model:tidy="tidy"
									:disabled="voiceBusy || !hasSpeech"
									:disabled-reason="!hasSpeech ? t('tcy.voice.setupHint') : ''"
									:recording="recording"
									:requesting="microphonePending"
									:stopping="microphoneStopping"
									:processing="Boolean(audioStage) || cleanup.isPending.value"
									:processing-label="audioStage ? t(`flow.${audioStage}`) : ''"
									:elapsed="elapsed"
									:can-cleanup="Boolean(settings.data.value?.cleanup)"
									:can-tidy="!voiceBusy && Boolean(prompt.trim() && settings.data.value?.cleanup)"
									@start="startRecording"
									@stop="microphone.stop"
									@cancel="cancelVoice"
									@upload="chooseAudio"
									@tidy="tidyText"
								/>
								<MCPSessionPicker
									:model-value="mcpServerIDs"
									:disabled="!optionsReady || editingBusy || activeRun || Boolean(paused) || archived"
									:write-scoped="writeProjectIDs.length > 0"
									@update:modelValue="mcpServerIDs = $event; applyOptions(currentOptions, '')"
								/>
								<label
									class="composer-chip profile-switch"
									:title="t('assistantUI.scenarios')"
								><span class="is-sr-only">{{ t('assistantUI.scenarios') }}</span><select
									:value="selectedProfile"
									:disabled="!optionsReady"
									@change="selectProfile(($event.target as HTMLSelectElement).value)"
								><option
									v-if="!selectedProfile"
									value=""
								>{{ t('assistantUI.custom') }}</option><option
									v-for="p in profiles"
									:key="p.id"
									:value="p.id"
								>{{ p.name }}</option></select><Icon
									icon="chevron-down"
									class="chip-chevron"
								/></label>
								<BaseButton
									class="toolbar-button preferences-toggle"
									data-tour="ai-permissions"
									:title="t('assistantUI.preferences')"
									:aria-label="t('assistantUI.preferences')"
									:disabled="!optionsReady"
									@click="preferencesOpen = true"
								>
									<Icon icon="cog" />
								</BaseButton>
								<label
									class="composer-chip model-switch"
									:title="t('chat.model')"
								><span class="is-sr-only">{{ t('chat.model') }}</span><select
									v-model="connectionID"
									:disabled="!optionsReady"
									@change="applyOptions(currentOptions, '')"
								><option value="">{{ assignedModelName }}</option><option
									v-for="c in chatModels"
									:key="c.id"
									:value="c.id"
								>{{ c.name }}</option><option
									v-if="connectionID && !chatModels.some(c => c.id === connectionID)"
									:value="connectionID"
								>{{ t('assistantUI.missingModel') }}</option></select><Icon
									icon="chevron-down"
									class="chip-chevron"
								/></label>
								<label
									v-if="showSearchSwitch"
									class="composer-chip search-switch"
									:title="t('webSearch.modeHelp')"
								>
									<Icon
										icon="globe"
										class="chip-icon"
									/>
									<span class="search-label">{{ t('webSearch.title') }}</span>
									<select
										v-model="searchMode"
										:aria-label="t('webSearch.turnMode')"
										:disabled="!optionsReady"
										@change="applyOptions(currentOptions, '')"
									>
										<option value="auto">{{ t('webSearch.auto') }}</option>
										<option
											value="required"
											:disabled="!canSearch"
										>{{ t('webSearch.required') }}</option>
										<option value="off">{{ t('webSearch.off') }}</option>
									</select>
									<Icon
										icon="chevron-down"
										class="chip-chevron"
									/>
								</label>
								<RouterLink
									v-if="!canSearch && searchMode === 'required'"
									class="search-setup"
									to="/user/settings/ai"
								>
									{{ t('webSearch.configure') }}
								</RouterLink>
							</div>
							<div class="composer-actions">
								<XButton
									v-if="activeRun"
									:variant="showSteerSend ? 'secondary' : 'primary'"
									icon="stop"
									class="send composer-stop"
									icon-only
									:title="t('chat.stop')"
									:aria-disabled="action.isPending.value"
									@click="manage('stop')"
								>
									<span class="is-sr-only">{{ t('chat.stop') }}</span>
								</XButton><XButton
									v-if="showSteerSend"
									variant="primary"
									icon="arrow-up"
									class="composer-steer"
									type="submit"
									:aria-disabled="steerBlocked"
								>
									{{ t('aronaSteer.send') }}
								</XButton><XButton
									v-else-if="!activeRun"
									variant="primary"
									icon="arrow-up"
									class="send"
									icon-only
									type="submit"
									:aria-disabled="busy || !hasAssistant || runningElsewhere || (!prompt.trim() && !draftFiles.length) || imageMismatch"
								>
									<span class="is-sr-only">{{ send.isPending.value ? t('chat.sending') : t('tcymc.text.send_request') }}</span>
								</XButton>
							</div>
						</div>
						<p
							v-if="steering"
							class="composer-hint is-steering"
						>
							<Icon
								icon="clock"
								class="mode-icon"
							/>
							<span>{{ t(steerHint) }}</span>
							<span v-if="waitingSteers">· {{ t('aronaSteer.waiting', {count: waitingSteers}) }}</span>
							<span
								v-if="!steerBlocked"
								class="enter-hint"
							>· {{ t('aronaSteer.enterHint') }}</span>
						</p>
						<p
							v-else-if="compacting && prompt.trim()"
							class="composer-hint"
						>
							{{ t('aronaSteer.compacting') }}
						</p>
						<p
							v-else
							class="composer-hint"
							:class="mode === 'read' ? 'is-read' : 'is-write'"
						>
							<Icon
								:icon="mode === 'read' ? 'eye' : 'pen'"
								class="mode-icon"
							/>
							<span>{{ t('assistantUI.nextConfiguration') }} {{ mode === 'read' ? t('assistantUI.readStatus') : t(`assistantUI.write_${approval}`) }}</span>
							<span v-if="nextProjectTitle">· {{ nextProjectTitle }}</span>
							<span v-if="enableSubagents">· {{ t('assistantUI.subagentsTag') }}</span>
							<span class="enter-hint">· {{ t('chat.enterHint') }}</span>
						</p>
						<div
							class="notice-region"
							role="status"
						>
							<!-- The note says the text is in the input only while it still is; otherwise it quotes it. -->
							<div
								v-for="failure in shownSteerFailures"
								:key="failure.requestID"
								class="notice steer-failure"
							>
								<div class="steer-failure-body">
									<strong>{{ t(failure.state === 'refused' ? 'aronaSteer.refused' : 'aronaSteer.failed') }}</strong>
									<span v-if="failure.reason">{{ failure.reason }}</span>
									<span v-if="failure.restored && prompt === failure.restored">
										{{ t(failure.state === 'refused' ? 'aronaSteer.restored' : 'aronaSteer.restoredRetry') }}
									</span>
									<template v-else>
										<span>{{ t('aronaSteer.kept') }}</span>
										<q class="steer-failure-text">{{ failure.message }}</q>
									</template>
									<span v-if="!steerQueue.saved">{{ t('aronaSteer.notSaved') }}</span>
								</div>
								<button
									v-if="failure.state === 'failed'"
									type="button"
									class="steer-retry"
									:aria-disabled="steer.isPending.value"
									@click="sendSteer(failure)"
								>
									<Icon icon="redo" />{{ t('aronaSteer.retry') }}
								</button>
								<button
									type="button"
									class="notice-dismiss"
									:aria-label="t('misc.close')"
									:title="t('misc.close')"
									@click="dismissSteerFailure(failure)"
								>
									<Icon icon="times" />
								</button>
							</div>
							<span class="is-sr-only">{{ steerAnnouncement }}</span>
							<p
								v-if="notice"
								class="notice"
								:class="{'notice-info': notice.tone === 'info'}"
							>
								<span>{{ notice.text }}</span>
								<button
									type="button"
									class="notice-dismiss"
									:aria-label="t('misc.close')"
									:title="t('misc.close')"
									@click="dismissNotice"
								>
									<Icon icon="times" />
								</button>
							</p>
						</div>
						<details
							v-if="original"
							class="original-transcript"
						>
							<summary>{{ t('tcymc.text.view_original_transcript_or_text') }}</summary><p class="original">
								{{ original }}
							</p>
						</details>
						<!-- Last in the form so it paints over the positioned chips without a z-index. -->
						<p
							v-if="dragging"
							class="drop-hint"
							aria-hidden="true"
						>
							<Icon icon="paperclip" />{{ t('chatFiles.dropToAttach') }}
						</p>
					</form>
				</div>
			</section>
		</div>
		<Modal
			v-if="historyDialog"
			class="history-action-modal"
			:loading="action.isPending.value"
			:aria-label="t(historyDialog?.kind === 'delete' ? 'chat.delete' : 'chat.rename')"
			@close="historyDialog = undefined"
		>
			<form
				class="history-dialog"
				@submit.prevent="confirmHistoryAction"
			>
				<h2>{{ t(historyDialog?.kind === 'delete' ? 'chat.delete' : 'chat.rename') }}</h2>
				<template v-if="historyDialog?.kind === 'delete'">
					<p class="history-delete-title">
						{{ historyDialog.conversation.title || t('chat.untitled') }}
					</p><p>{{ t('chatHistory.deleteHint') }}</p>
				</template>
				<label v-else>{{ t('chatHistory.title') }}<input
					v-model="newTitle"
					class="input"
					maxlength="150"
					required
					autofocus
					:aria-label="t('chatHistory.title')"
				></label>
				<div class="history-dialog-actions">
					<XButton
						variant="secondary"
						:shadow="false"
						:disabled="action.isPending.value"
						@click="historyDialog = undefined"
					>
						{{ t('misc.cancel') }}
					</XButton><XButton
						type="submit"
						:shadow="false"
						:danger="historyDialog?.kind === 'delete'"
						:loading="action.isPending.value"
						:disabled="action.isPending.value || (historyDialog?.kind === 'rename' && !newTitle.trim())"
					>
						{{ t(historyDialog?.kind === 'delete' ? 'chat.delete' : 'misc.save') }}
					</XButton>
				</div>
			</form>
		</Modal>

		<DrivePicker
			v-if="driveOpen"
			:busy="drivePicking || attachDrive.isPending.value || create.isPending.value"
			@close="driveOpen = false"
			@select="chooseDriveFile"
		/>
		<ConversationExport
			v-if="exportOpen && active"
			:conversation="active"
			@close="exportOpen = false"
		/>
		<AssistantPreferences
			v-if="preferencesOpen"
			:options="currentOptions"
			:profile="selectedProfile"
			@close="preferencesOpen = false"
			@apply="applyOptions"
		/>
	</div>
</template>

<style scoped lang="scss">
.tcy-assistant {
	// Banners, thread and composer share one 48rem reading column.
	--column-gutter: var(--space-6);
	--column-inset: max(var(--column-gutter), calc((100% - 48rem) / 2));

	display: flex;
	flex-direction: column;
	block-size: 100%;
	min-block-size: 0;
	background: var(--surface);
	color: var(--text-primary);
	font-family: var(--font-ui);
}

// Header: history, identity, current conversation, actions in one calm row.
.assistant-heading {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--header-height);
	padding: var(--space-1) var(--space-3);
	border-block-end: 1px solid var(--border-subtle);
}

.heading-actions {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
}

.heading-start {
	flex-shrink: 1;
}

.heading-end {
	margin-inline-start: auto;
}

.toolbar-button {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	gap: var(--space-1);
	min-inline-size: var(--control-height);
	min-block-size: var(--control-height);
	padding: 0;
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	white-space: nowrap;

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&[aria-expanded='true'] {
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&[aria-disabled='true'],
	&:disabled {
		opacity: .5;
		cursor: not-allowed;
	}
}

.assistant-identity {
	position: relative;
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	padding-inline: var(--space-1);
}

.assistant-title {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
}

h1 {
	margin: 0;
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.live-connection {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	margin: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-tight);
	white-space: nowrap;
}

// The background-run reassurance matters while a run is active; otherwise it stays for screen readers only.
.live-connection.is-idle,
.live-connection:not(.is-running) .live-separator,
.live-connection:not(.is-running) .background-note {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

.background-note {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.live-dot {
	flex-shrink: 0;
	inline-size: .5rem;
	block-size: .5rem;
	border: 2px solid var(--text-tertiary);
	border-radius: var(--radius-full);
	// Hollow while polling, filled when live: compact layouts hide the label, so state does not rest on colour alone.
	background: var(--surface);

	&.connected {
		border-color: var(--success);
		background: var(--success);
	}
}

.panel-title {
	margin-inline-start: var(--space-2);
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.panel-hint {
	margin-inline-start: var(--space-2);
	overflow: hidden;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-tight);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.conversation-toolbar {
	display: flex;
	flex: 1 1 auto;
	align-items: center;
	justify-content: center;
	gap: var(--space-1);
	min-inline-size: 0;
}

.conversation-title {
	min-inline-size: 0;
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	text-overflow: ellipsis;
	white-space: nowrap;
}

// Shell: optional history column and the conversation.
// Isolated so the history overlay layers stay local to the assistant.
.chat-shell {
	position: relative;
	isolation: isolate;
	display: grid;
	flex: 1;
	grid-template-columns: minmax(0, 1fr);
	min-block-size: 0;

	&.with-history {
		grid-template-columns: 16.5rem minmax(0, 1fr);
	}
}

.chat-sidebar {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	min-block-size: 0;
	padding: var(--space-3);
	overflow-y: auto;
	border-inline-end: 1px solid var(--border-subtle);
	background: var(--surface-sunken);

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
}

.sidebar-footer {
	margin-block-start: auto;
	padding-block-start: var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.session-note {
	margin: 0 0 var(--space-2);
	line-height: var(--leading-normal);
}

.system-prompt {
	summary {
		color: var(--text-secondary);
	}

	pre {
		max-block-size: 12rem;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
}

.history-backdrop {
	display: none;
}

.chat-main {
	position: relative;
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
	min-block-size: 0;
}

summary {
	border-radius: var(--radius-sm);
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

.chat-error,
.setup-note {
	flex-shrink: 0;
	margin: var(--space-2) var(--column-inset) 0;
}

.setup-note {
	padding: var(--space-2) var(--space-3);
	border-radius: var(--radius-md);
	background: var(--tint-info);
	font-size: var(--text-sm);
}

// Context, archive, storage and compaction as one row of chips; an opened chip expands below.
.conversation-status {
	display: flex;
	flex-shrink: 0;
	flex-wrap: wrap;
	align-items: flex-start;
	gap: var(--space-2);
	max-block-size: min(14rem, 30dvh);
	padding: var(--space-2) var(--column-inset) 0;
	overflow: auto;
}

.status-chip {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	min-inline-size: 0;
	max-inline-size: 100%;
	min-block-size: var(--control-height-sm);
	margin: 0;
	padding: 0 var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-size: var(--text-xs);

	svg {
		flex-shrink: 0;
		color: var(--text-tertiary);
	}

	> summary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-block-size: var(--control-height-sm);
		list-style: none;

		&::-webkit-details-marker {
			display: none;
		}

		&::after {
			content: '▾';
			color: var(--text-tertiary);
		}
	}

	&[open] {
		display: block;
		flex-basis: 100%;
		padding: 0 var(--space-3) var(--space-2);
		border-radius: var(--radius-md);

		> summary::after {
			content: '▴';
		}
	}

	p {
		margin-block: var(--space-1);
		line-height: var(--leading-normal);
	}
}

.archived-notice span {
	min-inline-size: 0;
}

.chip-action {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--link);
	font: inherit;
	font-weight: var(--weight-semibold);
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

.chip-note {
	color: var(--text-tertiary);
}

.summary-text {
	color: var(--text-primary);
	white-space: pre-wrap;
}

.compact-progress {
	display: flex;
	flex-shrink: 0;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	max-block-size: min(12rem, 30dvh);
	margin: var(--space-2) var(--column-inset) 0;
	padding: var(--space-2) var(--space-3);
	overflow: auto;
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--primary);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	font-size: var(--text-sm);

	&.has-error {
		border-inline-start-color: var(--danger);
		background: var(--tint-danger);
	}

	p {
		margin: 0;
		color: var(--text-secondary);
	}

	progress {
		inline-size: 6rem;
		block-size: .3rem;
	}

	details {
		flex-basis: 100%;
	}

	pre {
		max-block-size: 8rem;
		overflow: auto;
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
}

.compact-actions {
	display: flex;
	gap: var(--space-3);
	margin-inline-start: auto;
}

.text-button {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--link);
	font: inherit;
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

// Thread
.conversation {
	flex: 1;
	min-block-size: 0;
	padding: var(--space-5) var(--column-inset);
	overflow-y: auto;
	overscroll-behavior: contain;
	scrollbar-gutter: stable;
	scroll-padding-block-end: var(--space-8);

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
}

// Composer
.composer-dock {
	position: relative;
	display: flex;
	flex-direction: column;
	min-block-size: 0;
	padding: var(--space-2) var(--column-inset) var(--space-4);
}

// Anchored to the composer's top edge, so a taller composer never covers it.
.jump-latest {
	position: absolute;
	inset-block-end: calc(100% + var(--space-2));
	inset-inline: 0;
	inline-size: fit-content;
	margin-inline: auto;
	border-radius: var(--radius-full);
	box-shadow: var(--elevation-2);
}

.paused-notice {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	margin: 0 0 var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-md);
	background: var(--tint-warning);
	color: var(--text-primary);
	font-size: var(--text-sm);

	span {
		flex: 1 1 14rem;
	}
}

// Information, not a problem: the send waits for the other conversation.
.running-elsewhere {
	border-inline-start-color: var(--info);
	background: var(--tint-info);
}

.composer-load-error {
	margin-block-end: var(--space-2);
}

// Static on purpose: a placeholder for the turns, without motion.
.thread-skeleton {
	display: grid;
	gap: var(--space-4);
}

.skeleton-bubble {
	display: block;
	inline-size: 100%;
	block-size: 4.5rem;
	border-radius: var(--radius-lg);
	background: var(--surface-active);

	&.is-request {
		justify-self: end;
		inline-size: min(60%, 24rem);
		block-size: 2.5rem;
	}

	&.is-short {
		inline-size: 70%;
		block-size: 2.5rem;
	}
}

.composer {
	position: relative;
	display: flex;
	flex-direction: column;
	min-block-size: 0;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	// The textarea has no ring of its own, so the composer frame carries keyboard focus.
	&:focus-within {
		border-color: var(--focus-ring-color);
	}

	// Focused itself only as the neutral place focus returns to on touch screens; the border above shows it.
	&:focus {
		outline: none;
	}

	&:has(.textarea:focus-visible) {
		@include focus-ring;
	}

	&.is-drop-target {
		border-style: dashed;
		border-color: var(--border-strong);
		background-image: linear-gradient(var(--tint-info), var(--tint-info));
	}
}

.drop-hint {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	margin: 0;
	border-radius: inherit;
	background: var(--surface-raised);
	color: var(--accent-text);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	opacity: .92;
	pointer-events: none;
}

.hidden-input {
	display: none;
}

.composer .textarea {
	min-block-size: 2.75rem;
	max-block-size: 180px;
	padding: var(--space-1) var(--space-1) var(--space-2);
	border: 0;
	border-radius: 0;
	box-shadow: none;
	background: transparent;
	color: var(--text-primary);
	font-size: var(--text-base);
	line-height: var(--leading-normal);
	resize: none;

	&::placeholder {
		color: var(--text-tertiary);
	}
}

.chat-attachment-grid {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.draft-files {
	max-block-size: 180px;
	margin-block-end: var(--space-2);
	overflow: auto;
}

.attachment-input-hint {
	margin-block: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.composer-warning {
	margin-block: var(--space-1);
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);
	background: var(--tint-warning);
	color: var(--text-primary);
	font-size: var(--text-sm);
}

.composer-tools {
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
	gap: var(--space-2);
}

.composer-context {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
}

.composer-context .toolbar-button {
	min-inline-size: var(--control-height-sm);
	min-block-size: var(--control-height-sm);
}

// Scenario, model and search share one select-chip affordance.
.composer-chip {
	position: relative;
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: 13rem;
	min-block-size: var(--control-height-sm);
	padding-inline: var(--space-2) var(--space-1);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-within {
		@include focus-ring;
	}

	select {
		min-inline-size: 0;
		max-inline-size: 100%;
		padding: 0 1.1rem 0 0;
		border: 0;
		outline: none;
		appearance: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-overflow: ellipsis;
		cursor: pointer;

		&:disabled {
			opacity: .6;
			cursor: not-allowed;
		}
	}

	option {
		background: var(--surface-raised);
		color: var(--text-primary);
	}
}

.chip-chevron {
	position: absolute;
	inset-inline-end: var(--space-2);
	inline-size: .6rem;
	block-size: .6rem;
	color: var(--text-tertiary);
	pointer-events: none;
}

.chip-icon {
	flex-shrink: 0;
	inline-size: .85rem;
	color: var(--text-tertiary);
}

.search-label {
	white-space: nowrap;
}

.search-setup {
	font-size: var(--text-sm);
}

.composer-actions {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-2);
	margin-inline-start: auto;
}

// With the labelled steer button the actions take their own row when the chips leave no room beside them.
.composer-tools.is-steering {
	flex-wrap: wrap;
	row-gap: var(--space-2);
}

.composer .send {
	flex-shrink: 0;
	inline-size: 2.25rem;
	block-size: 2.25rem;
	padding: 0;
	border-radius: var(--radius-full);
}

.composer-steer {
	flex-shrink: 0;
	block-size: 2.25rem;
	padding-inline: var(--space-3);
	border-radius: var(--radius-full);
	white-space: nowrap;
}

.composer-hint {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-1);
	margin: var(--space-2) 0 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);

	&.is-write .mode-icon {
		color: var(--warning);
	}

	&.is-steering .mode-icon {
		color: var(--accent-text);
	}
}

.mode-icon {
	inline-size: .75rem;
}

.notice {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: var(--space-2) 0 0;
	padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-sm);

	span {
		flex: 1;
		padding-block: var(--space-1);
	}

	&.notice-info {
		border-inline-start-color: var(--primary);
		background: var(--tint-info);
	}
}

.steer-failure-body {
	display: grid;
	flex: 1;
	gap: var(--space-1);
	min-inline-size: 0;
	padding-block: var(--space-1);

	span {
		padding-block: 0;
	}
}

.steer-failure-text {
	max-block-size: 6rem;
	overflow: auto;
	color: var(--text-secondary);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.steer-retry {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--control-height-sm);
	margin-block: var(--space-1);
	padding-inline: var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-sm);
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-sm);
	white-space: nowrap;
	cursor: pointer;

	&:hover {
		background: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}

	&[aria-disabled='true'] {
		opacity: .5;
		cursor: not-allowed;
	}

	svg {
		inline-size: .8em;
	}
}

.notice-dismiss {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height-sm);
	block-size: var(--control-height-sm);
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	cursor: pointer;

	&:hover {
		background: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.original-transcript {
	margin-block-start: var(--space-2);
	font-size: var(--text-sm);
}

.original {
	max-block-size: 8rem;
	overflow: auto;
	white-space: pre-wrap;
}

// Rename and delete confirmations
.history-dialog {
	inline-size: min(27.5rem, 100%);
	text-align: start;

	h2 {
		margin-block-end: var(--space-3);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	p {
		line-height: var(--leading-normal);
		overflow-wrap: anywhere;
	}

	label {
		display: grid;
		gap: var(--space-2);
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}
}

.history-delete-title {
	margin-block-end: var(--space-2);
	font-weight: var(--weight-semibold);
}

.history-dialog-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-2);
	margin-block-start: var(--space-5);
}

:global(.history-action-modal.modal-dialog) {
	background: var(--scrim);
}

:global(.history-action-modal .modal-content) {
	position: absolute !important;
	inset-block-start: 50%;
	inset-inline-start: 50%;
	inline-size: min(28.75rem, calc(100vw - 2rem));
	max-block-size: calc(100dvh - 2rem) !important;
	padding: var(--space-5);
	overflow: auto !important;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	transform: translate(-50%, -50%) !important;
}

:global(.history-action-modal .close) {
	display: none;
}

.has-overlay-history {
	.chat-shell.with-history {
		grid-template-columns: minmax(0, 1fr);
	}

	.chat-sidebar {
		position: absolute;
		inset: 0 auto 0 0;
		z-index: var(--layer-dropdown);
		inline-size: min(18.75rem, 88%);
		border-inline-end-color: var(--border-default);
		background: var(--surface-raised);
		box-shadow: var(--elevation-3);
	}

	.history-backdrop {
		display: block;
		position: absolute;
		inset: 0;
		z-index: var(--layer-sticky);
		border: 0;
		background: var(--scrim);
	}
}

@media (width <= 800px) {
	.tcy-assistant {
		--column-gutter: var(--space-4);
	}

	.live-separator,
	.background-note {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.conversation {
		padding-block: var(--space-4);
	}

	.composer-dock {
		padding-block-end: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
	}
}

@media (width <= 540px) {
	.tcy-assistant {
		--column-gutter: var(--space-3);
	}

	.assistant-heading {
		gap: var(--space-1);
		padding-inline: var(--space-2);
	}

	// Narrow screens: the title stays for screen readers and the live status becomes a dot on the avatar.
	h1,
	.live-label,
	.live-separator,
	.background-note,
	.search-label {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.assistant-identity {
		gap: 0;
	}

	.live-connection {
		position: absolute;
		inset-block-end: -.1rem;
		inset-inline-start: 1.1rem;
	}

	.live-dot {
		inline-size: .6rem;
		block-size: .6rem;
		box-shadow: 0 0 0 2px var(--surface);
	}

	.conversation-toolbar {
		justify-content: flex-start;
	}

	.composer-chip {
		max-inline-size: 9rem;
	}

	.draft-files :deep(.chat-file) {
		inline-size: 8.75rem;
	}
}

@media (height <= 600px) {
	.composer .textarea {
		max-block-size: min(180px, 30dvh);
	}

	.conversation {
		padding-block: var(--space-1);
	}

	.conversation-status {
		max-block-size: 5rem;
	}

	.setup-note {
		max-block-size: 3rem;
		overflow: auto;
	}
}

@media (pointer: coarse) {
	.toolbar-button {
		min-inline-size: var(--target-min);
		min-block-size: var(--target-min);
	}

	.enter-hint {
		display: none;
	}

	.steer-retry {
		min-block-size: var(--target-min);
	}
}

.is-embedded {
	--column-gutter: var(--space-3);

	.assistant-heading {
		min-block-size: 2.75rem;
		padding: var(--space-1) var(--space-2);
	}

	.live-label,
	.live-separator,
	.background-note,
	.search-label {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.assistant-identity {
		gap: 0;
	}

	.live-connection {
		position: absolute;
		inset-block-end: -.1rem;
		inset-inline-start: 1.1rem;
	}

	.live-dot {
		inline-size: .6rem;
		block-size: .6rem;
		box-shadow: 0 0 0 2px var(--surface);
	}

	.conversation-toolbar {
		justify-content: flex-start;
	}

	.conversation {
		padding-block: var(--space-3);
	}

	.composer-dock {
		padding-block-end: var(--space-2);
	}

	.composer-chip {
		max-inline-size: 9rem;
	}

	// The panel's controls share the header row, so on narrow screens the conversation title takes a second row.
	@media (width <= 540px) {
		.assistant-heading {
			flex-wrap: wrap;
			row-gap: 0;
		}

		.heading-start {
			flex: 1 1 0;
		}

		.conversation-toolbar {
			order: 1;
			flex-basis: 100%;
		}
	}
}
</style>
