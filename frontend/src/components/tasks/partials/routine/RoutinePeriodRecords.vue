<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {RoutinePeriodRecord} from '@/client/queries/taskRoutines'
import {useRoutineFormat} from './useRoutineFormat'

const props = defineProps<{periods: RoutinePeriodRecord[]}>()
const {t, locale} = useI18n({useScope: 'global'})
const format = useRoutineFormat()
const numbers = computed(() => new Intl.NumberFormat(locale.value))
const records = computed(() => [...props.periods].sort((a, b) =>
	b.period_start_at.localeCompare(a.period_start_at) || b.id - a.id))
</script>

<template>
	<section
		v-if="records.length"
		class="routine-period-records"
		:aria-label="t('routineSchedule.records')"
	>
		<h4>{{ t('routineSchedule.records') }}</h4>
		<p>{{ t('routineSchedule.recordsHint') }}</p>
		<ol>
			<li
				v-for="record in records"
				:key="record.id"
				:data-routine-period="record.id"
			>
				<div class="routine-period-records__header">
					<strong>{{ t(`routineSchedule.${record.period}`) }}</strong>
					<span>{{ t('routineSchedule.amount', {
						amount: numbers.format(record.amount),
						target: numbers.format(record.target),
						unit: record.unit,
					}) }}</span>
					<span :class="{'is-completed': record.completed_at}">
						{{ t(record.completed_at ? 'routineSchedule.reached' : 'routineSchedule.incomplete') }}
					</span>
				</div>
				<p>
					{{ t('routineSchedule.periodInfo', {
						start: format.instant(record.period_start_at, record.timezone),
						end: format.instant(record.period_end_at, record.timezone),
						timezone: format.zone(record.timezone),
					}) }}
				</p>
				<p v-if="record.completed_at">
					{{ t('routineSchedule.completedRecord', {
						time: format.instant(record.completed_at, record.timezone),
						user: format.operator(record.completed_by_id),
					}) }}
				</p>
				<p v-else>
					{{ t('routineSchedule.updatedRecord', {
						time: format.instant(record.updated, record.timezone),
						user: format.operator(record.updated_by_id),
					}) }}
				</p>
			</li>
		</ol>
	</section>
</template>

<style lang="scss" scoped>
.routine-period-records {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;

	h4,
	p {
		margin: 0;
	}

	p {
		color: var(--text-secondary);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	ol {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}
}

.routine-period-records__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;

	.is-completed {
		color: var(--success);
	}
}
</style>
