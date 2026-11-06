<template>
	<div
		:class="{'d-print-none': isEmpty}"
	>
		<div class="task-section-header">
			<h2 class="task-section-title">
				<span class="icon is-grey">
					<Icon icon="align-left" />
				</span>
				{{ $t('task.attributes.description') }}
				<CustomTransition name="fade">
					<span
						v-if="saveState === 'saving'"
						class="is-small is-inline-flex"
						aria-hidden="true"
					>
						<span class="loader is-inline-block" />
						{{ $t('misc.saving') }}
					</span>
					<span
						v-else-if="saveState === 'saved'"
						class="is-small has-text-success"
						aria-hidden="true"
					>
						<Icon icon="check" />
						{{ $t('misc.saved') }}
					</span>
				</CustomTransition>
			</h2>
			<div
				v-if="stageCount > 0 || canWrite"
				class="task-section-actions description-view-actions d-print-none"
			>
				<XButton
					v-if="stageCount > 0"
					variant="tertiary"
					class="is-small"
					icon="list-check"
					:aria-pressed="showStages"
					@click="showStages = !showStages"
				>
					{{ showStages ? t('stages.fullDescription') : t('stages.title') }}
				</XButton>
				<XButton
					v-if="canWrite"
					variant="tertiary"
					class="is-small"
					icon="plus"
					:aria-disabled="saving || undefined"
					@click="insertStageTemplate"
				>
					{{ t('stages.insertTemplate') }}
				</XButton>
			</div>
		</div>
		<!-- Outside the h2 so the heading keeps a stable accessible name -->
		<span
			class="is-sr-only"
			role="status"
			aria-live="polite"
		>{{ saveStateAnnouncement }}</span>
		<p
			v-if="saveError"
			role="alert"
			class="description-save-error"
		>
			{{ saveError }}
			<XButton
				v-if="canWrite"
				variant="secondary"
				class="is-small"
				:shadow="false"
				:aria-disabled="saving || undefined"
				@click="save"
			>
				{{ t('stages.retry') }}
			</XButton>
		</p>
		<Message
			v-if="storedDraft !== null && canWrite"
			class="description-stored-draft"
		>
			<div class="description-stored-draft__body">
				<p>{{ t('task.description.draftFound') }}</p>
				<div class="description-stored-draft__actions">
					<XButton
						variant="secondary"
						class="is-small"
						:shadow="false"
						:aria-disabled="saving || undefined"
						@click="restoreStoredDraft"
					>
						{{ t('task.description.restoreDraft') }}
					</XButton>
					<XButton
						variant="tertiary"
						class="is-small"
						:shadow="false"
						@click="discardStoredDraft"
					>
						{{ t('task.description.discardDraft') }}
					</XButton>
				</div>
			</div>
		</Message>
		<DescriptionStages
			v-if="showStages && stageCount > 0"
			:model-value="description"
			:can-write="canWrite"
			:saving="saving"
			@update:modelValue="saveStageChange"
		/>
		<Editor
			v-show="!showStages || stageCount === 0"
			v-model="description"
			class="tiptap__task-description"
			:is-edit-enabled="canWrite"
			:upload-callback="uploadCallback"
			:drive-task-id="modelValue.id"
			:placeholder="$t('task.description.placeholder')"
			:show-save="true"
			edit-shortcut="KeyE"
			:enable-discard-shortcut="true"
			:enable-mentions="true"
			:project-id="modelValue.project_id"
			:storage-key="descriptionStorageKey"
			@update:modelValue="onEditorInput"
			@save="save"
			@discard="discardChanges"
		/>
		<Modal
			v-if="leaveAttempt"
			:aria-label="t('task.description.leaveTitle')"
			:aria-describedby="leaveBodyId"
			:loading="leaving"
			@close="stayOnTask"
			@opened="focusStay"
		>
			<Card
				:title="t('task.description.leaveTitle')"
				:shadow="false"
				class="description-leave-dialog has-text-start"
			>
				<p
					:id="leaveBodyId"
					ref="leaveBody"
				>
					{{ t('task.description.leaveText') }}
				</p>
				<p
					v-if="draftStorageFailed"
					role="alert"
				>
					{{ t('task.description.leaveStorageFailed') }}
				</p>
				<template #footer>
					<XButton
						variant="secondary"
						:danger="draftStorageFailed"
						:loading="leaving"
						:shadow="false"
						@click="keepDraftAndLeave"
					>
						{{ t(draftStorageFailed ? 'task.description.leaveAnyway' : 'task.description.keepAndLeave') }}
					</XButton>
					<XButton
						data-description-stay
						:aria-disabled="leaving || undefined"
						:shadow="false"
						@click="stayOnTask"
					>
						{{ t('task.description.stay') }}
					</XButton>
				</template>
			</Card>
		</Modal>
	</div>
