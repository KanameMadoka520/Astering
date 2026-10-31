<script setup lang="ts">
import {computed, ref, watch, onBeforeUnmount} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import type {ChatAttachment} from '@/client/generated'
import {chatAttachmentQuery, fetchChatAttachment} from '@/client/queries/chatAttachments'
import {saveChatBlob, chatBytes} from '../export/files'
const props = defineProps<{conversationId: string, file: ChatAttachment, removable?: boolean, disabled?: boolean}>()
defineEmits<{remove: [id: string]}>()
const {t} = useI18n({useScope: 'global'})
const isImage = computed(() => /^image\/(png|jpeg|gif|webp)$/.test(props.file.mime || ''))
const blob = useQuery(computed(() => chatAttachmentQuery(props.conversationId, props.file.id!, isImage.value && !props.file.missing)))
const inDrive = computed(() => Boolean(props.file.drive_file_id))
const missing = computed(() => { const error = blob.error.value as {status?: number, response?: {status?: number}} | null; return props.file.missing || error?.status === 404 || error?.response?.status === 404 })
const url = ref('')
const failed = ref(false)
const saving = ref(false)
const preview = ref<HTMLDialogElement>()
watch(() => blob.data.value, data => { if (url.value) URL.revokeObjectURL(url.value); url.value = data ? URL.createObjectURL(data) : '' }, {immediate: true})
onBeforeUnmount(() => { if (url.value) URL.revokeObjectURL(url.value) })
async function download() {
	saving.value = true; failed.value = false
	try { saveChatBlob(blob.data.value ?? await fetchChatAttachment(props.conversationId, props.file.id!), props.file.name || 'attachment') }
	catch { failed.value = true } finally { saving.value = false }
}
</script>

<template>
	<figure
		class="chat-file"
		:data-file-id="file.id"
	>
		<button
			v-if="url"
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
			<button
				v-else
				type="button"
				:disabled="saving"
				@click="download"
			>
				{{ saving ? t('chatFiles.loading') : t('chatFiles.download') }}
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
				v-if="failed || (blob.isError.value && !missing)"
				role="alert"
			>{{ t('chatFiles.loadFailed') }}</span>
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

		&:disabled {
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
