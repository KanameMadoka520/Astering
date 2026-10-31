<script setup lang="ts">
import {computed, nextTick, ref, useId, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import type {ProjectTimelineDay} from '@/client/generated'
import {projectCalendar} from '@/helpers/projectCalendar'
import {calendarDayFormatter, formatCalendarMonth, heatLevel, HEAT_LEVELS} from '@/helpers/projectHistoryFormat'
import {dateFromDayNumber, dayNumber, timelineDayState} from '@/helpers/projectTimeline'

const props = defineProps<{
	year: number
	days: Record<string, ProjectTimelineDay>
	today?: string
	selectedDay: string
	month: number | null
}>()

const emit = defineEmits<{
	selectDay: [date: string]
	selectMonth: [month: number | null]
}>()

const {t, locale} = useI18n({useScope: 'global'})

const calendar = computed(() => projectCalendar(props.year))
const weeks = computed(() => (calendar.value.at(-1)?.week ?? 52) + 1)
const maxProjects = computed(() => Math.max(1, ...Object.values(props.days).map(d => d.scheduled_projects ?? 0)))

const todayInYear = computed(() => props.today?.startsWith(`${props.year}-`) ? props.today : undefined)
const currentMonthIndex = computed(() => todayInYear.value ? Number(todayInYear.value.slice(5, 7)) - 1 : null)

// The month calendar follows the zoomed month, then the selected day, then today.
const shownMonth = computed(() => {
	if (props.month !== null) return props.month
	if (props.selectedDay) return Number(props.selectedDay.slice(5, 7)) - 1
	if (currentMonthIndex.value !== null) return currentMonthIndex.value
	const first = Object.keys(props.days).filter(d => props.days[d].scheduled_projects || props.days[d].deadlines).sort()[0]
	return first ? Number(first.slice(5, 7)) - 1 : 0
})

const monthNames = computed(() => Array.from({length: 12}, (_, index) => ({
	short: formatCalendarMonth(props.year, index, locale.value),
	long: formatCalendarMonth(props.year, index, locale.value, {
		month: 'long',
		year: 'numeric',
	}),
	firstWeek: calendar.value.find(d => d.month === index)?.week ?? 0,
})))

const weekdayNames = computed(() => Array.from({length: 7}, (_, index) => ({
	narrow: new Intl.DateTimeFormat(locale.value, {
		weekday: 'narrow',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2024, 0, 1 + index))),
	long: new Intl.DateTimeFormat(locale.value, {
		weekday: 'long',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2024, 0, 1 + index))),
})))

const formatDay = computed(() => calendarDayFormatter(locale.value, {
	weekday: 'short',
	month: 'short',
	day: 'numeric',
}))

function cellInfo(date: string) {
	const day = props.days[date]
	const state = timelineDayState(date, props.today, day)
	const projects = day?.scheduled_projects ?? 0
	const deadlines = day?.deadlines ?? 0
	const details: string[] = []
	if (state === 'none') {
		details.push(t('projectTimeline.day.none'))
	} else {
		details.push(t('projectTimeline.day.projects', {n: projects}, projects))
		details.push(t(`projectTimeline.day.${state}`))
	}
	if (deadlines) {
		const projectsDue = day?.deadline_projects ?? 0
		const text = t('projectTimeline.day.deadlines', {n: deadlines}, deadlines)
		details.push(projectsDue
			? t('projectTimeline.day.deadlinesIn', {
				deadlines: text,
				projects: t('projectTimeline.day.deadlineProjects', {n: projectsDue}, projectsDue),
			})
			: text)
	}
	if (date === props.today) details.push(t('projectTimeline.day.today'))
	return {
		state,
		level: state === 'none' ? 0 : heatLevel(projects, maxProjects.value),
		deadlines,
		label: t('projectTimeline.day.label', {
			date: formatDay.value(date),
			details: details.join(t('projectTimeline.day.separator')),
		}),
	}
}

const cells = computed(() => new Map(calendar.value.map(d => [d.date, cellInfo(d.date)])))

const yearRows = computed(() => Array.from({length: 7}, (_, weekday) =>
	calendar.value.filter(d => d.weekday === weekday)))

const monthDays = computed(() => calendar.value.filter(d => d.month === shownMonth.value))
const monthWeeks = computed(() => {
	const rows: (typeof calendar.value[number] | null)[][] = []
	let row: (typeof calendar.value[number] | null)[] = Array.from({length: monthDays.value[0]?.weekday ?? 0}, () => null)
	for (const day of monthDays.value) {
		row.push(day)
		if (row.length === 7) {
			rows.push(row)
			row = []
		}
	}
	if (row.length) rows.push([...row, ...Array.from({length: 7 - row.length}, () => null)])
	return rows
})