</template>

<script setup lang="ts">
import DescriptionStages from './DescriptionStages.vue'
import {descriptionStages, stageTemplate} from '@/helpers/descriptionStages'
import {hasRemovedAttachmentImages, removeAttachmentImages} from '@/helpers/attachmentImages'
import {getErrorText, success} from '@/message'
import {
	ref,
	computed,
	watch,
	onBeforeUnmount,
	useId,
} from 'vue'
import {
	onBeforeRouteLeave,
	onBeforeRouteUpdate,
	useRouter,
	type RouteLocationNormalized,
} from 'vue-router'
import {useQueryClient} from '@tanstack/vue-query'
import {useEventListener} from '@vueuse/core'
import {useI18n} from 'vue-i18n'

import CustomTransition from '@/components/misc/CustomTransition.vue'
import XButton from '@/components/input/Button.vue'
import Editor from '@/components/input/AsyncEditor'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'
import Card from '@/components/misc/Card.vue'

import {clearEditorDraft, loadEditorDraft, saveEditorDraft, scopedEditorDraftKey} from '@/helpers/editorDraftStorage'
import {captureDraftLease, editorDraftNamespace, isDraftLeaseCurrent} from '@/helpers/draftScope'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'
import { isEditorContentEmpty } from '@/helpers/editorContentEmpty'
import {generateAttachmentUrl} from '@/helpers/attachments'
import type {Task as ITask} from '@/client/generated'
import {useUploadAttachmentsMutation} from '@/client/queries/attachments'
import {useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {isTaskDeleted} from '@/client/queries/taskCache'

const props = defineProps<{
	modelValue: ITask,
	canWrite: boolean,
}>()

const emit = defineEmits<{
	'update:modelValue': [value: ITask]
}>()

// The account and server this editor was opened for: its drafts are kept under them, and text typed here is never
// sent once another account or server took over (logout, login elsewhere in this tab).
const owner = captureClientRequestContext()
const draftNamespace = editorDraftNamespace(owner)
const draftLease = captureDraftLease(draftNamespace)
const router = useRouter()
type LeaveAttempt = {
	taskId: number,
	from: string,
	to: string,
}
const leaveAttempt = ref<LeaveAttempt | null>(null)
const leaving = ref(false)
const draftStorageFailed = ref(false)
const leaveBody = ref<HTMLElement | null>(null)
const leaveBodyId = useId()
let keptDeparture: LeaveAttempt | undefined
let navigationGeneration = 0

const description = ref<string>('')
const hasChanges = ref(false)
const saveError = ref('')
const saved = ref(false)
const saving = ref(false)
// An unsaved version of this description that this device still holds from an earlier visit.
const storedDraft = ref<string | null>(null)
const showStages = ref(false)
const stageCount = computed(() => descriptionStages(description.value).reduce((n, g) => n + g.items.length, 0))
watch(() => props.modelValue.id, () => { showStages.value = descriptionStages(props.modelValue.description ?? '').reduce((n, g) => n + g.items.length, 0) >= 12 }, {immediate: true})
async function saveStageChange(html: string) {
	if (!props.canWrite || saving.value) return
	description.value = html; hasChanges.value = true
	await save()
}
async function insertStageTemplate() {
	if (!props.canWrite || saving.value) return
	showStages.value = false
	await saveStageChange(description.value + stageTemplate(t))
}

watch(
	() => [props.modelValue.id, props.modelValue.description] as const,
	([id, value], previous) => {
		if (id === previous?.[0] && hasChanges.value) return
		const switched = previous !== undefined && id !== previous[0]
		// The view reuses this editor for the next task: what was typed for the one being left is sent, not dropped.
		if (switched && hasChanges.value && previous[0] !== undefined) {
			if (keptDeparture?.taskId === previous[0]) saveEditorDraft(storageKeyFor(previous[0]), description.value, draftLease)
			else void saveDeparting(previous[0], description.value)
		}
		if (switched) {
			keptDeparture = undefined
			leaveAttempt.value = null
		}
		description.value = value ?? ''
		hasChanges.value = false
		if (previous === undefined || switched) {
			saveError.value = ''
			saved.value = false
			checkStoredDraft()
		}
	},
	{immediate: true},
)

watch(() => ({id: props.modelValue.id, ids: (props.modelValue.attachments ?? []).map(a => a.id!)}), (current, previous) => {
	if (!previous || current.id !== previous.id) return
	const removed = previous.ids.filter(id => !current.ids.includes(id))
	description.value = removeAttachmentImages(description.value, current.id!, removed)
})

const queryClient = useQueryClient()
const updateTask = useUpdateTaskMutation(false, owner)

const {t} = useI18n({useScope: 'global'})

const changeTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
const savedTimeout = ref<ReturnType<typeof setTimeout> | null>(null)
const dwellTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

// Saves resolve faster than "Saving…" can be read, and aria-live coalesces it away, so hold it a floor.
const MIN_SAVING_DWELL = 500
const dwelling = ref(false)

watch(saving, isSaving => {
	if (!isSaving) {
		return
	}

	dwelling.value = true
	if (dwellTimeout.value !== null) {
		clearTimeout(dwellTimeout.value)
	}
	dwellTimeout.value = setTimeout(() => {
		dwelling.value = false
	}, MIN_SAVING_DWELL)
})

const saveState = computed(() => {
	if (saving.value || dwelling.value) {
		return 'saving'
	}

	if (saved.value) {
		return 'saved'
	}

	return ''
})

// Runs from when "Saved!" reaches the screen, not from the response the floor may have delayed.
watch(saveState, state => {
	if (savedTimeout.value !== null) {
		clearTimeout(savedTimeout.value)
	}

	if (state !== 'saved') {
		return
	}

	savedTimeout.value = setTimeout(() => {
		saved.value = false
	}, 2000)
})

const saveStateAnnouncement = computed(() => {
	if (saveState.value === 'saving') {
		return t('misc.saving')
	}

	if (saveState.value === 'saved') {
		return t('misc.saved')
	}

	return ''
})

function storageKeyFor(taskId: number | undefined) {
	return scopedEditorDraftKey(draftNamespace, `task-description-${taskId}`)
}

const descriptionStorageKey = computed(() => storageKeyFor(props.modelValue.id))

// An empty description gets the draft straight into the editor (TipTap); otherwise the writer decides.
function checkStoredDraft() {
	const key = storageKeyFor(props.modelValue.id)
	const draft = loadEditorDraft(key)
	const current = props.modelValue.description ?? ''
	if (draft !== null && draft === current) clearEditorDraft(key, draftLease)
	storedDraft.value = draft !== null && draft !== current && !isEditorContentEmpty(current)
		? draft
		: null
}

async function restoreStoredDraft() {
	const draft = storedDraft.value
	if (draft === null || saving.value) return
	storedDraft.value = null
	description.value = draft
	hasChanges.value = true
	await save()
}

function discardStoredDraft() {
	storedDraft.value = null
	clearEditorDraft(descriptionStorageKey.value, draftLease)
}

function onEditorInput() {
	// Typing replaces the stored draft on this device, so the offer to restore it no longer holds.
	storedDraft.value = null
	saveEditorDraft(descriptionStorageKey.value, description.value, draftLease)
	saveWithDelay()
}

// Esc in the editor: the text goes back to what the server has, and nothing typed since is sent.
function discardChanges() {
	if (changeTimeout.value !== null) clearTimeout(changeTimeout.value)
	description.value = props.modelValue.description ?? ''
	hasChanges.value = pendingSave !== undefined
	saveError.value = ''
	if (hasChanges.value) saveEditorDraft(descriptionStorageKey.value, description.value, draftLease)
	else clearEditorDraft(descriptionStorageKey.value, draftLease)
}

async function saveDeparting(taskId: number, text: string) {
	if (changeTimeout.value !== null) clearTimeout(changeTimeout.value)
	const key = storageKeyFor(taskId)
	if (isTaskDeleted(queryClient, taskId)) {
		clearEditorDraft(key, draftLease)
		return
	}
	// Kept on this device until the server has it; reopening the task offers it back.
	saveEditorDraft(key, text, draftLease)
	if (!isClientRequestContextCurrent(owner) || !isDraftLeaseCurrent(draftLease)) return
	try {
		if (pendingSave) await pendingSave
		if (!isClientRequestContextCurrent(owner) || !isDraftLeaseCurrent(draftLease)) return
		await updateTask.mutateAsync({id: taskId, description: text})
	} catch (error) {
		if ((error as {status?: number})?.status === 404) clearEditorDraft(key, draftLease)
		// The mutation reports the failure.
		return
	}
	clearEditorDraft(key, draftLease, text)
	if (props.modelValue.id === taskId) checkStoredDraft()
}

/** Sends unsaved description text now. 'none' when there was nothing to send. */
async function flush(): Promise<'none' | 'saved' | 'failed'> {
	if (!hasChanges.value && pendingSave === undefined) return 'none'
	return await save() ? 'saved' : 'failed'
}

defineExpose({flush})

const isEmpty = computed(() => isEditorContentEmpty(description.value))

async function saveWithDelay() {
	if (description.value === props.modelValue.description && pendingSave === undefined) {
		clearEditorDraft(descriptionStorageKey.value, draftLease, description.value)
		hasChanges.value = false
		if (changeTimeout.value !== null) {
			clearTimeout(changeTimeout.value)
		}
		return
	}

	hasChanges.value = true
	if (changeTimeout.value !== null) {
		clearTimeout(changeTimeout.value)
	}

	changeTimeout.value = setTimeout(async () => {
		await save()
	}, 5000)
}

onBeforeUnmount(() => {
	if (keptDeparture?.taskId === props.modelValue.id) saveEditorDraft(descriptionStorageKey.value, description.value, draftLease)
	else void save()
	if (changeTimeout.value !== null) {
		clearTimeout(changeTimeout.value)
	}
	if (savedTimeout.value !== null) {
		clearTimeout(savedTimeout.value)
	}
	if (dwellTimeout.value !== null) {
		clearTimeout(dwellTimeout.value)
	}
})

// Closing or reloading the tab inside the autosave delay: the browser asks, and the text is already kept on this
// device (the editor writes it on every change), so the next visit offers it back.
useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
	if (!hasChanges.value && !saving.value) return
	event.preventDefault()
})
// Phones often skip beforeunload; leaving the tab is the last reliable moment to send it.
useEventListener(document, 'visibilitychange', () => {
	if (document.visibilityState === 'hidden' && hasChanges.value) void save()
})

