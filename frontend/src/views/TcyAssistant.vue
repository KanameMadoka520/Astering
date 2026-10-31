<script setup lang="ts">
import {computed, onMounted, onBeforeUnmount, ref, watch, nextTick, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter} from 'vue-router'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {useMediaQuery} from '@vueuse/core'
import {audioChatFile} from '@/helpers/tcyAudio'
import {useConversationEvents} from '@/client/queries/conversationEvents'
import {aiSettingsQuery, useCleanupAI, useTranscribeAI} from '@/client/queries/tcyAi'
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
import ChatTurnCard from '@/components/ai/ChatTurnCard.vue'
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
	useAgentReceiptRefresh,
	useCreateConversation,
	useConversationAction,
	useSendConversation,
	useReviewConversation,
} from '@/client/queries/tcyConversations'
import {useProjects} from '@/composables/useProjects'
import {useTitle} from '@/composables/useTitle'
import type {ChatTurn, ReviewInput, ConversationSummary} from '@/client/generated'
import {openDiagnostics, openCompactDiagnostic} from '@/helpers/diagnostics'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'

const props = withDefaults(defineProps<{
	embedded?: boolean,
	conversationId?: string,
	contextProjectId?: number,
	contextTaskId?: number,
}>(), {
	embedded: false,
	conversationId: '',
	contextProjectId: 0,
	contextTaskId: 0,
})
const emit = defineEmits<{
	'update:conversationId': [id: string],
	activity: [running: boolean],
	navigationBusy: [busy: boolean],
}>()
const {t} = useI18n({useScope: 'global'})

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
const events = useConversationEvents(chatID)
// Polls only a running or compacting conversation, and only while the event stream is not live.
const current = useQuery(computed(() => conversationQuery(chatID.value, events.connected.value)))
const active = computed(() => current.data.value)
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
const canCompact = computed(() => (active.value?.turns?.length ?? 0) > (active.value?.compactions?.at(-1)?.through ?? 0))
const activeRun = computed(() => Boolean(active.value?.compacting || active.value?.turns?.some(turn => turn.status === 'running')))
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
const draftFiles = computed(() => active.value?.draft_attachments ?? [])
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
const stickToBottom = ref(true)
const drafts = new Map<string, string>()
const transcribe = useTranscribeAI()
const cleanup = useCleanupAI()
const prompt = ref('')
const mode = ref<'read' | 'write'>('read')
const allowDelete = ref(false)
const approval = ref<'smart' | 'review' | 'auto'>('smart')
const writeProjectIDs = ref<number[]>([])
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
	applyOptions(options, id)
}
function optionsStorageKey(id: string) {
	const context = captureClientRequestContext()
	return `tcy-ai-options:${JSON.stringify([context.apiBaseUrl, context.identity, id])}`
}
function saveOptions(id: string, options: AssistantOptions, profile: string) {
	try { sessionStorage.setItem(optionsStorageKey(id), JSON.stringify({options, profile})) } catch { /* The server still retains sent configurations. */ }
}
watch([() => preferences.data.value, active, chatID], ([value, conversation, id]) => {
	if (!value || initializedChat.value === id || (id && conversation?.id !== id)) return
	let saved: {options: AssistantOptions, profile: string} | undefined
	try {
		const candidate = JSON.parse(sessionStorage.getItem(optionsStorageKey(id)) || 'null')
		// Normalized so options stored before newer switches existed still restore them as off.
		if (candidate && validOptions(candidate.options) && ['read', 'write'].includes(candidate.options.mode)) saved = {options: normalizeOptions(candidate.options), profile: candidate.profile}
	} catch { /* Ignore unavailable or obsolete browser preferences. */ }
	const last = conversation?.turns?.at(-1)?.result?.configuration
	const defaultID = value.default_profile || 'ask'
	const custom = value.profiles?.find(p => p.id === defaultID)
	const options = saved?.options ?? (last ? normalizeOptions(last) : custom ? normalizeOptions(custom.options) : profileOptions(defaultID))
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
const voiceOpen = ref(false)
const effectivePrompt = useQuery(computed(() => promptQuery(projectID.value, mode.value, allowDelete.value, showSystemPrompt.value)))
const tidy = ref(true)
const original = ref('')
const audioInput = ref<HTMLInputElement>()
const recording = ref(false)
const audioStage = ref('')
const elapsed = ref(0)
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
	|| recording.value)
const busy = computed(() => !optionsReady.value || editingBusy.value || activeRun.value || Boolean(paused.value))
watch([activeRun, editingBusy], ([running, editing]) => {
	emit('activity', running || editing)
	emit('navigationBusy', editing)
}, {immediate: true})
const hasAssistant = computed(() => chatModels.value.some(c => c.id === selectedConnection.value))
const needsSetup = computed(() => !hasAssistant.value && !settings.isPending.value)
const liveStatus = computed(() => t(events.connected.value ? 'flow.liveConnected' : 'flow.reconnecting'))
const hasSpeech = computed(() => Boolean(settings.data.value?.transcription))
const nextProjectTitle = computed(() => projectID.value
	? projectList.projectsArray.find(p => p.id === projectID.value)?.title || `#${projectID.value}`
	: '')
let recorder: MediaRecorder | undefined
let stream: MediaStream | undefined
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false

// Only turns appended to the open conversation fade in; opening or switching a chat renders at once.
const revealTurns = ref(false)
let revealFrame = 0
watch(chatID, () => { revealTurns.value = false })
watch([chatID, () => !chatID.value || active.value?.id === chatID.value], ([, ready]) => {
	cancelAnimationFrame(revealFrame)
	if (ready) revealFrame = requestAnimationFrame(() => { revealTurns.value = true })
}, {immediate: true, flush: 'post'})
onBeforeUnmount(() => cancelAnimationFrame(revealFrame))

async function selectConversation(id: string) {
	if (editingBusy.value) return
	drafts.set(chatID.value, prompt.value)
	await navigateConversation(id)
	prompt.value = drafts.get(id) ?? ''
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
		if (chatID.value === target && !prompt.value) {
			drafts.delete(target)
			original.value = ''
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
	} catch { return }
}

const currentSummary = computed<ConversationSummary>(() => ({...active.value, running: activeRun.value}))
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
	try {
		await action.mutateAsync({id, action: target.kind, title: newTitle.value.trim()})
		if (historyDialog.value === target) historyDialog.value = undefined
		if (target.kind === 'delete') {
			drafts.delete(id)
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

function composerKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
		event.preventDefault()
		void submit()
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
watch([visibleTurns, () => active.value?.turns?.at(-1)?.result], followOutput, {flush: 'post'})
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

async function processAudio(file: Blob, filename: string) {
	if (file.size > 16 * 1024 * 1024) {
		showNotice(t('tcymc.text.audio_must_not_exceed_16_mib'))
		return
	}
	if (!file.size) {
		showNotice(t('tcymc.text.the_recording_is_empty_please_try_again'))
		return
	}
	dismissNotice()
	audioStage.value = 'preparing'
	const connection = settings.data.value?.connections.find(c => c.id === settings.data.value?.transcription)
	if (connection?.protocol === 'openai-audio') {
		try {
			audioStage.value = 'audioConverting'
			const converted = await audioChatFile(file, filename)
			file = converted.file
			filename = converted.filename
		} catch {
			audioStage.value = ''
			showNotice(t('tcymc.audioConversionFailed'))
			return
		}
	}
	try {
		const audio = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(String(reader.result).split(',')[1])
			reader.onerror = reject
			reader.readAsDataURL(file)
		})
		audioStage.value = 'audioProcessing'
		const result = await transcribe.mutateAsync({audio, filename, cleanup: tidy.value})
		if (disposed) return
		original.value = result.original ?? ''
		prompt.value = [prompt.value, result.text].filter(Boolean).join('\n')
		if (result.warning) showNotice(result.warning)
		else showNotice(t('tcymc.text.transcription_complete_edit_the_text_if_needed_then'), 'info')
	} catch (e) {
		if (isRequestContextAbort(e)) return
		showNotice(t('tcymc.text.speech_recognition_failed_check_the_model_settings_or'))
	} finally { audioStage.value = '' }
}

function stopTracks() {
	stream?.getTracks().forEach(track => track.stop())
	if (timer) clearInterval(timer)
}

async function toggleRecording() {
	if (busy.value && !recording.value) return
	if (!hasSpeech.value) return
	if (recording.value) {
		recorder?.stop()
		return
	}
	if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
		showNotice(t('tcymc.text.this_browser_cannot_record_audio_please_upload_an'))
		return
	}
	try {
		stream = await navigator.mediaDevices.getUserMedia({audio: true})
		if (disposed) {
			stopTracks()
			return
		}
		const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type))
		recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined)
		const chunks: Blob[] = []
		recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
		recorder.onstop = () => {
			recording.value = false
			stopTracks()
			const name = mimeType?.includes('mp4') ? 'recording.m4a' : 'recording.webm'
			if (!disposed) void processAudio(new Blob(chunks, {type: recorder?.mimeType}), name)
		}
		recorder.onerror = () => {
			recording.value = false
			stopTracks()
			showNotice(t('tcymc.text.recording_was_interrupted_please_try_again'))
		}
		recorder.start(1000)
		recording.value = true
		elapsed.value = 0
		timer = setInterval(() => {
			elapsed.value++
			if (elapsed.value >= 180 && recorder?.state === 'recording') recorder.stop()
		}, 1000)
	} catch {
		stopTracks()
		showNotice(t('tcymc.text.cannot_access_the_microphone_check_your_browser_s'))
	}
}

