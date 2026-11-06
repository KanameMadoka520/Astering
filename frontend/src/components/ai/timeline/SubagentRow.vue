<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import {
	finalAnswer,
	hidesLastStepText,
	NO_ACTIONS,
	NO_COMPACTIONS,
	NO_OPERATIONS,
	NO_STEPS,
	subagentStatus,
	timelineLayout,
	type SubagentStatus,
	type SubagentTask,
} from '@/helpers/aronaTimeline'
import {requestUsage} from '@/helpers/aronaRunMetrics'
import CompactionMarker from './CompactionMarker.vue'
import MarkdownBlock from './MarkdownBlock.vue'
import TimelineStep from './TimelineStep.vue'

// A read-only experimental worker. Its rounds, findings and errors render only while open; there is no cancel
// control here because stopping the parent turn stops every subagent.
const props = defineProps<{
	task: SubagentTask
	parentRunning: boolean
}>()
const {t, n} = useI18n({useScope: 'global'})
const open = ref(false)

const ICONS: Record<SubagentStatus, IconProp> = {running: 'ellipsis-h', completed: 'check', failed: 'exclamation-circle', stopped: 'stop'}
const status = computed(() => subagentStatus(props.task))
// Nothing streams once the parent has finished, whatever the saved status says.
const running = computed(() => status.value === 'running' && props.parentRunning)
const statusText = computed(() => {
	switch (status.value) {
		case 'running': return t('chat.running')
		case 'completed': return t('flow.done')
		case 'stopped': return t('aronaRun.subagent.stopped')
		default: return t('tcymc.text.failed')
	}
})

function seconds(ms: number) {
	return t('chat.seconds', {value: n(ms / 1000, {minimumFractionDigits: 2, maximumFractionDigits: 2})})
}

const meta = computed(() => {
	const task = props.task
	const parts: string[] = []
	if (status.value === 'running' && task.stage) parts.push(t(`flow.stage_${task.stage}`))
	if (task.model) parts.push(task.model)
	if (typeof task.duration_ms === 'number' && task.duration_ms > 0) parts.push(seconds(task.duration_ms))
	const usage = requestUsage(task.usage)
	const figures: string[] = []
	if (usage?.input != null) figures.push(t('aronaRun.input', {value: n(usage.input)}))
	if (usage?.output != null) figures.push(t('aronaRun.output', {value: n(usage.output)}))
	// A running worker's usage only covers its finished requests so far.
	if (figures.length) parts.push(status.value === 'running' ? `${t('aronaRun.provisional')} · ${figures.join(' · ')}` : figures.join(' · '))
	return parts
})

const steps = computed(() => props.task.steps ?? NO_STEPS)
const actions = computed(() => props.task.actions ?? NO_ACTIONS)
// The same answer rules as the parent turn: the reply moves below the rounds, identical last text is not repeated.
// Only a completed worker's last text counts as findings; a failed or stopped one keeps partial text in its round.
const record = computed(() => ({reply: props.task.reply, steps: status.value === 'completed' ? props.task.steps : undefined}))
const reply = computed(() => finalAnswer(record.value, running.value))
const hideLastText = computed(() => hidesLastStepText(record.value, running.value))
// A subagent counts its next round before the first update arrives, and has no budget to tell. Its finished rounds with
// tool calls record their actions before the next round starts, so a last round with actions is no longer streaming.
const liveIndex = computed(() => {
	const last = steps.value.at(-1)
	return running.value && props.task.stage === 'model' && last && !actions.value.some(action => action.round === last.round)
		? steps.value.length - 1
		: -1
})
const items = computed(() => open.value ? timelineLayout(steps.value, actions.value, props.task.auto_compactions ?? NO_COMPACTIONS) : [])
</script>