// Each grid has one roving tab stop; the month grid falls back to a day of the month it shows.
const activeDate = ref('')
watch(() => [props.year, props.selectedDay] as const, () => {
	activeDate.value = props.selectedDay || todayInYear.value || `${props.year}-01-01`
}, {immediate: true})

const monthActive = computed(() => {
	const prefix = `${props.year}-${String(shownMonth.value + 1).padStart(2, '0')}-`
	return [activeDate.value, props.selectedDay, props.today ?? ''].find(date => date.startsWith(prefix)) ?? `${prefix}01`
})

const root = ref<HTMLElement | null>(null)
let pendingFocus: {date: string, grid: 'year' | 'month'} | null = null

function focusCell(date: string, grid: 'year' | 'month') {
	const cell = root.value?.querySelector<HTMLElement>(`[data-grid="${grid}"] [data-date="${date}"]`)
	if (cell) {
		cell.focus()
		pendingFocus = null
	} else {
		pendingFocus = {date, grid}
	}
}

// Moving past the edge of the month calendar switches its month first; focus follows once it renders.
watch(shownMonth, async () => {
	await nextTick()
	if (pendingFocus) focusCell(pendingFocus.date, pendingFocus.grid)
})

function clampToYear(day: number) {
	const first = dayNumber(`${props.year}-01-01`)
	const last = dayNumber(`${props.year}-12-31`)
	return dateFromDayNumber(Math.min(last, Math.max(first, day)))
}

function lastOfMonth(date: string) {
	return dateFromDayNumber(Math.floor(Date.UTC(props.year, Number(date.slice(5, 7)), 0) / 86_400_000))
}

function addMonths(date: string, delta: number) {
	const month = Number(date.slice(5, 7)) - 1 + delta
	const target = new Date(Date.UTC(props.year, month, 1))
	if (target.getUTCFullYear() !== props.year) return date
	const lastDay = new Date(Date.UTC(props.year, month + 1, 0)).getUTCDate()
	const day = Math.min(Number(date.slice(8, 10)), lastDay)
	return dateFromDayNumber(Math.floor(Date.UTC(props.year, month, day) / 86_400_000))
}

function onKeydown(event: KeyboardEvent, date: string, grid: 'year' | 'month') {
	const rtl = getComputedStyle(event.currentTarget as HTMLElement).direction === 'rtl'
	const horizontal = grid === 'year' ? 7 : 1
	const vertical = grid === 'year' ? 1 : 7
	const current = dayNumber(date)
	let next: string
	switch (event.key) {
		case 'ArrowRight':
			next = clampToYear(current + (rtl ? -horizontal : horizontal))
			break
		case 'ArrowLeft':
			next = clampToYear(current - (rtl ? -horizontal : horizontal))
			break
		case 'ArrowDown':
			next = clampToYear(current + vertical)
			break
		case 'ArrowUp':
			next = clampToYear(current - vertical)
			break
		case 'PageDown':
			next = addMonths(date, 1)
			break
		case 'PageUp':
			next = addMonths(date, -1)
			break
		case 'Home':
			next = event.ctrlKey || event.metaKey ? `${props.year}-01-01` : `${date.slice(0, 8)}01`
			break
		case 'End':
			next = event.ctrlKey || event.metaKey ? `${props.year}-12-31` : lastOfMonth(date)
			break
		case 'Enter':
		case ' ':
			event.preventDefault()
			emit('selectDay', date)
			return
		default:
			return
	}
	event.preventDefault()
	activeDate.value = next
	const nextMonth = Number(next.slice(5, 7)) - 1
	if (grid === 'month' && nextMonth !== shownMonth.value) {
		pendingFocus = {date: next, grid}
		emit('selectMonth', nextMonth)
		return
	}
	const target = next
	void nextTick(() => focusCell(target, grid))
}

function choose(date: string) {
	activeDate.value = date
	emit('selectDay', date)
}

function stepMonth(delta: number) {
	const next = shownMonth.value + delta
	if (next < 0 || next > 11) return
	emit('selectMonth', next)
}

const headingId = useId()
</script>

