<template>
	<section
		class="routine-history"
		:aria-labelledby="headingId"
		:aria-busy="isLoadingMonth || undefined"
	>
		<div class="routine-history__header">
			<h3
				:id="headingId"
				class="routine-history__title"
			>
				<Icon
					:icon="['far', 'calendar-check']"
					class="routine-history__title-icon"
				/>
				{{ $t('task.routine.history.title') }}
			</h3>
			<div class="routine-history__nav">
				<BaseButton
					v-tooltip="$t('task.routine.history.previousMonth')"
					class="routine-history__step"
					:aria-label="$t('task.routine.history.previousMonth')"
					:aria-disabled="!canGoBack || undefined"
					@click="step(-1)"
				>
					<Icon
						icon="angle-left"
						class="is-mirrored-rtl"
					/>
				</BaseButton>
				<span
					class="routine-history__month"
					aria-live="polite"
				>{{ monthLabel }}</span>
				<BaseButton
					v-tooltip="$t('task.routine.history.nextMonth')"
					class="routine-history__step"
					:aria-label="$t('task.routine.history.nextMonth')"
					:aria-disabled="!canGoForward || undefined"
					@click="step(1)"
				>
					<Icon
						icon="angle-right"
						class="is-mirrored-rtl"
					/>
				</BaseButton>
			</div>
		</div>

		<div
			v-if="showSkeleton"
			class="routine-history__skeleton"
		>
			<span
				class="is-sr-only"
				role="status"
			>{{ $t('misc.loading') }}</span>
			<span
				class="routine-skeleton routine-skeleton--stats"
				aria-hidden="true"
			/>
			<span
				class="routine-skeleton routine-skeleton--grid"
				aria-hidden="true"
			/>
		</div>

		<LoadError
			v-else-if="error && !history"
			class="routine-history__error"
			:retry="retry"
		/>

		<template v-else>
			<dl class="routine-history__stats">
				<div class="routine-stat">
					<dt>{{ $t('task.routine.history.monthCount') }}</dt>
					<dd>{{ history ? completions(monthCompletions) : '–' }}</dd>
				</div>
				<div class="routine-stat">
					<dt>{{ $t('task.routine.history.currentStreak') }}</dt>
					<dd>{{ totals ? counts(totals.current_streak) : '–' }}</dd>
				</div>
				<div class="routine-stat">
					<dt>{{ $t('task.routine.history.longestStreak') }}</dt>
					<dd>{{ totals ? counts(totals.longest_streak) : '–' }}</dd>
				</div>
				<div class="routine-stat">
					<dt>{{ $t('task.routine.history.total') }}</dt>
					<dd>{{ totals ? completions(totals.total_checkins) : '–' }}</dd>
				</div>
			</dl>

			<table
				v-if="showDailyCalendar"
				class="routine-calendar"
				:class="{'is-loading': !history}"
			>
				<caption class="is-sr-only">
					{{ $t('task.routine.history.calendarCaption', {month: monthLabel}) }}
				</caption>
				<thead>
					<tr>
						<th
							v-for="weekday in weekdays"
							:key="weekday.index"
							scope="col"
							class="routine-calendar__weekday"
						>
							<span aria-hidden="true">{{ weekday.narrow }}</span>
							<span class="is-sr-only">{{ weekday.long }}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="(week, row) in weeks"
						:key="row"
					>
						<td
							v-for="(cell, column) in week"
							:key="cell?.date ?? `empty-${row}-${column}`"
							class="routine-calendar__cell"
						>
							<div
								v-if="cell"
								class="routine-day"
								:data-date="cell.date"
								:data-checked="checkedDates.has(cell.date) || undefined"
								:data-today="cell.date === today || undefined"
								:data-future="cell.date > today || undefined"
							>
								<span
									class="routine-day__number"
									aria-hidden="true"
								>{{ cell.day }}</span>
								<Icon
									v-if="checkedDates.has(cell.date)"
									icon="check"
									class="routine-day__mark"
								/>
								<span class="is-sr-only">{{ cellLabel(cell.date) }}</span>
							</div>
						</td>
					</tr>
				</tbody>
			</table>

			<p
				v-if="showDailyCalendar"
				class="routine-history__legend"
				aria-hidden="true"
			>
				<span class="routine-legend">
					<span class="routine-legend__swatch is-checked"><Icon icon="check" /></span>
					{{ $t('task.routine.history.legendChecked') }}
				</span>
				<span class="routine-legend">
					<span class="routine-legend__swatch is-today" />
					{{ $t('task.routine.history.legendToday') }}
				</span>
			</p>

			<RoutinePeriodRecords :periods="history?.periods ?? []" />
			<h4
				v-if="showDailyCalendar"
				class="routine-history__records-title"
			>
				{{ $t('task.routine.history.records') }}
			</h4>
			<p
				v-if="!history"
				class="routine-history__empty"
				role="status"
			>
				{{ $t('misc.loading') }}
			</p>
			<p
				v-else-if="records.length === 0 && !history.periods.length"
				class="routine-history__empty"
			>
				{{ $t('task.routine.history.empty') }}
			</p>
			<ol
				v-else-if="records.length"
				class="routine-history__records"
			>
				<li
					v-for="item in records"
					:key="item.date"
					class="routine-record"
					:data-date="item.date"
				>
					<Icon
						icon="circle-check"
						class="routine-record__icon"
					/>
					<span class="routine-record__date">{{ format.day(item.date) }}</span>
					<span class="routine-record__meta">
						<span class="routine-record__time">
							{{ $t('task.routine.history.recordTime', {
								time: format.time(item.completed_at, item.timezone),
								timezone: format.zone(item.timezone),
							}) }}
						</span>
						<span class="routine-record__by">
							<Icon
								icon="user"
								class="routine-record__by-icon"
							/>
							{{ $t('task.routine.history.recordBy', {user: format.operator(item.completed_by_id)}) }}
						</span>
					</span>
				</li>
			</ol>
			<p class="routine-history__note">
				{{ $t('task.routine.history.note') }}
			</p>
		</template>
	</section>
