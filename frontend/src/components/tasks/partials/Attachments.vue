<template>
	<div class="attachments">
		<div class="task-section-header">
			<h2 class="task-section-title">
				<span class="icon is-grey">
					<Icon icon="paperclip" />
				</span>
				{{ $t('task.attachment.title') }}
			</h2>
			<div
				v-if="editEnabled"
				class="task-section-actions d-print-none"
			>
				<XButton
					:aria-disabled="loading || undefined"
					class="is-small"
					icon="cloud-upload-alt"
					variant="secondary"
					:shadow="false"
					@click="openFilePicker()"
				>
					{{ $t('task.attachment.upload') }}
				</XButton>
				<XButton
					variant="secondary"
					class="is-small"
					icon="folder"
					:shadow="false"
					@click="driveOpen = true"
				>
					{{ $t('drive.choose') }}
				</XButton>
			</div>
		</div>

		<input
			v-if="editEnabled"
			id="files"
			ref="filesRef"
			multiple
			type="file"
			@change="uploadNewAttachment()"
		>

		<div
			v-if="uploadBatch !== null || taskUploads.length"
			class="attachment-upload-status"
			role="group"
			:aria-label="$t('flow.uploads')"
		>
			<ProgressBar
				v-if="!taskUploads.length"
				:value="uploadProgress"
				:aria-label="$t('task.attachment.upload')"
				is-primary
			/>
			<template v-else>
				<UploadProgressRow
					v-for="row in taskUploads"
					:key="row.id"
					:row="row"
				/>
				<BaseButton
					class="clear-task-uploads"
					@click="clearFinishedUploads"
				>
					{{ $t('flow.clearFinished') }}
				</BaseButton>
			</template>
		</div>

		<div
			v-if="attachments.length > 0"
			class="files"
		>
			<div
				v-for="a in attachments"
				:key="a.id"
				class="attachment"
			>
				<div class="preview-column">
					<button
						class="preview-open"
						tabindex="-1"
						aria-hidden="true"
						@click="viewOrDownload(a)"
					>
						<FilePreview
							class="attachment-preview"
							:model-value="a"
						/>
					</button>
				</div>
				<div class="attachment-info-column">
					<button
						v-tooltip="attachmentMetaTooltip(a)"
						class="attachment-open"
						@click="viewOrDownload(a)"
					>
						<span class="filename">
							{{ a.file?.name }}
							<span
								v-if="task.cover_image_attachment_id === a.id"
								class="is-task-cover"
							>
								{{ $t('task.attachment.usedAsCover') }}
							</span>
						</span>
					</button>
					<p class="attachment-info-meta">
						<User
							:user="a.created_by ?? {}"
							:avatar-size="20"
							:show-username="false"
							:is-inline="true"
						/>
						<span>
							{{ getHumanSize(a.file?.size ?? 0) }}
						</span>
					</p>
					<AudioPreview
						v-if="canPreviewAudio(a)"
						:ref="el => setAudioPlayerRef(a, el)"
						:attachment="a"
					/>
				</div>
				<p class="attachment-actions">
					<BaseButton
						v-tooltip="$t('task.attachment.downloadTooltip')"
						:aria-label="$t('task.attachment.downloadTooltip')"
						class="attachment-info-meta-button"
						@click.prevent.stop="download(a)"
					>
						<Icon icon="download" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('task.attachment.copyUrlTooltip')"
						:aria-label="$t('task.attachment.copyUrlTooltip')"
						class="attachment-info-meta-button"
						@click.stop="copyUrl(a)"
					>
						<Icon icon="copy" />
					</BaseButton>
					<BaseButton
						v-if="editEnabled && canPreviewImage(a)"
						v-tooltip="task.cover_image_attachment_id === a.id
							? $t('task.attachment.unsetAsCover')
							: $t('task.attachment.setAsCover')"
						:aria-label="task.cover_image_attachment_id === a.id
							? $t('task.attachment.unsetAsCover')
							: $t('task.attachment.setAsCover')"
						class="attachment-info-meta-button"
						:disabled="loading"
						@click.prevent.stop="setCoverImage(task.cover_image_attachment_id === a.id ? null : a)"
					>
						<Icon :icon="task.cover_image_attachment_id === a.id ? 'eye-slash' : 'eye'" />
					</BaseButton>
					<BaseButton
						v-if="editEnabled"
						v-tooltip="$t('task.attachment.deleteTooltip')"
						:aria-label="$t('task.attachment.deleteTooltip')"
						class="attachment-info-meta-button is-danger"
						@click.prevent.stop="setAttachmentToDelete(a)"
					>
						<Icon icon="trash-alt" />
					</BaseButton>
				</p>
			</div>
		</div>

		<DrivePicker
			v-if="driveOpen"
			:busy="attachDrive.isPending.value"
			@close="driveOpen = false"
			@select="chooseDriveFile"
		/>
		<!-- Dropzone -->
		<Teleport :to="dropzoneTeleportTarget">
			<div
				v-if="editEnabled"
				:class="{hidden: !showDropzone}"
				class="dropzone"
			>
				<div class="drop-hint">
					<div class="icon">
						<Icon icon="cloud-upload-alt" />
					</div>
					<div class="hint">
						{{ $t('task.attachment.drop') }}
					</div>
				</div>
			</div>
		</Teleport>

		<!-- Delete modal -->
		<Modal
			:enabled="attachmentToDelete !== null"
			danger
			:loading="deleteMutation.isPending.value"
			@close="setAttachmentToDelete(null)"
			@submit="deleteAttachment()"
		>
			<template #header>
				<span>{{ $t('task.attachment.delete') }}</span>
			</template>

			<template #text>
				<p v-if="attachmentToDelete">
					{{ $t('task.attachment.deleteText1', {filename: attachmentToDelete.file?.name}) }}<br>
					<span>{{ $t('drive.detachNote') }}</span><br><span>{{ $t('task.attachment.inlineDeleteNote') }}</span>
				</p>
			</template>
		</Modal>

		<ImageLightbox
			v-if="preview?.kind === 'image'"
			:key="preview.blobUrl"
			:blob-url="preview.blobUrl"
			:alt="preview.name"
			@close="closePreview"
		/>

		<!-- Attachment PDF modal -->
		<Modal
			:enabled="preview?.kind === 'pdf'"
			:wide="true"
			:aria-label="$t('misc.pdfPreview')"
			@close="closePreview"
		>
			<iframe
				v-if="preview?.kind === 'pdf'"
				:src="preview.blobUrl"
				:title="preview.name"
				class="pdf-preview-iframe"
			/>
		</Modal>

		<!-- Attachment video modal -->
		<Modal
			:enabled="previewLoading || preview?.kind === 'video'"
			:wide="true"
			:aria-label="$t('misc.videoPreview')"
			@close="closePreview"
		>
			<Loading v-if="previewLoading" />
			<div
				v-else-if="previewFailed"
				class="video-preview-error"
			>
				<p>{{ $t('misc.videoLoadFailed') }}</p>
				<XButton
					icon="download"
					variant="secondary"
					@click="downloadVideoPreview"
				>
					{{ $t('misc.download') }}
				</XButton>
			</div>
			<video
				v-else-if="preview?.kind === 'video'"
				:src="preview.blobUrl"
				:aria-label="preview.name"
				class="video-preview"
				controls
				playsinline
				@error="onVideoError"
			/>
		</Modal>
	</div>