async function upload(event: Event) {
	const input = event.target as HTMLInputElement
	const file = input.files?.[0]
	if (file) await processAudio(file, file.name)
	input.value = ''
}

async function tidyText() {
	if (busy.value || !prompt.value.trim() || !settings.data.value?.cleanup) return
	try {
		const result = await cleanup.mutateAsync(prompt.value)
		original.value = result.original ?? ''
		prompt.value = result.text ?? ''
	} catch { return }
}

onBeforeUnmount(() => {
	disposed = true
	if (recorder?.state === 'recording') recorder.stop()
	stopTracks()
})
</script>

<template>
	<div
		class="tcy-assistant"
		:class="{
			'is-embedded': embedded,
			'has-overlay-history': historyOverlay,
		}"
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
						<template v-else-if="!active">
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
								>{{ t(events.connected.value ? 'assistantUI.statusLive' : 'assistantUI.statusPolling') }}</span>
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
				v-if="active"
				class="conversation-toolbar"
			>
				<strong
					class="conversation-title"
					:title="active.title || t('chat.untitled')"
				>{{ active.title || t('chat.untitled') }}</strong>
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
					v-if="chatID && current.isError.value && !active"
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
						v-if="active?.archived"
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
						v-if="active?.storage"
						class="status-chip conversation-storage"
					>
						<summary>{{ t('chatFiles.storageLine', {bytes: chatBytes(active.storage.total_bytes), count: active.storage.attachment_count}) }}</summary>
						<p>{{ t('chatFiles.storageDetail', {record: chatBytes(active.storage.record_bytes), files: chatBytes(active.storage.attachment_bytes)}) }}</p>
						<p>{{ t('chatFiles.storageHint') }}</p>
						<p v-if="active.storage.drive_attachment_count">
							{{ t('chatFiles.storageDrive', {count: active.storage.drive_attachment_count, bytes: chatBytes(active.storage.drive_attachment_bytes)}) }}
						</p>
						<p v-if="active.storage.missing_count">
							{{ t('chatFiles.missingCount', {count: active.storage.missing_count}) }}
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
					v-if="active?.compacting || active?.compact_error || active?.compact_progress"
					class="compact-progress"
					:class="{'has-error': Boolean(active.compact_error)}"
					role="status"
				>
					<strong>{{ active.compacting ? t('flow.compacting') : active.compact_error ? t('flow.compactFailed') : t('flow.compactDone') }}</strong>
					<p v-if="active.compact_progress">
						{{ t('flow.compactBatch', {batch: active.compact_progress.batch, total: active.compact_progress.batches, attempt: active.compact_progress.attempt}) }}
						· {{ t('chat.totalTokens') }}: {{ active.compact_progress.usage?.reported ? (active.compact_progress.usage.input ?? 0) + (active.compact_progress.usage.output ?? 0) : t('chat.unavailable') }}
						· {{ t('chat.seconds', {value: ((active.compact_progress.duration_ms ?? 0) / 1000).toFixed(1)}) }}
					</p>
					<progress
						v-if="active.compacting"
						:aria-label="t('flow.compacting')"
					/>
					<p v-if="active.compact_error">
						{{ active.compact_error }}
					</p>
					<details v-if="active.compacting && active.compact_text">
						<summary>{{ t('flow.compactDraft') }}</summary>
						<pre>{{ active.compact_text }}</pre>
					</details>
					<div class="compact-actions">
						<button
							v-if="active.compact_error && !busy && canCompact"
							type="button"
							class="text-button"
							@click="manage('compact')"
						>
							{{ t('flow.compactRetry') }}
						</button>
						<button
							type="button"
							class="text-button"
							@click="openCompactDiagnostic(active)"
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
					<AronaWelcome
						v-if="!visibleTurns.length"
						:needs-setup="needsSetup"
						:disabled="!optionsReady"
						@choose="applySuggestion"
					/>
					<!-- Observed for size changes; unstyled, so the turns lay out as before. -->
					<div
						ref="threadContent"
						class="conversation-content"
					>
						<TransitionGroup
							name="message-reveal"
							:css="revealTurns"
						>
							<ChatTurnCard
								v-for="turn in visibleTurns"
								:key="turn.request_id || turn.id"
								:turn="turn"
								:sending="turn === pendingMessage?.turn"
								:conversation-id="chatID"
								:busy="busy"
								:review-busy="review.isPending.value || action.isPending.value"
								@review="reviewOperation"
								@fork="manage('fork', $event)"
							/>
						</TransitionGroup>
					</div>
				</div>
				<div
					v-if="needsSetup && visibleTurns.length"
					class="setup-note"
				>
					<RouterLink to="/user/settings/ai">
						{{ t('tcymc.text.add_a_connection_in_ai_and_voice_settings') }}
					</RouterLink>
				</div>
				<div class="composer-dock">
					<XButton
						v-if="!stickToBottom && active?.turns?.length"
						class="jump-latest is-small"
						variant="secondary"
						icon="arrow-down"
						:shadow="false"
						@click="jumpToLatest"
					>
						{{ t('flow.jumpLatest') }}
					</XButton>
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
						:class="{'is-drop-target': dragging}"
						@dragenter="dragEnter"
						@dragover.prevent
						@dragleave="dragLeave"
						@drop.prevent="dropFiles"
						@paste="pasteFiles"
						@submit.prevent="submit"
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
							{{ t('chatFiles.fileInputHint') }}
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
							maxlength="12000"
							:placeholder="t('assistantUI.placeholder')"
							@keydown="composerKeydown"
						/>
						<div
							v-if="voiceOpen"
							class="voice-tools"
						>
							<XButton
								variant="secondary"
								type="button"
								class="is-small"
								:shadow="false"
								:icon="recording ? 'stop' : 'microphone'"
								:aria-disabled="(busy && !recording) || !hasSpeech"
								@click="toggleRecording"
							>
								{{ recording ? t('tcymc.stopRecording', {seconds: elapsed}) : t('tcymc.text.record_audio') }}
							</XButton><XButton
								variant="secondary"
								class="is-small"
								icon="cloud-upload-alt"
								:shadow="false"
								:aria-disabled="busy || !hasSpeech"
								@click="!busy && hasSpeech && audioInput?.click()"
							>
								{{ t('tcymc.text.upload_audio') }}
							</XButton><input
								ref="audioInput"
								class="hidden-input"
								type="file"
								accept="audio/*"
								@change="upload"
							><label class="checkbox"><input
								v-model="tidy"
								type="checkbox"
							>{{ t('tcymc.text.clean_up_the_transcript') }}</label><XButton
								variant="secondary"
								class="is-small"
								:shadow="false"
								:aria-disabled="busy || !prompt.trim() || !settings.data.value?.cleanup"
								@click="tidyText"
							>
								{{ t('tcymc.text.clean_up_text') }}
							</XButton>
						</div>
						<p
							v-if="audioStage || cleanup.isPending.value"
							class="audio-progress"
							role="status"
						>
							<progress :aria-label="t(`flow.${audioStage || 'audioProcessing'}`)" /> {{ t(`flow.${audioStage || 'audioProcessing'}`) }}
						</p>
						<div
							class="composer-tools"
							data-tour="ai-voice"
						>
							<div class="composer-context">
								<AttachMenu
									:disabled="busy"
									@device="fileInput?.click()"
									@drive="driveOpen = true"
								/>
								<BaseButton
									class="toolbar-button"
									:title="recording ? t('tcymc.stopRecording', {seconds: elapsed}) : t('assistantUI.voiceTools')"
									:aria-label="recording ? t('tcymc.stopRecording', {seconds: elapsed}) : t('assistantUI.voiceTools')"
									:aria-expanded="voiceOpen"
									:class="{'is-recording': recording}"
									@click="recording ? toggleRecording() : (voiceOpen = !voiceOpen)"
								>
									<Icon :icon="recording ? 'stop' : 'microphone'" />
								</BaseButton>
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
							<XButton
								v-if="activeRun"
								variant="primary"
								icon="stop"
								class="send"
								icon-only
								:aria-disabled="action.isPending.value"
								@click="manage('stop')"
							>
								<span class="is-sr-only">{{ t('chat.stop') }}</span>
							</XButton><XButton
								v-else
								variant="primary"
								icon="arrow-up"
								class="send"
								icon-only
								type="submit"
								:aria-disabled="busy || !hasAssistant || (!prompt.trim() && !draftFiles.length) || imageMismatch"
							>
								<span class="is-sr-only">{{ send.isPending.value ? t('chat.sending') : t('tcymc.text.send_request') }}</span>
							</XButton>
						</div>
						<p
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

	&.is-recording {
		background: var(--tint-danger);
		color: var(--danger-text);
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

.message-reveal-enter-active {
	transition:
		opacity var(--motion-base) var(--ease-enter),
		transform var(--motion-base) var(--ease-enter);
}

.message-reveal-enter-from {
	opacity: 0;
	transform: translateY(var(--space-1));
}

// Composer
.composer-dock {
	position: relative;
	flex-shrink: 0;
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

.composer {
	position: relative;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	// The textarea has no ring of its own, so the composer frame carries keyboard focus.
	&:focus-within {
		border-color: var(--focus-ring-color);
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

.composer .send {
	flex-shrink: 0;
	inline-size: 2.25rem;
	block-size: 2.25rem;
	padding: 0;
	border-radius: var(--radius-full);
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
}

.mode-icon {
	inline-size: .75rem;
}

.voice-tools {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin-block-end: var(--space-2);
	padding-block: var(--space-2);
	border-block-end: 1px solid var(--border-subtle);
	font-size: var(--text-sm);
}

.audio-progress {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	progress {
		inline-size: 4rem;
		block-size: .3rem;
	}
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
}

@media (prefers-reduced-motion: reduce) {
	.message-reveal-enter-active {
		transition: none;
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
