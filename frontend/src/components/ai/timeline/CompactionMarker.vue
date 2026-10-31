<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import {characterCount, compactionStatus, type AutoCompaction, type CompactionStatus} from '@/helpers/aronaTimeline'
import {compactionUsage, requestUsage} from '@/helpers/aronaRunMetrics'

// One static marker per automatic compaction. Token figures are the backend's estimates, never billed usage.
const props = withDefaults(defineProps<{
	event: AutoCompaction
	explain?: boolean
}>(), {
	explain: false,
})
const {t, n} = useI18n({useScope: 'global'})
const open = ref(false)

const ICONS: Record<CompactionStatus, IconProp> = {running: 'ellipsis-h', completed: 'check', failed: 'exclamation-circle'}
const status = computed(() => compactionStatus(props.event))
const statusText = computed(() => {
	switch (status.value) {
		case 'running': return t('chat.running')
		case 'completed': return t('flow.done')
		default: return t('tcymc.text.failed')
	}
})

function seconds(ms: number) {
	return t('chat.seconds', {value: n(ms / 1000, {minimumFractionDigits: 2, maximumFractionDigits: 2})})
}
function positive(value?: number) {
	return typeof value === 'number' && value > 0 ? value : null
}

const parts = computed(() => {
	const event = props.event
	const before = positive(event.before_tokens)
	const after = positive(event.after_tokens)
	const attachments = positive(event.attachment_count)
	const duration = positive(event.duration_ms)
	const result: string[] = []
	// Only a completed checkpoint has an "after" figure worth comparing.
	if (before !== null && after !== null && status.value === 'completed') result.push(t('aronaRun.compaction.tokens', {before: n(before), after: n(after)}))
	else if (before !== null) result.push(t('aronaRun.compaction.tokensBefore', {before: n(before)}))
	if (attachments !== null && status.value === 'completed') result.push(t('aronaRun.compaction.attachments', {count: n(attachments)}, attachments))
	if (duration !== null) result.push(seconds(duration))
	return result
})

const progress = computed(() => {
	const value = props.event.progress
	return status.value === 'running' && value?.batch && value.batches && value.attempt
		? t('flow.compactBatch', {batch: n(value.batch), total: n(value.batches), attempt: n(value.attempt)})
		: ''
})

const usageLine = computed(() => {
	const value = requestUsage(compactionUsage(props.event))
	const running = status.value === 'running'
	if (!value) return running ? t('flow.usagePending') : t('aronaRun.usageUnreported')
	const items: string[] = []
	if (value.input !== null) items.push(t('aronaRun.input', {value: n(value.input)}))
	if (value.output !== null) items.push(t('aronaRun.output', {value: n(value.output)}))
	if (!items.length) return t('aronaRun.usageUnreported')
	return running ? `${t('aronaRun.provisional')} · ${items.join(' · ')}` : items.join(' · ')
})
</script>

<template>
	<div
		class="timeline-marker is-compaction"
		:data-status="status"
	>
		<details
			class="marker-details"
			@toggle="open = ($event.target as HTMLDetailsElement).open"
		>
			<summary>
				<Icon
					class="disclosure-icon"
					icon="chevron-right"
				/>
				<Icon
					class="marker-icon"
					icon="compress"
				/>
				<strong>{{ t('aronaRun.compaction.title') }}</strong>
				<span class="marker-state"><Icon :icon="ICONS[status]" /> {{ statusText }}</span>
				<span
					v-for="(part, index) in parts"
					:key="index"
				>· {{ part }}</span>
			</summary>
			<!-- The checkpoint text can be long; render it only while open. -->
			<div
				v-if="open"
				class="marker-body"
			>
				<p>{{ usageLine }}</p>
				<p>{{ t('aronaRun.compaction.tokenNote') }}</p>
				<template v-if="event.summary && status === 'completed'">
					<strong>{{ t('aronaRun.compaction.summaryTitle') }} · {{ t('aronaRun.characters', {count: n(characterCount(event.summary))}, characterCount(event.summary)) }}</strong>
					<p
						class="compaction-summary"
						tabindex="0"
					>
						{{ event.summary }}
					</p>
				</template>
			</div>
		</details>
		<p
			v-if="progress"
			class="marker-note"
		>
			{{ progress }}
		</p>
		<p
			v-if="status === 'failed'"
			class="marker-error"
		>
			<Icon icon="exclamation-circle" />
			<span>{{ event.error || t('tcymc.text.failed') }} · {{ t('aronaRun.compaction.retained') }}</span>
		</p>
		<p
			v-if="explain"
			class="marker-note"
		>
			{{ t('aronaRun.compaction.help') }}
		</p>
	</div>
</template>

<style scoped lang="scss">
// A quiet divider between rounds: same thin rail as the round rows, dashed so it reads as a context event.
.timeline-marker {
	min-inline-size: 0;
	margin-block: var(--space-2);
	padding-inline-start: var(--space-3);
	border-inline-start: 2px dashed var(--border-default);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.timeline-marker[data-status='failed'] {
	border-inline-start-color: var(--danger);
}

summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	min-block-size: var(--target-min);
	list-style: none;
	border-radius: var(--radius-sm);
	cursor: pointer;
	overflow-wrap: anywhere;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}

	strong {
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}

	> span {
		min-inline-size: 0;
		font-variant-numeric: tabular-nums;
	}
}

.disclosure-icon {
	flex-shrink: 0;
	inline-size: .65em;
	transition: transform var(--motion-fast) var(--ease-standard);
}

.marker-details[open] > summary > .disclosure-icon {
	transform: rotate(90deg);
}

.marker-icon,
.marker-state svg,
.marker-error svg {
	flex-shrink: 0;
	inline-size: .85em;
}

.marker-state {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

[data-status='failed'] .marker-state {
	color: var(--danger-text);
}

.marker-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding-block: var(--space-1) var(--space-2);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	strong {
		margin-block-start: var(--space-1);
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}
}

.compaction-summary {
	max-block-size: 20rem;
	overflow-y: auto;
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	white-space: pre-wrap;

	&:focus-visible {
		@include focus-ring;
	}
}

.marker-note,
.marker-error {
	margin: 0 0 var(--space-1);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

.marker-error {
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	color: var(--danger-text);
}
</style>
