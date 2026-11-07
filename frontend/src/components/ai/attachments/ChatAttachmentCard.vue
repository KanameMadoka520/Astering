<script setup lang="ts">
import {computed, nextTick, ref, watch, onBeforeUnmount} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import type {ChatAttachment} from '@/client/generated'
import {chatAttachmentQuery, fetchChatAttachment} from '@/client/queries/chatAttachments'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {useNearViewport} from '@/composables/useNearViewport'
import {saveChatBlob, chatBytes} from '../export/files'
const props = defineProps<{conversationId: string, file: ChatAttachment, removable?: boolean, disabled?: boolean}>()
defineEmits<{remove: [id: string]}>()
const {t} = useI18n({useScope: 'global'})
const isImage = computed(() => /^image\/(png|jpeg|gif|webp)$/.test(props.file.mime || ''))
const card = ref<HTMLElement>()
// A long history mounts every turn: only cards near the visible part of the thread download their original image.
// Cached bytes also wait for the viewport: creating URLs for all old images still initializes their image elements.
// Once near, a card stays loaded. The download button fetches independently of visibility.
const near = useNearViewport(card)
const blob = useQuery(computed(() => chatAttachmentQuery(
	props.conversationId,
	props.file.id!,
	isImage.value && !props.file.missing && near.value,
)))
const inDrive = computed(() => Boolean(props.file.drive_file_id))
const errorStatus = computed(() => {
	const cause = blob.error.value as {
		status?: number,
		response?: {status?: number},
	} | null
	return cause?.status ?? cause?.response?.status
})
const missing = computed(() => props.file.missing || errorStatus.value === 404)
const denied = computed(() => errorStatus.value === 401 || errorStatus.value === 403)
const unavailable = computed(() => missing.value || denied.value)
const url = ref('')
const failed = ref(false)
const saving = ref(false)
const retrying = ref(false)
const imageButton = ref<HTMLButtonElement>()
const retryButton = ref<HTMLButtonElement>()
const preview = ref<HTMLDialogElement>()
let mounted = true
// An explicit permission/missing response revokes old bytes too; transient errors may keep this account's cached preview.
watch(() => isImage.value && !unavailable.value && near.value ? blob.data.value : undefined, data => {
	if (url.value) URL.revokeObjectURL(url.value)
	url.value = data ? URL.createObjectURL(data) : ''
}, {immediate: true})
watch(unavailable, blocked => { if (blocked) preview.value?.close() })
onBeforeUnmount(() => {
	mounted = false
	if (url.value) URL.revokeObjectURL(url.value)
})
async function download() {
	if (unavailable.value || saving.value || blob.isFetching.value) return
	const owner = captureClientRequestContext()
	const conversationId = props.conversationId
	const fileId = props.file.id!
	const name = props.file.name || 'attachment'
	saving.value = true; failed.value = false
	try {
		const data = blob.data.value ?? (isImage.value
			? (await blob.refetch({throwOnError: true})).data
			: await fetchChatAttachment(conversationId, fileId))
		if (data && mounted && isClientRequestContextCurrent(owner)
			&& props.conversationId === conversationId && props.file.id === fileId) saveChatBlob(data, name)
	} catch (cause) {
		if (!isRequestContextAbort(cause) && mounted && isClientRequestContextCurrent(owner)) failed.value = true
	} finally { saving.value = false }
}
async function retryPreview() {
	if (retrying.value || blob.isFetching.value || saving.value) return
	const owner = captureClientRequestContext()
	retrying.value = true
	failed.value = false
	try { await blob.refetch({throwOnError: true}) }
	catch (cause) {
		if (!isRequestContextAbort(cause) && mounted && isClientRequestContextCurrent(owner)) failed.value = true
	}
	finally {
		const focused = document.activeElement === retryButton.value
		retrying.value = false
		await nextTick()
		if (focused && mounted && isClientRequestContextCurrent(owner)
			&& document.activeElement === document.body) imageButton.value?.focus()
	}
}
</script>