function currentLeaveAttempt(attempt: LeaveAttempt) {
	return props.modelValue.id === attempt.taskId && router.currentRoute.value.fullPath === attempt.from
		&& isClientRequestContextCurrent(owner) && isDraftLeaseCurrent(draftLease)
}

function stayOnTask() {
	if (leaving.value) return
	leaveAttempt.value = null
	draftStorageFailed.value = false
}

function focusStay() {
	leaveBody.value?.closest('.description-leave-dialog')?.querySelector<HTMLElement>('[data-description-stay]')?.focus()
}

async function keepDraftAndLeave() {
	const attempt = leaveAttempt.value
	if (!attempt || leaving.value) return
	if (!currentLeaveAttempt(attempt)) {
		stayOnTask()
		return
	}
	const key = storageKeyFor(attempt.taskId)
	saveEditorDraft(key, description.value, draftLease)
	if (loadEditorDraft(key) !== description.value && !draftStorageFailed.value) {
		draftStorageFailed.value = true
		return
	}
	if (changeTimeout.value !== null) clearTimeout(changeTimeout.value)
	leaving.value = true
	keptDeparture = attempt
	try {
		const failure = await router.push(attempt.to)
		if (failure) keptDeparture = undefined
		else if (leaveAttempt.value === attempt) leaveAttempt.value = null
	} catch (error) {
		keptDeparture = undefined
		if (currentLeaveAttempt(attempt)) saveError.value = getErrorText(error)
	} finally {
		leaving.value = false
	}
}