</template>

<script setup lang="ts">
import {computed, ref, shallowRef, useId, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import BaseButton from '@/components/base/BaseButton.vue'
import Icon from '@/components/misc/Icon'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {TaskRoutineHistoryResponse} from '@/client/queries/taskRoutines'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useTaskRoutineHistory} from '@/composables/useTaskRoutine'
import {weekdayOrder} from '@/helpers/time/calendarGrid'
import {formatCalendarMonth} from '@/helpers/projectHistoryFormat'
import {routineMonth, routineToday, type TaskRoutineSummary} from '@/helpers/taskRoutine'
import {useAuthStore} from '@/stores/auth'
import {useRoutineFormat} from './useRoutineFormat'
import RoutinePeriodRecords from './RoutinePeriodRecords.vue'
import {isLegacyRoutine, localDate} from '@/helpers/taskRoutine'

type MonthRef = {year: number, month: number}
type CalendarDay = {date: string, day: number}

const props = withDefaults(defineProps<{
	taskId: number
	routine: TaskRoutineSummary
	// When the routine was first configured; no record can be older, so paging back stops there.
	since?: string
}>(), {
	since: '',
})

const {t, locale} = useI18n({useScope: 'global'})
const {now} = useGlobalNow()
const authStore = useAuthStore()
const format = useRoutineFormat()
const headingId = useId()

const today = computed(() => localDate(now.value, props.routine.timezone) || routineToday(props.routine, now.value))
const latest = computed(() => routineMonth(props.routine, now.value))
const earliest = computed<MonthRef>(() => {
	const created = Date.parse(props.since)
	if (Number.isNaN(created) || created <= 0) return {year: 1970, month: 1}
	// A recorded week/month can start before configuration, with a further day for timezone offsets.
	const start = new Date(created - 32 * 86_400_000)
	return {year: start.getUTCFullYear(), month: start.getUTCMonth() + 1}
})

const monthIndex = (value: MonthRef) => value.year * 12 + value.month - 1