<template>
	<section
		ref="root"
		class="timeline-occupancy"
		:aria-labelledby="headingId"
	>
		<header class="occupancy-header">
			<h2
				:id="headingId"
				class="occupancy-title"
			>
				{{ month === null
					? t('projectTimeline.occupancy.heading', {year})
					: t('projectTimeline.occupancy.monthHeading', {month: monthNames[month].long}) }}
			</h2>
			<button
				v-if="month !== null"
				type="button"
				class="occupancy-chip"
				@click="emit('selectMonth', null)"
			>
				<Icon
					icon="angle-left"
					class="occupancy-chip-icon"
				/>
				{{ t('projectTimeline.occupancy.wholeYear') }}
			</button>
		</header>

		<div class="occupancy-body">
			<div
				class="year-view"
				:style="{'--weeks': weeks}"
			>
				<div class="year-months">
					<button
						v-for="(name, index) in monthNames"
						:key="index"
						type="button"
						class="year-month"
						:class="{'is-current': index === currentMonthIndex}"
						:style="{gridColumn: `${name.firstWeek + 2} / span 4`}"
						:aria-pressed="month === index"
						:aria-label="t('projectTimeline.occupancy.showMonth', {month: name.long})"
						@click="emit('selectMonth', month === index ? null : index)"
					>
						{{ name.short }}
					</button>
				</div>
				<div
					class="occupancy-year-grid"
					role="grid"
					data-grid="year"
					:aria-labelledby="headingId"
					:aria-describedby="`${headingId}-help`"
				>
					<div
						v-for="(row, weekday) in yearRows"
						:key="weekday"
						role="row"
						class="year-row"
					>
						<span
							role="rowheader"
							class="year-weekday"
							:style="{gridRow: weekday + 1}"
							:aria-label="weekdayNames[weekday].long"
						>{{ weekday % 2 === 0 ? weekdayNames[weekday].narrow : '' }}</span>
						<span
							v-for="d in row"
							:key="d.date"
							role="gridcell"
							class="day-cell"
							:data-date="d.date"
							:data-state="cells.get(d.date)!.state"
							:data-level="cells.get(d.date)!.level"
							:data-today="d.date === today || undefined"
							:data-dim="month !== null && d.month !== month ? true : undefined"
							:style="{gridColumn: d.week + 2, gridRow: weekday + 1}"
							:aria-label="cells.get(d.date)!.label"
							:title="cells.get(d.date)!.label"
							:aria-selected="selectedDay === d.date"
							:tabindex="activeDate === d.date ? 0 : -1"
							@click="choose(d.date)"
							@focus="activeDate = d.date"
							@keydown="onKeydown($event, d.date, 'year')"
						>
							<i
								v-if="cells.get(d.date)!.deadlines"
								class="deadline-dot"
								aria-hidden="true"
							/>
						</span>
					</div>
				</div>
			</div>

			<div class="month-view">
				<div class="month-nav">
					<button
						type="button"
						class="month-step"
						:disabled="shownMonth <= 0"
						:aria-label="t('projectTimeline.occupancy.previousMonth')"
						:title="t('projectTimeline.occupancy.previousMonth')"
						@click="stepMonth(-1)"
					>
						<Icon
							icon="angle-left"
							class="month-step-icon"
						/>
					</button>
					<button
						type="button"
						class="month-name"
						:aria-pressed="month === shownMonth"
						:aria-label="t('projectTimeline.occupancy.showMonth', {month: monthNames[shownMonth].long})"
						@click="emit('selectMonth', month === shownMonth ? null : shownMonth)"
					>
						{{ monthNames[shownMonth].long }}
					</button>
					<button
						type="button"
						class="month-step"
						:disabled="shownMonth >= 11"
						:aria-label="t('projectTimeline.occupancy.nextMonth')"
						:title="t('projectTimeline.occupancy.nextMonth')"
						@click="stepMonth(1)"
					>
						<Icon
							icon="angle-right"
							class="month-step-icon"
						/>
					</button>
				</div>
				<div
					class="occupancy-month-grid"
					role="grid"
					data-grid="month"
					:aria-label="monthNames[shownMonth].long"
					:aria-describedby="`${headingId}-help`"
				>
					<div
						role="row"
						class="month-row month-weekdays"
					>
						<span
							v-for="(weekday, index) in weekdayNames"
							:key="index"
							role="columnheader"
							class="month-weekday"
							:aria-label="weekday.long"
						>{{ weekday.narrow }}</span>
					</div>
					<div
						v-for="(week, index) in monthWeeks"
						:key="index"
						role="row"
						class="month-row"
					>
						<template
							v-for="(d, slot) in week"
							:key="d?.date ?? `empty-${index}-${slot}`"
						>
							<span
								v-if="d"
								role="gridcell"
								class="day-cell month-day"
								:data-date="d.date"
								:data-state="cells.get(d.date)!.state"
								:data-level="cells.get(d.date)!.level"
								:data-today="d.date === today || undefined"
								:aria-label="cells.get(d.date)!.label"
								:aria-selected="selectedDay === d.date"
								:tabindex="monthActive === d.date ? 0 : -1"
								@click="choose(d.date)"
								@focus="activeDate = d.date"
								@keydown="onKeydown($event, d.date, 'month')"
							>
								<span
									class="month-day-number"
									aria-hidden="true"
								>{{ d.day }}</span>
								<i
									v-if="cells.get(d.date)!.deadlines"
									class="deadline-dot"
									aria-hidden="true"
								/>
							</span>
							<span
								v-else
								role="gridcell"
								class="month-day is-empty"
								aria-hidden="true"
							/>
						</template>
					</div>
				</div>
			</div>
		</div>

		<div class="occupancy-legend">
			<span class="legend-item">
				<i
					class="day-cell legend-swatch"
					data-state="elapsed"
					data-level="3"
				/>{{ t('projectTimeline.legend.elapsed') }}
			</span>
			<span class="legend-item">
				<i
					class="day-cell legend-swatch"
					data-state="planned"
					data-level="3"
				/>{{ t('projectTimeline.legend.planned') }}
			</span>
			<span class="legend-item">
				<i
					class="day-cell legend-swatch"
					data-state="unelapsed"
					data-level="3"
				/>{{ t('projectTimeline.legend.unelapsed') }}
			</span>
			<span class="legend-item">
				<i class="day-cell legend-swatch is-deadline"><i class="deadline-dot" /></i>{{ t('projectTimeline.legend.deadline') }}
			</span>
			<span class="legend-item">
				<i class="day-cell legend-swatch is-today" />{{ t('projectTimeline.legend.today') }}
			</span>
			<span
				class="legend-item legend-scale"
				aria-hidden="true"
			>
				{{ t('projectHistory.less') }}
				<i
					v-for="n in HEAT_LEVELS.slice(1)"
					:key="n"
					class="day-cell legend-swatch"
					data-state="elapsed"
					:data-level="n"
				/>
				{{ t('projectHistory.more') }}
			</span>
		</div>
		<p
			:id="`${headingId}-help`"
			class="occupancy-help"
		>
			{{ t('projectTimeline.legend.note') }} {{ t('projectTimeline.occupancy.help') }}
		</p>
	</section>