<template>
	<figure
		ref="card"
		class="chat-file"
		:data-file-id="file.id"
	>
		<button
			v-if="url"
			ref="imageButton"
			type="button"
			class="image-button"
			:aria-label="t('chatFiles.preview', {name: file.name})"
			@click="preview?.showModal()"
		>
			<img
				:src="url"
				:alt="file.name"
				loading="lazy"
			>
		</button>
		<figcaption>
			<span
				class="file-name"
				:title="file.name"
			>{{ file.name }}</span><small>{{ chatBytes(file.size) }}</small>
			<small
				v-if="inDrive"
				class="in-drive"
				:title="t('chatFiles.inDriveHint')"
			>{{ t('chatFiles.inDrive') }}</small>
			<span
				v-if="missing"
				class="file-error"
			>{{ t('chatFiles.missing') }}</span>
			<span
				v-else-if="denied"
				class="file-error"
			>{{ t('sharing.accessDenied') }}</span>
			<button
				v-else
				type="button"
				:aria-disabled="saving || blob.isFetching.value"
				@click="download"
			>
				{{ saving || blob.isFetching.value ? t('chatFiles.loading') : t('chatFiles.download') }}
			</button>
			<button
				v-if="removable"
				type="button"
				:disabled="disabled"
				:aria-label="t('chatFiles.remove', {name: file.name})"
				@click="$emit('remove', file.id!)"
			>
				{{ t('tcymc.text.remove') }}
			</button>
			<span
				v-if="(failed || blob.isError.value) && !unavailable"
				role="alert"
			>{{ t('chatFiles.loadFailed') }}</span>
			<button
				v-if="isImage && !missing && (retrying || failed || blob.isError.value)"
				ref="retryButton"
				type="button"
				:aria-disabled="blob.isFetching.value || saving"
				:aria-label="t('chatFiles.retryPreview')"
				@click="retryPreview"
			>
				{{ blob.isFetching.value ? t('chatFiles.loading') : t('chatFiles.retryPreview') }}
			</button>
		</figcaption>
		<!-- Escape belongs to this dialog alone; the floating panel around it minimizes on Escape. -->
		<dialog
			ref="preview"
			class="image-preview"
			:aria-label="t('chatFiles.preview', {name: file.name})"
			@keydown.esc.stop
			@click="($event.target === preview) && preview?.close()"
		>
			<button
				type="button"
				class="preview-close"
				@click="preview?.close()"
			>
				{{ t('misc.close') }}
			</button><img
				v-if="url"
				:src="url"
				:alt="file.name"
			><p>{{ file.name }}</p>
		</dialog>
	</figure>
</template>

<style scoped lang="scss">
.chat-file {
	inline-size: 11rem;
	max-inline-size: 100%;
	margin: 0;
	padding: var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
}

.image-button {
	display: block;
	inline-size: 100%;
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	cursor: zoom-in;

	&:focus-visible {
		@include focus-ring;
	}

	img {
		inline-size: 100%;
		block-size: 6.5rem;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		object-fit: contain;
	}
}

figcaption {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	margin-block-start: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);

	small {
		color: var(--text-tertiary);
	}

	.in-drive {
		color: var(--text-secondary);
	}

	button {
		min-block-size: var(--target-min);
		padding: 0;
		border: 0;
		background: none;
		color: var(--link);
		font: inherit;
		cursor: pointer;

		&:hover {
			text-decoration: underline;
		}

		&:focus-visible {
			@include focus-ring;
		}

		&:disabled,
		&[aria-disabled="true"] {
			opacity: .5;
			cursor: not-allowed;
		}
	}
}

.file-name {
	inline-size: 100%;
	overflow: hidden;
	color: var(--text-primary);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.file-error {
	color: var(--danger-text);
}

.image-preview {
	max-inline-size: 95vw;
	max-block-size: 90dvh;
	padding: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	&::backdrop {
		background: var(--scrim);
	}

	img {
		display: block;
		max-inline-size: 85vw;
		max-block-size: 70dvh;
		object-fit: contain;
	}

	p {
		margin-block-start: var(--space-2);
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.preview-close {
	display: block;
	min-block-size: var(--control-height-sm);
	margin-inline-start: auto;
	margin-block-end: var(--space-2);
	padding-inline: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;

	&:hover {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
	}

	&:focus-visible {
		@include focus-ring;
	}
}
</style>