</template>

<script setup lang="ts">
import DrivePicker from '@/components/drive/DrivePicker.vue'
import {useAttachDriveMutation, type DriveEntry} from '@/client/queries/drive'
import {ref, computed, nextTick, watch, onBeforeUnmount, type ComponentPublicInstance} from 'vue'
import {useTopModalDialog} from '@/composables/useTopModalDialog'
import {useDropZone} from '@vueuse/core'

import User from '@/components/misc/User.vue'
import ProgressBar from '@/components/misc/ProgressBar.vue'
import UploadProgressRow from '@/components/misc/UploadProgressRow.vue'
import {uploads} from '@/helpers/uploadTransport'
import Loading from '@/components/misc/Loading.vue'
import BaseButton from '@/components/base/BaseButton.vue'

import {runUploadQueue} from '@/helpers/uploadQueue'
import {useUploadAttachmentsMutation, useDeleteAttachmentMutation} from '@/client/queries/attachments'
import {canPreviewAudio, canPreviewImage, previewKind, type PreviewKind} from '@/helpers/attachmentPreview'
import {getDisplayName} from '@/helpers/user'
import type {TaskAttachment as IAttachment} from '@/client/generated'
import type {Task as ITask} from '@/client/generated'

import {formatDateLong} from '@/helpers/time/formatDate'
import {downloadAttachment, fetchAttachmentUrl, generateAttachmentUrl, releaseAttachmentUrl} from '@/helpers/attachments'
import {downloadBlob} from '@/helpers/downloadBlob'
import {getHumanSize} from '@/helpers/getHumanSize'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import {error, success} from '@/message'
import {isRequestContextAbort} from '@/client/requestContext'
import {useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {useI18n} from 'vue-i18n'
import FilePreview from '@/components/tasks/partials/FilePreview.vue'
import ImageLightbox from '@/components/misc/ImageLightbox.vue'
import AudioPreview from '@/components/tasks/partials/AudioPreview.vue'

type AudioPreviewInstance = InstanceType<typeof AudioPreview>

const props = withDefaults(defineProps<{
	task: ITask,
	editEnabled?: boolean,
}>(), {
	editEnabled: true,
})

const EDITOR_SELECTOR = '.tiptap, .tiptap__editor, [contenteditable]'

function eventTargetsEditor(event: Event | null | undefined): boolean {
	if (!event) {
		return false
	}

	const target = event.target
	if (target instanceof HTMLElement && target.closest(EDITOR_SELECTOR)) {
		return true
	}

	if (typeof event.composedPath === 'function') {
		return event.composedPath().some(element =>
			element instanceof HTMLElement && element.matches(EDITOR_SELECTOR),
		)
	}

	return false
}

const updateTask = useUpdateTaskMutation()
const {t} = useI18n({useScope: 'global'})

const taskUploads = computed(() => uploads.value.filter(row => row.targetPath.endsWith(`/tasks/${props.task.id}/attachments`)))
function clearFinishedUploads() {
	const finished = new Set(taskUploads.value.filter(row => ['done', 'error', 'cancelled'].includes(row.stage)).map(row => row.id))
	uploads.value = uploads.value.filter(row => !finished.has(row.id))
}

const attachments = computed(() => props.task.attachments ?? [])
const uploadMutation = useUploadAttachmentsMutation()
let uploadController: AbortController | undefined
onBeforeUnmount(() => uploadController?.abort())
watch(() => props.task.id, () => uploadController?.abort())
const deleteMutation = useDeleteAttachmentMutation()
const uploadBatch = ref<{
	completed: number,
	total: number,
} | null>(null)
// Brief fallback while the SDK prepares the request; byte-level status takes over once transport starts.
const uploadProgress = computed(() => uploadBatch.value === null || uploadBatch.value.completed === 0
	? undefined
	: (uploadBatch.value.completed / uploadBatch.value.total) * 100)
const loading = computed(() => attachDrive.isPending.value || uploadBatch.value !== null
	|| uploadMutation.isPending.value
	|| deleteMutation.isPending.value
	|| updateTask.isPending.value)

const isDraggingFiles = ref(false)
const isDragOverEditor = ref(false)

function resetDragState() {
	isDraggingFiles.value = false
	isDragOverEditor.value = false
}

/**
 * Check if a drag event contains actual files (not text being dragged).
 * This prevents the file upload overlay from appearing when dragging text
 * from within the editor to outside it.
 */
function eventContainsFiles(event: Event | null | undefined): boolean {
	if (!event || !(event instanceof DragEvent)) {
		return false
	}
	return event.dataTransfer?.types.includes('Files') ?? false
}

const {isOverDropZone} = useDropZone(document, {
	onEnter(files, event) {
		if (!props.editEnabled) {
			return
		}

		// Only show dropzone if actual files are being dragged, not text
		if (!eventContainsFiles(event)) {
			return
		}

		isDraggingFiles.value = true
		isDragOverEditor.value = eventTargetsEditor(event)
	},
	onOver(files, event) {
		if (!props.editEnabled) {
			return
		}

		isDragOverEditor.value = eventTargetsEditor(event)
	},
	onLeave(files, event) {
		if (!props.editEnabled) {
			return
		}

		if (!isOverDropZone.value) {
			resetDragState()
			return
		}

		isDragOverEditor.value = eventTargetsEditor(event)
	},
	onDrop(files, event) {
		if (!props.editEnabled) {
			return
		}

		const dropOverEditor = eventTargetsEditor(event)
		resetDragState()

		// Ignore drops over editor - let TipTap handle them
		if (dropOverEditor || !files || files.length === 0) {
			return
		}

		uploadFilesToTask(files)
	},
})

const showDropzone = computed(() =>
	props.editEnabled && isDraggingFiles.value && !isDragOverEditor.value,
)

// A <dialog> opened with showModal() (e.g. the Kanban task detail) renders in
// the browser's top layer, so the full-screen dropzone overlay teleported to
// <body> would paint behind it regardless of z-index. Teleport it into the
// topmost open dialog instead, mirroring Notification.vue. The shared tracker
// only watches body's own children, not every change in the page.
const {topModalDialog} = useTopModalDialog()
const dropzoneTeleportTarget = computed<string | HTMLElement>(() => topModalDialog.value ?? 'body')

watch(() => props.editEnabled, enabled => {
	if (!enabled) {
		resetDragState()
	}
})

function attachmentMetaTooltip(attachment: IAttachment): string {
	const createdBy = t('task.attachment.createdBy', [
		formatDateLong(attachment.created),
		getDisplayName(attachment.created_by ?? {}),
	])

	return attachment.file?.mime
		? `${attachment.file?.mime} · ${createdBy}`
		: createdBy
}

const filesRef = ref<HTMLInputElement | null>(null)

function openFilePicker() {
	if (loading.value) {
		return
	}

	filesRef.value?.click()
}

async function uploadNewAttachment() {
	const input = filesRef.value
	const files = input?.files

	if (files && files.length > 0) {
		await uploadFilesToTask(files)
	}

	// without this, re-picking the same file fires no change event
	if (input) input.value = ''
}

async function uploadFilesToTask(files: File[] | FileList) {
	if (loading.value) {
		return
	}

	const taskId = props.task.id!
	const batch = Array.from(files)
	uploadBatch.value = {
		completed: 0,
		total: batch.length,
	}
	uploadController = new AbortController()
	await runUploadQueue(batch, uploadController.signal,
		(file, signal) => uploadMutation.mutateAsync({taskId, files: [file], signal}),
		result => {
			for (const err of result.errors ?? []) error(err)
			if (uploadBatch.value) uploadBatch.value.completed++
		},
	)
	// render the finished bar before it disappears
	await nextTick()
	uploadBatch.value = null
}

const attachmentToDelete = ref<IAttachment | null>(null)

function setAttachmentToDelete(attachment: IAttachment | null) {
	if (deleteMutation.isPending.value) return
	attachmentToDelete.value = attachment
}

async function deleteAttachment() {
	if (deleteMutation.isPending.value || attachmentToDelete.value === null) {
		return
	}

	const target = attachmentToDelete.value
	try {
		await deleteMutation.mutateAsync({taskId: props.task.id!, id: target.id!})
	} catch {
		return
	}
	if (attachmentToDelete.value === target) setAttachmentToDelete(null)
}

interface Preview {
	kind: PreviewKind
	blobUrl: string
	name: string
}

const preview = ref<Preview | null>(null)
const previewLoading = ref(false)
const previewFailed = ref(false)
let previewRequestToken = 0

function replacePreview(next: Preview | null) {
	releaseAttachmentUrl(preview.value?.blobUrl)
	preview.value = next
}

function closePreview() {
	// an in-flight blob must not re-open the dismissed modal
	previewRequestToken++
	replacePreview(null)
	previewLoading.value = false
	previewFailed.value = false
}

// a detached <video> can still fire error after its blob url was revoked
function onVideoError(e: Event) {
	if ((e.target as HTMLVideoElement).src !== preview.value?.blobUrl) {
		return
	}
	previewFailed.value = true
}

function downloadVideoPreview() {
	const current = preview.value
	if (current === null) {
		return
	}

	// downloadBlob revokes the url itself, so hand over ownership before closing
	preview.value = null
	downloadBlob(current.blobUrl, current.name)
	closePreview()
}

onBeforeUnmount(closePreview)
watch(() => props.task.id, () => { closePreview(); attachmentToDelete.value = null; driveOpen.value = false })

const audioPlayers = new Map<IAttachment['id'], AudioPreviewInstance>()

function setAudioPlayerRef(attachment: IAttachment, el: Element | ComponentPublicInstance | null) {
	if (el === null) {
		audioPlayers.delete(attachment.id!)
		return
	}

	audioPlayers.set(attachment.id, el as AudioPreviewInstance)
}

async function download(attachment: IAttachment) {
	try {
		await downloadAttachment(attachment)
	} catch (e) {
		if (!isRequestContextAbort(e)) {
			error(e)
		}
	}
}

async function viewOrDownload(attachment: IAttachment) {
	if (canPreviewAudio(attachment) && audioPlayers.has(attachment.id!)) {
		await audioPlayers.get(attachment.id!)!.play()
		return
	}

	const kind = previewKind(attachment)
	if (kind === null) {
		await download(attachment)
		return
	}

	closePreview()

	previewRequestToken++
	const requestToken = previewRequestToken

	// only video is big enough that the full-buffer wait reads as a dead click
	previewLoading.value = kind === 'video'

	try {
		const blobUrl = await fetchAttachmentUrl({id: attachment.id!, task_id: attachment.task_id!})
		// stale response: release without assigning, the img may still be decoding the current url
		if (requestToken !== previewRequestToken) {
			releaseAttachmentUrl(blobUrl)
			return
		}
		previewLoading.value = false
		replacePreview({kind, blobUrl, name: attachment.file?.name ?? ''})
	} catch (e) {
		if (requestToken !== previewRequestToken) {
			return
		}
		previewLoading.value = false
		if (!isRequestContextAbort(e)) {
			error(e)
		}
	}
}

const copy = useCopyToClipboard()

function copyUrl(attachment: IAttachment) {
	copy(generateAttachmentUrl(props.task.id!, attachment.id!))
}

async function setCoverImage(attachment: IAttachment | null) {
	if (loading.value || !props.editEnabled) return
	try {
		await updateTask.mutateAsync({id: props.task.id!, cover_image_attachment_id: attachment?.id ?? 0})
		success({message: t('task.attachment.successfullyChangedCoverImage')})
	} catch { /* Mutation reports errors; leave the current cover intact. */ }
}

defineExpose({openFilePicker})
const driveOpen = ref(false)
const attachDrive = useAttachDriveMutation()
async function chooseDriveFile(file: DriveEntry) {
	if (loading.value || !props.editEnabled) return
	const result = await attachDrive.mutateAsync({file, taskId: props.task.id!}).catch(() => undefined)
	if (result) driveOpen.value = false
}
</script>

<style lang="scss" scoped>
.attachments {
	input[type="file"] {
		display: none;
	}
}

.files {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.attachment {
	display: grid;
	grid-template-columns: 3rem minmax(0, 1fr) auto;
	grid-template-areas: "preview info actions";
	align-items: center;
	gap: var(--space-1) var(--space-3);
	inline-size: 100%;
	padding: var(--space-2);
	border-radius: var(--radius-md);
	background-color: transparent;
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	@media screen and (min-width: $tablet) {
		grid-template-columns: 4rem minmax(0, 1fr) auto;
	}

	// Phones: actions move under the file name so the name keeps the row's width.
	@media screen and (max-width: $tablet) {
		grid-template-areas:
			"preview info"
			"preview actions";
		grid-template-columns: 3rem minmax(0, 1fr);
		align-items: start;
	}
}

.preview-column {
	grid-area: preview;
	aspect-ratio: 1;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
}

// Redundant mouse-only click target; the real control is button.attachment-open.
.preview-open {
	display: block;
	inline-size: 100%;
	block-size: 100%;
	padding: 0;
	border: 0;
	background: transparent;
	cursor: pointer;
}

.attachment-preview {
	inline-size: 100%;
	block-size: 100%;
}

.attachment-info-column {
	grid-area: info;
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-inline-size: 0;
}

.attachment-open {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	inline-size: 100%;
	min-inline-size: 0;
	padding: 0;
	border: 0;
	border-radius: var(--radius-xs);
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: start;
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

.filename {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	min-inline-size: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	text-align: start;
	word-break: break-all;
}

.attachment .attachment-info-meta {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	margin-block: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	:deep(.avatar-wrapper) {
		margin-inline-end: 0;
	}
}

.attachment .attachment-actions {
	grid-area: actions;
	display: flex;
	flex-wrap: wrap;
	gap: 2px;
	margin: 0;
}

.attachment-info-meta-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: max(1.75rem, var(--target-min));
	block-size: max(1.75rem, var(--target-min));
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&.is-danger:hover {
		background: var(--tint-danger);
		color: var(--danger-text);
	}

	&:disabled {
		opacity: .5;
		cursor: not-allowed;
	}
}

.is-task-cover {
	padding: 2px var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-2xs);
	font-weight: var(--weight-semibold);
	word-break: normal;
}

.attachment-upload-status {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin-block-end: var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
}

.clear-task-uploads {
	align-self: flex-start;
	min-block-size: var(--target-min);
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);
	color: var(--accent-text);
	font-size: var(--text-sm);

	&:hover {
		background: var(--surface-hover);
	}
}