</template>

<style scoped lang="scss">
.timeline-occupancy {
	// Cell ramp by number of projects; hue = state, the hatch marks days still ahead.
	--cell-empty: var(--surface-sunken);
	--cell-elapsed: var(--primary);
	--cell-stroke-elapsed: hsl(var(--primary-h), var(--primary-s), 45%);
	--cell-stroke-unelapsed: var(--grey-500);

	container-type: inline-size;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.occupancy-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	margin-block-end: var(--space-3);
}

.occupancy-title {
	margin: 0;
	font-size: var(--text-lg);
}

.occupancy-chip,
.month-name,
.month-step,
.year-month {
	border: 1px solid transparent;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	font: inherit;
	cursor: pointer;
	transition: background-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);

	&:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&[aria-pressed='true'] {
		background: var(--surface-selected);
		color: var(--accent-text);
		font-weight: var(--weight-semibold);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}

	&:disabled {
		opacity: .4;
		cursor: default;
	}
}

.occupancy-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--control-height-sm);
	padding-inline: var(--space-2);
	border-color: var(--border-default);
	font-size: var(--text-sm);
}

.occupancy-chip-icon:dir(rtl),
.month-step-icon:dir(rtl) {
	transform: scaleX(-1);
}

.occupancy-body {
	display: grid;
	gap: var(--space-4);
	align-items: start;

	@container (min-width: 60rem) {
		grid-template-columns: minmax(0, 1fr) 15rem;
	}
}

// Year grid: one column per week, one row per weekday.
.year-view {
	display: none;
	min-inline-size: 0;

	@container (min-width: 44rem) {
		display: block;
	}
}

.year-months,
.occupancy-year-grid {
	display: grid;
	grid-template-columns: 1.25rem repeat(var(--weeks), minmax(0, 1fr));
	column-gap: 3px;
}

.year-months {
	margin-block-end: var(--space-1);
}

