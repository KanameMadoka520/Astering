<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Action, ModelStep, Operation} from '@/client/generated'
import {NO_COMPACTIONS, NO_OPERATIONS, NO_SUBAGENTS, rejectedByStep, sameItems, timelineLayout, type AutoCompaction, type SubagentTask} from '@/helpers/aronaTimeline'
import CompactionMarker from './CompactionMarker.vue'
import SubagentRow from './SubagentRow.vue'
import TimelineStep from './TimelineStep.vue'

// Every round stays visible: earlier interim text, thinking and tools never give way to a later round.
// Compactions and subagents sit between rounds as static rows; children receive the same objects every frame.
const props = withDefaults(defineProps<{
	steps: readonly ModelStep[]
	actions: readonly Action[]
	operations: readonly Operation[]
	/** The turn's rejected review decisions; each is shown on the round whose call it answered. */
	rejected?: readonly Operation[]
	running: boolean
	/** Index of the round whose request is still streaming, or -1. */
	streamingIndex: number
	hideLastText: boolean
	compactions?: readonly AutoCompaction[]
	subagents?: readonly SubagentTask[]
}>(), {
	rejected: () => NO_OPERATIONS,
	compactions: () => NO_COMPACTIONS,
	subagents: () => NO_SUBAGENTS,
})
const {t} = useI18n({useScope: 'global'})
const items = computed(() => timelineLayout(props.steps, props.actions, props.compactions, props.subagents))
const last = computed(() => props.steps.length - 1)
// A round whose decisions did not change keeps its previous array.
const rejectedRounds = computed<(readonly Operation[])[]>(previous => rejectedByStep(props.steps, props.actions, props.rejected)
	.map((list, index) => {
		const kept = previous?.[index]
		return kept && sameItems(kept, list) ? kept : list
	}))
</script>

<template>
	<div class="turn-timeline">
		<template
			v-for="item in items"
			:key="item.key"
		>
			<TimelineStep
				v-if="item.kind === 'step'"
				:step="item.step"
				:actions="actions"
				:operations="running && item.index === last ? operations : NO_OPERATIONS"
				:rejected="rejectedRounds[item.index]"
				:live="running && item.index === last"
				:streaming="item.index === streamingIndex"
				:hide-text="hideLastText && item.index === last"
				:multi-round="steps.length > 1"
			/>
			<CompactionMarker
				v-else-if="item.kind === 'compaction'"
				:event="item.event"
				:explain="item.first"
			/>
			<template v-else>
				<p
					v-if="item.first"
					class="timeline-help"
				>
					<Icon icon="sitemap" />
					<span>{{ t('aronaRun.subagent.help') }}</span>
				</p>
				<SubagentRow
					:task="item.task"
					:parent-running="running"
				/>
			</template>
		</template>
	</div>
</template>

<style scoped lang="scss">
.turn-timeline {
	min-inline-size: 0;
}

.timeline-help {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	margin: var(--space-2) 0 var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	svg {
		flex-shrink: 0;
		inline-size: .85em;
	}
}
</style>
