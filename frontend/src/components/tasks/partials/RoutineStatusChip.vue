<template>
	<span
		v-if="status"
		class="routine-status"
		:class="`is-${status}`"
		:data-routine-status="status"
	>
		<Icon
			:icon="icon"
			class="routine-status__icon"
		/>{{ label }}
	</span>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import Icon from '@/components/misc/Icon'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {isLegacyRoutine, routineOf, routineStatus, type RawTaskRoutine} from '@/helpers/taskRoutine'

const props = defineProps<{
	task: {routine?: RawTaskRoutine | null}
}>()

const {t} = useI18n({useScope: 'global'})
const {now} = useGlobalNow()

// Recomputed on the shared minute tick, so the chip turns back to "pending" at the routine's midnight.
const status = computed(() => routineStatus(routineOf(props.task), now.value))

const icon = computed<IconProp>(() => {
	switch (status.value) {
		case 'done': return 'circle-check'
		case 'paused': return 'pause'
		default: return ['far', 'sun']
	}
})

const label = computed(() => {
	const routine = routineOf(props.task)
	if (routine && !isLegacyRoutine(routine)) {
		if (status.value === 'paused') return t('task.routine.status.paused')
		return t('routineSchedule.chip', {
			amount: status.value === 'pending' && Date.parse(routine.next_reset_at) <= now.value.getTime()
				? 0 : routine.current_amount,
			target: routine.target,
			unit: routine.unit,
			period: t(`routineSchedule.${routine.period}`),
		})
	}
	switch (status.value) {
		case 'done': return t('task.routine.status.done')
		case 'paused': return t('task.routine.status.paused')
		default: return t('task.routine.status.pending')
	}
})
</script>

<style lang="scss" scoped>
// Icon and text carry the state; the tint only supports them. Distinct from the repeat ("history") icon.
.routine-status {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	padding: 1px var(--space-2);
	border: 1px solid transparent;
	border-radius: var(--radius-full);
	color: var(--text-primary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-normal);
	max-inline-size: 100%;
	white-space: normal;
	overflow-wrap: anywhere;

	&.is-pending {
		border-color: hsla(var(--warning-h), var(--warning-s), var(--warning-l), .45);
		background: var(--tint-warning);

		.routine-status__icon {
			color: var(--warning);
		}
	}

	&.is-done {
		border-color: hsla(var(--success-h), var(--success-s), var(--success-l), .35);
		background: var(--tint-success);

		.routine-status__icon {
			color: var(--success);
		}
	}

	&.is-paused {
		border-color: var(--border-default);
		background: var(--surface-active);
		color: var(--text-secondary);
	}
}

.routine-status__icon {
	inline-size: .625rem;
	block-size: .625rem;
}
</style>