const periodMonth = computed<MonthRef>(() => {
	const [year, month] = props.routine.date.split('-').map(Number)
	return year && month ? {year, month} : latest.value
})
// Start with the current period's record, including a week/month anchored in the previous month.
const picked = ref<MonthRef | null>(null)
const shown = computed<MonthRef>(() => {
	const desired = picked.value ?? periodMonth.value
	return monthIndex(desired) <= monthIndex(latest.value) ? desired : latest.value
})

const canGoBack = computed(() => monthIndex(shown.value) > monthIndex(earliest.value))
const canGoForward = computed(() => monthIndex(shown.value) < monthIndex(latest.value))

function step(delta: number) {
	if (delta < 0 ? !canGoBack.value : !canGoForward.value) return
	const index = monthIndex(shown.value) + delta
	picked.value = {
		year: Math.floor(index / 12),
		month: index % 12 + 1,
	}
}

const {history, isPending, error, refetch} = useTaskRoutineHistory(
	() => props.taskId,
	() => shown.value.year,
	() => shown.value.month,
)

// Streaks and the total cover every month, so the last answer stays on screen while another month loads.
const totals = shallowRef<TaskRoutineHistoryResponse>()
watch(history, value => {
	if (value) totals.value = value
}, {immediate: true})

const showSkeleton = computed(() => isPending.value && !history.value && !totals.value)
const isLoadingMonth = computed(() => isPending.value && !history.value)

function retry() {
	void refetch()
}

const checkedDates = computed(() => new Set(history.value?.items.map(item => item.date) ?? []))

const records = computed(() => [...(history.value?.items ?? [])].sort((a, b) => b.date.localeCompare(a.date)))
const showDailyCalendar = computed(() => isLegacyRoutine(props.routine) || records.value.length > 0)
const monthCompletions = computed(() => records.value.length
	+ (history.value?.periods.filter(period => period.completed_at).length ?? 0))

const monthLabel = computed(() => formatCalendarMonth(shown.value.year, shown.value.month - 1, locale.value, {
	month: 'long',
	year: 'numeric',
}))

const weekStart = computed(() => authStore.settings.week_start ?? 1)

// 2024-01-07 is a Sunday, so index 0 is Sunday as in Date#getUTCDay.
const weekdays = computed(() => weekdayOrder(weekStart.value).map(index => {
	const date = new Date(Date.UTC(2024, 0, 7 + index))
	return {
		index,
		narrow: new Intl.DateTimeFormat(locale.value, {
			weekday: 'narrow',
			timeZone: 'UTC',
		}).format(date),
		long: new Intl.DateTimeFormat(locale.value, {
			weekday: 'long',
			timeZone: 'UTC',
		}).format(date),
	}
}))

const pad = (value: number) => String(value).padStart(2, '0')

// Plain calendar days built in UTC, so no viewer offset or DST change can shift a day.
const weeks = computed(() => {
	const {year, month} = shown.value
	const first = new Date(Date.UTC(year, month - 1, 1))
	const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
	const lead = (first.getUTCDay() - weekStart.value + 7) % 7
	const cells: (CalendarDay | null)[] = Array.from({length: lead}, () => null)
	for (let day = 1; day <= length; day++) {
		cells.push({
			date: `${year}-${pad(month)}-${pad(day)}`,
			day,
		})
	}
	while (cells.length % 7 !== 0) cells.push(null)
	return Array.from({length: cells.length / 7}, (_, row) => cells.slice(row * 7, row * 7 + 7))
})

function cellLabel(date: string): string {
	const label = format.day(date, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
	})
	if (!history.value || date > today.value) return label
	const checked = checkedDates.value.has(date)
	if (date === today.value) {
		return t(checked ? 'task.routine.history.dayTodayChecked' : 'task.routine.history.dayTodayNotChecked', {date: label})
	}
	return t(checked ? 'task.routine.history.dayChecked' : 'task.routine.history.dayNotChecked', {date: label})
}

function counts(count: number): string {
	return t(isLegacyRoutine(props.routine) ? 'task.routine.history.days' : 'routineSchedule.periodCount', {n: count}, count)
}