<template>
	<details
		class="subagent-row"
		:data-status="status"
		@toggle="open = ($event.target as HTMLDetailsElement).open"
	>
		<summary>
			<Icon
				class="disclosure-icon"
				icon="chevron-right"
			/>
			<span class="subagent-state"><Icon :icon="ICONS[status]" /> {{ statusText }}</span>
			<span
				class="subagent-goal"
				:title="task.goal"
			>{{ task.goal || t('aronaRun.subagent.title') }}</span>
			<span
				v-if="meta.length"
				class="subagent-meta"
			>{{ meta.join(' · ') }}</span>
		</summary>
		<div
			v-if="open"
			class="subagent-body"
		>
			<p
				v-if="task.goal"
				class="subagent-goal-full"
			>
				<strong>{{ t('aronaRun.subagent.goal') }}</strong> {{ task.goal }}
			</p>
			<template
				v-for="item in items"
				:key="item.key"
			>
				<CompactionMarker
					v-if="item.kind === 'compaction'"
					:event="item.event"
					:explain="item.first"
				/>
				<TimelineStep
					v-else-if="item.kind === 'step'"
					:step="item.step"
					:actions="actions"
					:operations="NO_OPERATIONS"
					:live="running && item.index === steps.length - 1"
					:streaming="item.index === liveIndex"
					:hide-text="hideLastText && item.index === steps.length - 1"
					:multi-round="steps.length > 1"
				/>
			</template>
			<template v-if="reply">
				<strong class="subagent-heading">{{ t('aronaRun.subagent.reply') }}</strong>
				<MarkdownBlock
					class="subagent-reply"
					:source="reply"
				/>
			</template>
			<p
				v-if="task.error"
				class="subagent-error"
			>
				<Icon icon="exclamation-circle" />
				<span>{{ task.error }}</span>
			</p>
			<p
				v-if="!steps.length && !reply && !task.error"
				class="subagent-empty"
			>
				{{ running ? t('chat.waiting') : t('chat.unavailable') }}
			</p>
		</div>
	</details>
</template>

<style scoped lang="scss">
.subagent-row {
	min-inline-size: 0;
	margin-block: var(--space-1);
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.subagent-row[data-status='running'] {
	border-inline-start-color: var(--border-strong);
}

// Failed and stopped workers never look like finished ones.
.subagent-row[data-status='failed'] {
	border-inline-start-color: var(--danger);
}

.subagent-row[data-status='stopped'] {
	border-inline-start-style: dashed;
}

summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	min-inline-size: 0;
	min-block-size: var(--target-min);
	list-style: none;
	border-radius: var(--radius-sm);
	cursor: pointer;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.disclosure-icon {
	flex-shrink: 0;
	inline-size: .65em;
	transition: transform var(--motion-fast) var(--ease-standard);
}

.subagent-row[open] > summary > .disclosure-icon {
	transform: rotate(90deg);
}

.subagent-state {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-1);

	svg {
		inline-size: .85em;
	}
}

[data-status='failed'] > summary .subagent-state {
	color: var(--danger-text);
}

// The goal takes the remaining line and clips; the full goal is in the body and the title.
.subagent-goal {
	flex: 1 1 8rem;
	min-inline-size: 0;
	overflow: hidden;
	color: var(--text-secondary);
	font-weight: var(--weight-medium);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.subagent-meta {
	min-inline-size: 0;
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.subagent-body {
	min-inline-size: 0;
	padding-block: var(--space-1) var(--space-2);
}

.subagent-goal-full,
.subagent-error,
.subagent-empty {
	margin: 0 0 var(--space-1);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	strong {
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}
}

.subagent-heading {
	display: block;
	margin-block-start: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
}

.subagent-reply {
	margin-block: var(--space-1) var(--space-2);
}

.subagent-error {
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	color: var(--danger-text);

	svg {
		flex-shrink: 0;
		inline-size: .85em;
	}
}

// Goals and errors come from the model and the backend and may span lines.
.subagent-goal-full,
.subagent-error > span {
	white-space: pre-wrap;
}

@media (width <= 768px) {
	summary {
		min-block-size: 2.75rem;
	}
}
</style>