async function saveBeforeNavigation(to: RouteLocationNormalized, from: RouteLocationNormalized) {
	if (keptDeparture?.from === from.fullPath && keptDeparture.to === to.fullPath && currentLeaveAttempt(keptDeparture)) {
		return true
	}
	keptDeparture = undefined
	if (!isClientRequestContextCurrent(owner) || !isDraftLeaseCurrent(draftLease)) {
		leaveAttempt.value = null
		return true
	}
	const generation = ++navigationGeneration
	const taskId = props.modelValue.id!
	const ok = await save()
	if (generation !== navigationGeneration) return false
	if (!isClientRequestContextCurrent(owner) || !isDraftLeaseCurrent(draftLease)) return true
	if (props.modelValue.id !== taskId || router.currentRoute.value.fullPath !== from.fullPath) return false
	if (ok && !hasChanges.value) return true
	leaveAttempt.value = {
		taskId,
		from: from.fullPath,
		to: to.fullPath,
	}
	draftStorageFailed.value = false
	return false
}
onBeforeRouteLeave(saveBeforeNavigation)
// Opening another task in the same view is an update, not a leave.
onBeforeRouteUpdate(saveBeforeNavigation)

// A late failed request owns only its submitted copy, not newer text kept by a departing editor.
function preserveFailedDraft(storageKey: string, submitted: string, latest: string) {
	const stored = loadEditorDraft(storageKey)
	if (stored === null || stored === submitted) saveEditorDraft(storageKey, latest, draftLease)
}