.dropzone {
	position: fixed;
	inset: 0;
	// Above the app chrome when teleported to body; inside an open dialog the top layer already wins.
	z-index: 4001;
	background: hsla(var(--grey-100-hsl), .85);
	text-align: center;

	&.hidden {
		display: none;
	}
}

.drop-hint {
	position: absolute;
	inset-block-end: var(--space-8);
	inset-inline: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);

	.icon {
		inline-size: auto;
		block-size: auto;
		color: var(--accent-text);
		font-size: 3rem;
	}

	.hint {
		inline-size: calc(100% - var(--space-8));
		max-inline-size: 20rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--primary);
		box-shadow: var(--elevation-3);
		color: #ffffff; // the primary fill needs white text in both themes
		font-weight: var(--weight-semibold);
	}
}

.pdf-preview-iframe {
	display: block;
	inline-size: 100%;
	max-inline-size: calc(100% - 4rem);
	block-size: calc(100dvh - 40px);
	margin: 0 auto;
	border: none;
}

.video-preview {
	display: block;
	inline-size: auto;
	max-inline-size: calc(100% - 4rem);
	max-block-size: calc(100dvh - 40px);
	margin: 0 auto;
}

// unlike the video and iframe branches, the error state has no opaque media of its own to sit on
.video-preview-error {
	max-inline-size: 25rem;
	margin: 0 auto;
	padding: var(--space-8);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	color: var(--text-primary);
	text-align: center;

	p {
		margin-block-end: var(--space-4);
	}
}
</style>
