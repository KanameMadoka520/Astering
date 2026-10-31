<template>
	<section
		class="compass-image-tray"
		:aria-label="t('compass.images.trayLabel')"
		:aria-busy="running"
	>
		<header class="compass-image-tray__head">
			<p
				ref="status"
				class="compass-image-tray__status"
				role="status"
				tabindex="-1"
			>
				{{ statusText }}
			</p>
			<button
				v-if="running"
				type="button"
				class="compass-image-tray__button"
				@click="emit('cancel')"
			>
				{{ t('compass.images.cancelRemaining') }}
			</button>
			<button
				v-else-if="finished >= 2"
				type="button"
				class="compass-image-tray__button"
				@click="emit('clearFinished')"
			>
				{{ t('flow.clearFinished') }}
			</button>
		</header>
		<ul class="compass-image-tray__list">
			<li
				v-for="{item, record} in rows"
				:key="item.key"
				class="compass-image-tray__item"
				:data-state="item.state"
			>
				<div class="compass-image-tray__body">
					<UploadProgressRow
						v-if="record"
						:row="record"
					/>
					<div
						v-else
						class="compass-image-tray__summary"
					>
						<strong>{{ item.name }}</strong>
						<span>{{ t(STATE_LABELS[item.state]) }} · {{ getHumanSize(item.size) }}</span>
					</div>
					<small
						v-if="item.error && item.error !== record?.error"
						class="compass-image-tray__error"
					>{{ item.error }}</small>
				</div>
				<div
					v-if="item.state === 'failed' || item.state === 'cancelled'"
					class="compass-image-tray__actions"
				>
					<button
						v-if="item.retryable"
						type="button"
						class="compass-image-tray__button"
						:disabled="running"
						:aria-label="t('compass.images.retryFile', {name: item.name})"
						@click="emit('retry', item.key)"
					>
						{{ t('misc.retry') }}
					</button>
					<button
						type="button"
						class="compass-image-tray__button"
						:aria-label="t('compass.images.dismissFile', {name: item.name})"
						@click="dismiss(item.key)"
					>
						{{ t('compass.images.dismiss') }}
					</button>
				</div>
			</li>
		</ul>
	</section>
</template>

<script setup lang="ts">
import {computed, nextTick, useTemplateRef} from 'vue'
import {useI18n} from 'vue-i18n'
import UploadProgressRow from '@/components/misc/UploadProgressRow.vue'
import {getHumanSize} from '@/helpers/getHumanSize'
import {uploads} from '@/helpers/uploadTransport'
import type {CompassImageUpload} from './useCompassImageEditing'

const props = defineProps<{
	items: CompassImageUpload[]
	running: boolean
}>()

const emit = defineEmits<{
	retry: [key: string]
	cancel: []
	dismiss: [key: string]
	clearFinished: []
}>()

const {t} = useI18n({useScope: 'global'})
const status = useTemplateRef<HTMLElement>('status')

const STATE_LABELS = {
	queued: 'compass.images.queued',
	uploading: 'flow.uploading',
	done: 'flow.done',
	failed: 'flow.error',
	cancelled: 'flow.cancelled',
} as const

// Transfer details come from the transport's own row; a queued retry shows "queued", not its last attempt.
const rows = computed(() => {
	const records = new Map(uploads.value.map(row => [row.id, row]))
	return props.items.map(item => ({
		item,
		record: item.state === 'queued' || !item.recordId ? undefined : records.get(item.recordId),
	}))
})

const remaining = computed(() => props.items.filter(item => item.state === 'queued' || item.state === 'uploading').length)
const unsent = computed(() => props.items.filter(item => item.state === 'failed' || item.state === 'cancelled').length)
const finished = computed(() => props.items.length - remaining.value)

const statusText = computed(() => {
	if (props.running) return t('compass.images.remaining', {n: remaining.value}, remaining.value)
	if (unsent.value > 0) return t('compass.images.unsent', {n: unsent.value}, unsent.value)
	return t('compass.images.added')
})

// The row leaves with its button; focus stays in the tray instead of falling back to the page.
async function dismiss(key: string) {
	emit('dismiss', key)
	await nextTick()
	if (!document.activeElement || document.activeElement === document.body) status.value?.focus()
}
</script>

<style lang="scss" scoped>
.compass-image-tray {
	min-inline-size: 0;
	margin-block-start: var(--space-2);
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	font-family: var(--compass-sans);
	font-size: var(--text-sm);
}

.compass-image-tray__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
}

.compass-image-tray__status {
	flex: 1 1 8rem;
	min-inline-size: 0;
	margin: 0;
	padding-block: var(--space-1);
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-image-tray__list {
	max-block-size: min(14rem, 32dvh);
	margin: 0;
	padding: 0;
	overflow: auto;
	overscroll-behavior: contain;
	list-style: none;
}

.compass-image-tray__item {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
	min-inline-size: 0;

	& + & {
		border-block-start: 1px solid var(--compass-rule);
	}
}

.compass-image-tray__body {
	flex: 1 1 12rem;
	min-inline-size: 0;
}

.compass-image-tray__summary {
	display: grid;
	gap: var(--space-1);
	padding-block: var(--space-2);
	overflow-wrap: anywhere;

	strong {
		font-weight: var(--weight-medium);
	}

	span {
		color: var(--compass-ink-soft);
		font-size: var(--text-xs);
	}
}

.compass-image-tray__error {
	display: block;
	padding-block-end: var(--space-2);
	color: var(--danger-text);
	font-size: var(--text-xs);
	overflow-wrap: anywhere;
}

.compass-image-tray__actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0 var(--space-3);
}

.compass-image-tray__button {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--compass-accent);
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
		cursor: not-allowed;
		opacity: .5;
	}

	@media (pointer: coarse) {
		min-inline-size: var(--target-min);
		padding-inline: var(--space-1);
	}
}
</style>