.year-month {
	grid-row: 1;
	padding: 0 var(--space-1);
	min-block-size: 1.5rem;
	font-size: var(--text-xs);
	text-align: start;
	white-space: nowrap;
	justify-self: start;

	&.is-current:not([aria-pressed='true']) {
		color: var(--text-primary);
		font-weight: var(--weight-semibold);
	}
}

.occupancy-year-grid {
	grid-template-rows: repeat(7, auto);
	row-gap: 3px;
}

.year-row {
	display: contents;
}

.year-weekday {
	grid-column: 1;
	align-self: center;
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	line-height: 1;
}

.day-cell {
	position: relative;
	display: block;
	aspect-ratio: 1;
	min-inline-size: 0;
	border-radius: var(--radius-xs);
	background: var(--cell-empty);
	box-shadow: inset 0 0 0 1px var(--border-subtle);
	cursor: pointer;

	&:hover {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
		z-index: 1;
	}

	&[data-dim] {
		opacity: .35;
	}

	&[data-state='elapsed'] {
		background: hsla(var(--primary-hsl), var(--cell-alpha));
		box-shadow: inset 0 0 0 1px var(--cell-stroke-elapsed);
	}

	&[data-state='planned'] {
		background:
			repeating-linear-gradient(135deg, hsla(var(--primary-hsl), var(--cell-alpha)) 0 2px, transparent 2px 4px),
			hsla(var(--primary-hsl), .08);
		box-shadow: inset 0 0 0 1px var(--cell-stroke-elapsed);
	}

	&[data-state='unelapsed'] {
		background: hsla(var(--grey-500-hsl), calc(var(--cell-alpha) * .7));
		box-shadow: inset 0 0 0 1px var(--cell-stroke-unelapsed);
	}

	&[data-level='1'] {
		--cell-alpha: .28;
	}

	&[data-level='2'] {
		--cell-alpha: .48;
	}

	&[data-level='3'] {
		--cell-alpha: .68;
	}

	&[data-level='4'] {
		--cell-alpha: .9;
	}

	&[data-today] {
		outline: 2px solid var(--text-primary);
		outline-offset: 1px;
	}

	&[aria-selected='true'] {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
		box-shadow: inset 0 0 0 2px var(--surface), inset 0 0 0 1px var(--cell-stroke-elapsed);
	}
}

.deadline-dot {
	position: absolute;
	inset-block-start: 1px;
	inset-inline-end: 1px;
	inline-size: 4px;
	block-size: 4px;
	border-radius: 50%;
	background: var(--danger-text);
	box-shadow: 0 0 0 1px var(--surface);
}

// Month calendar: large targets, always present (phones get it alone).
.month-view {
	inline-size: 100%;
	max-inline-size: 22rem;
	justify-self: center;

	@container (min-width: 60rem) {
		justify-self: stretch;
	}
}

.month-nav {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-1);
	margin-block-end: var(--space-2);
}

.month-step {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height);
	block-size: var(--control-height);
}

.month-name {
	flex: 1;
	min-block-size: var(--control-height);
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
}

.occupancy-month-grid {
	display: grid;
	gap: 3px;
}

.month-row {
	display: grid;
	grid-template-columns: repeat(7, minmax(0, 1fr));
	gap: 3px;
}

.month-weekday {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	text-align: center;
}

.month-day {
	display: flex;
	align-items: center;
	justify-content: center;
	aspect-ratio: auto;
	min-block-size: 2.25rem;
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;

	&.is-empty {
		background: transparent;
		box-shadow: none;
		cursor: default;
	}

	&[data-level='3'],
	&[data-level='4'] {
		&[data-state='elapsed'] .month-day-number {
			color: var(--text-on-accent);
			font-weight: var(--weight-semibold);
		}
	}

	@media (pointer: coarse) {
		min-block-size: var(--target-min);
	}
}

.month-day-number {
	position: relative;
	color: var(--text-primary);
}

.month-day .deadline-dot {
	inset-block-start: 3px;
	inset-inline-end: 3px;
	inline-size: 5px;
	block-size: 5px;
}

.occupancy-legend {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-4);
	margin-block-start: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.legend-item {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.legend-swatch {
	display: inline-block;
	inline-size: .75rem;
	block-size: .75rem;
	cursor: default;

	&:hover {
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	&.is-deadline {
		background: var(--cell-empty);
	}

	&.is-today {
		outline: 2px solid var(--text-primary);
		outline-offset: 1px;
		background: var(--cell-empty);
	}
}

.legend-scale {
	margin-inline-start: auto;
}

.occupancy-help {
	margin-block-start: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}
</style>