let pendingSave: Promise<boolean> | undefined
async function save(): Promise<boolean> {
	if (pendingSave) {
		const ok = await pendingSave
		return ok && hasChanges.value ? save() : ok
	}
	if (!hasChanges.value) return true
	const taskId = props.modelValue.id!
	// Deleted elsewhere: the detail shows its notice, and a save could only answer 404.
	if (isTaskDeleted(queryClient, taskId)) {
		hasChanges.value = false
		clearEditorDraft(descriptionStorageKey.value, draftLease)
		return true
	}
	const submitted = description.value
	const previousDescription = props.modelValue.description ?? ''
	const previousFiles = new Map((props.modelValue.attachments ?? [])
		.filter(attachment => attachment.task_id === taskId && attachment.file?.id)
		.map(attachment => [attachment.id, attachment.file!.id]))
	const storageKey = descriptionStorageKey.value
	if (changeTimeout.value !== null) clearTimeout(changeTimeout.value)
	saveEditorDraft(storageKey, submitted, draftLease)
	if (!isDraftLeaseCurrent(draftLease)) return true
	if (!isClientRequestContextCurrent(owner)) return true
	saved.value = false
	saving.value = true
	saveError.value = ''
	pendingSave = (async () => {
		try {
			const updated = await updateTask.mutateAsync({id: taskId, description: submitted})
			if (props.modelValue.id !== taskId) return true
			if (description.value === submitted) {
				const retainedIds = (updated.attachments ?? [])
					.filter(attachment => attachment.task_id === taskId && attachment.id !== undefined
						&& attachment.file?.id !== undefined && previousFiles.get(attachment.id) === attachment.file.id)
					.map(attachment => attachment.id!)
				if (updated.id === taskId && typeof updated.description === 'string'
					&& hasRemovedAttachmentImages(previousDescription, updated.description, taskId, retainedIds)) {
					success({message: t('tcy.chatImages.receiptRemoved')})
				}
				description.value = updated.description ?? ''
				hasChanges.value = false
				clearEditorDraft(storageKey, draftLease, submitted)
				saved.value = true
			}
			emit('update:modelValue', updated)
			return true
		} catch (error) {
			if (isRequestContextAbort(error)) {
				// The account or server changed mid-request: the text stays on this device for this account.
				preserveFailedDraft(storageKey, submitted, props.modelValue.id === taskId ? description.value : submitted)
				return true
			}
			if ((error as {status?: number})?.status === 404) {
				clearEditorDraft(storageKey, draftLease, submitted)
				if (props.modelValue.id === taskId) hasChanges.value = false
				return true
			}
			if (props.modelValue.id === taskId) {
				hasChanges.value = true
				saveError.value = getErrorText(error)
				// A failed save must keep the latest typing, including an intentional empty description.
				preserveFailedDraft(storageKey, submitted, description.value)
			} else {
				preserveFailedDraft(storageKey, submitted, submitted)
			}
			return false
		} finally { saving.value = false }
	})()
	let ok: boolean
	try { ok = await pendingSave } finally { pendingSave = undefined }
	if (ok && hasChanges.value && props.modelValue.id === taskId && description.value !== submitted
		&& isClientRequestContextCurrent(owner) && isDraftLeaseCurrent(draftLease)) return save()
	return ok
}

// the editor toasts the rejection itself, a mutation toast would duplicate it
const uploadAttachments = useUploadAttachmentsMutation(() => false, owner)

function uploadCallback(files: File[] | FileList): Promise<string[]> {
	const taskId = props.modelValue.id!
	return Promise.all(Array.from(files).map(async file => {
		const result = await uploadAttachments.mutateAsync({
			taskId,
			files: [file],
		})
		const [uploaded] = result.success ?? []
		// forwarded verbatim: the editor's toast translates the error code, which a rewrapped message would lose
		if (uploaded?.id === undefined) throw result.errors?.[0] ?? new Error('Attachment upload returned no file')
		return generateAttachmentUrl(taskId, uploaded.id)
	}))
}
</script>

<style lang="scss" scoped>
.description-leave-dialog {
	max-inline-size: 34rem;
	margin-block-end: 0;

	:deep(.card-footer) {
		flex-wrap: wrap;
		justify-content: flex-end;
	}
}

.description-stored-draft {
	margin-block-end: var(--space-3);
}

.description-stored-draft__body {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-3);

	p {
		margin: 0;
	}
}

.description-stored-draft__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.description-save-error {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	margin-block-end: var(--space-3);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-md);
}

.task-section-title .loader {
	inline-size: .75rem;
	block-size: .75rem;
}

@media print {
	.tiptap__task-description {
		display: block !important;
	}
}
</style>