function completions(count: number): string {
	return t('task.routine.history.completionCount', {n: count}, count)
}
</script>

<style lang="scss" scoped>
.routine-history {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	min-inline-size: 0;
}

.routine-history__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-3);
}

.routine-history__title {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.routine-history__title-icon {
	inline-size: .875rem;
	color: var(--text-tertiary);
}

.routine-history__nav {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.routine-history__step {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: max(2rem, var(--target-min));
	block-size: max(2rem, var(--target-min));
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover:not([aria-disabled='true']) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}

	&[aria-disabled='true'] {
		opacity: .4;
		cursor: default;
	}
}

.routine-history__month {
	min-inline-size: 8.5rem;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	text-align: center;
	font-variant-numeric: tabular-nums;
}

.routine-history__stats {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: var(--space-2);
	margin: 0;

	@media screen and (max-width: $tablet) {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}

.routine-stat {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-inline-size: 0;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);

	dt {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
}

// Seven columns at every width: on phones the cells shrink, the grid never scrolls sideways.
.routine-calendar {
	inline-size: 100%;
	max-inline-size: 26rem;
	table-layout: fixed;
	border-collapse: separate;
	border-spacing: 2px;
	transition: opacity var(--motion-fast) var(--ease-standard);

	&.is-loading {
		opacity: .6;
	}
}

.routine-calendar__weekday {
	padding: 0 0 var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	text-align: center;
}

.routine-calendar__cell {
	padding: 0;
	vertical-align: top;
}

.routine-day {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 1px;
	min-block-size: 2.25rem;
	border: 1px solid transparent;
	border-radius: var(--radius-sm);
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;

	@media (pointer: coarse) {
		min-block-size: 2.75rem;
	}

	&[data-checked] {
		border-color: hsla(var(--success-h), var(--success-s), var(--success-l), .45);
		background: var(--tint-success);
		font-weight: var(--weight-semibold);
	}

	&[data-today] {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	&[data-future] {
		color: var(--text-tertiary);
	}
}

.routine-day__number {
	line-height: 1;
}

.routine-day__mark {
	inline-size: .625rem;
	block-size: .625rem;
	color: var(--success);
}

.routine-history__legend {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-4);
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.routine-legend {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.routine-legend__swatch {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: .875rem;
	block-size: .875rem;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-xs);

	&.is-checked {
		border-color: hsla(var(--success-h), var(--success-s), var(--success-l), .45);
		background: var(--tint-success);
		color: var(--success);
		font-size: .5rem;
	}

	&.is-today {
		border: 2px solid var(--primary);
	}
}

.routine-history__records-title {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.routine-history__records {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
}

.routine-record {
	display: grid;
	grid-template-columns: auto minmax(0, 10rem) minmax(0, 1fr);
	align-items: center;
	gap: var(--space-1) var(--space-3);
	margin: 0;
	padding: var(--space-2) 0;
	border-block-start: 1px solid var(--border-subtle);
	font-size: var(--text-sm);

	&:first-child {
		border-block-start: 0;
	}

	@media screen and (max-width: $tablet) {
		grid-template-columns: auto minmax(0, 1fr);

		.routine-record__meta {
			grid-column: 2;
		}
	}
}

.routine-record__icon {
	color: var(--success);
}

.routine-record__date {
	color: var(--text-primary);
	font-weight: var(--weight-medium);
}

.routine-record__meta {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	min-inline-size: 0;
	color: var(--text-secondary);
	overflow-wrap: anywhere;
}

.routine-record__time {
	font-variant-numeric: tabular-nums;
}

.routine-record__by {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.routine-record__by-icon {
	inline-size: .75rem;
	color: var(--text-tertiary);
}

.routine-history__empty,
.routine-history__note {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.routine-history__note {
	font-size: var(--text-xs);
}

.routine-history__skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.routine-skeleton {
	display: block;
	border-radius: var(--radius-sm);
	background: var(--surface-active);

	&--stats {
		block-size: 3.25rem;
	}

	&--grid {
		max-inline-size: 26rem;
		block-size: 14rem;
	}
}
</style>
