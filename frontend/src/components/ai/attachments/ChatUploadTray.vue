<script setup lang="ts">
import {computed, onUpdated, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import UploadProgressRow from '@/components/misc/UploadProgressRow.vue'
import {uploads} from '@/helpers/uploadTransport'
import type {ChatUploadItem} from '@/composables/useChatAttachmentUploads'
import {chatBytes} from '../export/files'
const props = defineProps<{items: ChatUploadItem[], running: boolean, disabled?: boolean}>()
const emit = defineEmits<{retry: [key: string], retryFailed: [], cancel: [], dismiss: [key: string], clearFinished: []}>()
const {t} = useI18n({useScope: 'global'})
const status = ref<HTMLElement>()
const list = ref<HTMLUListElement>()
// Every action hides its own button: its row leaves, its file is queued again, or the run starts or stops.
// A keyboard-focused button hands focus on to a neighbouring row's action (after Remove) or to the status line,
// not to the page body. When the whole tray leaves, the composer moves focus instead.
let handoff: {button: HTMLElement, row?: number} | undefined
function act(event: Event, action: () => void, row?: number) {
	const button = event.currentTarget
	handoff = button instanceof HTMLElement && button === document.activeElement ? {button, row} : undefined
	action()
}
onUpdated(() => {
	const pending = handoff
	if (!pending) return
	const focused = document.activeElement
	if (focused && focused !== document.body && focused !== pending.button) {
		// Focus has moved on by other means.
		handoff = undefined
		return
	}
	// Cancel stays until the current upload has stopped.
	if (pending.button.isConnected && !pending.button.matches(':disabled')) return
	handoff = undefined
	const listed = list.value?.children
	const neighbours: (Element | undefined)[] = pending.row === undefined || !listed ? [] : [listed[pending.row], listed[pending.row - 1]]
	const next = neighbours.map(row => row?.querySelector<HTMLButtonElement>('button:not(:disabled)')).find(Boolean)
	const target = next ?? status.value
	target?.focus()
})
const stateLabels = {queued: 'chatFiles.queued', uploading: 'flow.uploading', done: 'flow.done', failed: 'flow.error', cancelled: 'flow.cancelled'} as const
// Transfer details come from the transport's record; a queued retry shows "queued", not its previous attempt.
const rows = computed(() => {
	const records = new Map(uploads.value.map(row => [row.id, row]))
	return props.items.map(item => ({item, record: item.state === 'queued' || !item.recordId ? undefined : records.get(item.recordId)}))
})
const remaining = computed(() => props.items.filter(item => item.state === 'queued' || item.state === 'uploading').length)
const unsent = computed(() => props.items.filter(item => item.state === 'failed' || item.state === 'cancelled'))
const retryable = computed(() => unsent.value.filter(item => item.retryable).length)
const finished = computed(() => props.items.length - remaining.value)
</script>

<template>
	<section
		class="chat-upload-tray"
		:aria-label="t('chatFiles.uploadTray')"
		:aria-busy="running"
	>
		<header class="chat-upload-head">
			<p
				ref="status"
				class="chat-upload-status"
				role="status"
				tabindex="-1"
			>
				{{ running ? t('chatFiles.uploadRemaining', {count: remaining}) : unsent.length ? t('chatFiles.uploadUnsent', {count: unsent.length}) : t('flow.done') }}
			</p>
			<button
				v-if="running"
				type="button"
				class="chat-upload-button"
				@click="act($event, () => emit('cancel'))"
			>
				{{ t('chatFiles.cancelRemaining') }}
			</button>
			<template v-else>
				<button
					v-if="retryable >= 2"
					type="button"
					class="chat-upload-button"
					:disabled="disabled"
					@click="act($event, () => emit('retryFailed'))"
				>
					{{ t('chatFiles.retryAll') }}
				</button>
				<button
					v-if="finished >= 2"
					type="button"
					class="chat-upload-button"
					@click="act($event, () => emit('clearFinished'))"
				>
					{{ t('flow.clearFinished') }}
				</button>
			</template>
		</header>
		<ul
			ref="list"
			class="chat-upload-list"
		>
			<li
				v-for="({item, record}, index) in rows"
				:key="item.key"
				class="chat-upload-item"
				:data-state="item.state"
			>
				<div class="chat-upload-body">
					<UploadProgressRow
						v-if="record"
						:row="record"
					/>
					<div
						v-else
						class="chat-upload-summary"
					>
						<strong>{{ item.name }}</strong>
						<span>{{ t(stateLabels[item.state]) }} · {{ chatBytes(item.size) }}</span>
					</div>
					<small
						v-if="item.error && item.error !== record?.error"
						class="chat-upload-error"
					>{{ item.error }}</small>
				</div>
				<div
					v-if="item.state === 'failed' || item.state === 'cancelled'"
					class="chat-upload-item-actions"
				>
					<button
						v-if="item.retryable"
						type="button"
						class="chat-upload-button"
						:disabled="disabled || running"
						:aria-label="t('chatFiles.retryFile', {name: item.name})"
						@click="act($event, () => emit('retry', item.key))"
					>
						{{ t('misc.retry') }}
					</button>
					<button
						type="button"
						class="chat-upload-button"
						:aria-label="t('chatFiles.dismissFile', {name: item.name})"
						@click="act($event, () => emit('dismiss', item.key), index)"
					>
						{{ t('tcymc.text.remove') }}
					</button>
				</div>
			</li>
		</ul>
	</section>
</template>

<style scoped lang="scss">
.chat-upload-tray {
	min-inline-size: 0;
	margin-block-end: var(--space-2);
	padding: var(--space-1) var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	font-size: var(--text-sm);
}

.chat-upload-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
}

.chat-upload-status {
	flex: 1 1 8rem;
	min-inline-size: 0;
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	&:focus-visible {
		@include focus-ring;
	}
}

.chat-upload-list {
	max-block-size: min(12rem, 30dvh);
	margin: 0;
	padding: 0;
	overflow: auto;
	overscroll-behavior: contain;
	list-style: none;
}

.chat-upload-item {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
	min-inline-size: 0;

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}
}

.chat-upload-body {
	flex: 1 1 12rem;
	min-inline-size: 0;
}

.chat-upload-summary {
	display: grid;
	gap: var(--space-1);
	padding-block: var(--space-2);
	overflow-wrap: anywhere;

	strong {
		font-weight: var(--weight-medium);
	}

	span {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
}

.chat-upload-error {
	display: block;
	padding-block-end: var(--space-2);
	color: var(--danger-text);
	font-size: var(--text-xs);
	overflow-wrap: anywhere;
}

.chat-upload-item-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0 var(--space-3);
}

.chat-upload-button {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--link);
	font: inherit;
	font-size: var(--text-xs);
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

@media (pointer: coarse) {
	.chat-upload-button {
		min-inline-size: var(--target-min);
		padding-inline: var(--space-1);
	}
}
</style>
