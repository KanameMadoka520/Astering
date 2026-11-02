<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import CalendarEventLink from './CalendarEventLink.vue'
import {
	addCalendarDays,
	addCalendarMonths,
	calendarDateLabel,
	type CalendarSegment,
} from '@/helpers/calendar'

const props = defineProps<{
	dates: string[]
	anchor: string
	selectedDate: string
	today: string
	segments: Map<string, CalendarSegment[]>
	timezone: string
	dense: boolean
}>()
const emit = defineEmits<{
	select: [date: string]
}>()
const {t, locale} = useI18n({useScope: 'global'})
const root = ref<HTMLElement>()
const focusedDate = ref('')
let restoreFocus = false
const weeks = computed(() => Array.from({length: 6}, (_, index) => props.dates.slice(index * 7, index * 7 + 7)))
const eventLimit = computed(() => props.dense ? 2 : 3)
watch(() => props.selectedDate, async date => {
	focusedDate.value = date
	if (!restoreFocus) return
	await nextTick()
	root.value?.querySelector<HTMLButtonElement>(`[data-calendar-date="${date}"]`)?.focus()
	restoreFocus = false
}, {immediate: true})

function keydown(event: KeyboardEvent, date: string, index: number) {
	let next = ''
	const direction = document.dir === 'rtl' ? -1 : 1
	if (event.key === 'ArrowLeft') next = addCalendarDays(date, -direction)
	if (event.key === 'ArrowRight') next = addCalendarDays(date, direction)
	if (event.key === 'ArrowUp') next = addCalendarDays(date, -7)
	if (event.key === 'ArrowDown') next = addCalendarDays(date, 7)
	if (event.key === 'Home') next = addCalendarDays(date, -(index % 7))
	if (event.key === 'End') next = addCalendarDays(date, 6 - index % 7)
	if (event.key === 'PageUp') next = addCalendarMonths(date, -1)
	if (event.key === 'PageDown') next = addCalendarMonths(date, 1)
	if (!next) return
	event.preventDefault()
	restoreFocus = true
	emit('select', next)
}
</script>

<template>
	<div
		ref="root"
		class="calendar-month-view"
		:class="{'is-dense': dense}"
		role="grid"
		:aria-label="t('calendar.monthGrid')"
	>
		<div
			class="calendar-month-weekdays"
			role="row"
		>
			<div
				v-for="date in dates.slice(0, 7)"
				:key="date"
				role="columnheader"
			>
				{{ calendarDateLabel(date, locale, {weekday: 'short'}) }}
			</div>
		</div>
		<div
			v-for="(week, weekIndex) in weeks"
			:key="weekIndex"
			class="calendar-month-row"
			role="row"
		>
			<div
				v-for="(date, dayIndex) in week"
				:key="date"
				class="calendar-month-cell"
				:class="{
					'is-outside': date.slice(0, 7) !== anchor.slice(0, 7),
					'is-selected': date === selectedDate,
				}"
				role="gridcell"
				:aria-selected="date === selectedDate"
			>
				<button
					type="button"
					class="calendar-month-date"
					:class="{'is-today': date === today}"
					:data-calendar-date="date"
					:tabindex="date === focusedDate ? 0 : -1"
					:aria-current="date === today ? 'date' : undefined"
					:aria-label="calendarDateLabel(date, locale, {
						weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
					})"
					@click="emit('select', date)"
					@keydown="keydown($event, date, weekIndex * 7 + dayIndex)"
				>
					{{ Number(date.slice(8)) }}
				</button>
				<div class="calendar-month-events">
					<CalendarEventLink
						v-for="segment in (segments.get(date) ?? []).slice(0, eventLimit)"
						:key="segment.id"
						:segment="segment"
						:timezone="timezone"
						presentation="compact"
					/>
					<button
						v-if="(segments.get(date)?.length ?? 0) > eventLimit"
						type="button"
						class="calendar-month-more"
						@click="emit('select', date)"
					>
						{{ t('calendar.more', {count: (segments.get(date)?.length ?? 0) - eventLimit}) }}
					</button>
				</div>
				<span
					v-if="segments.get(date)?.length"
					class="calendar-month-count"
					:aria-label="t('calendar.dayItems', {count: segments.get(date)!.length})"
				>{{ segments.get(date)!.length }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped lang="scss">
.calendar-month-view {
	min-inline-size: 0;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
}

.calendar-month-weekdays,
.calendar-month-row {
	display: grid;
	grid-template-columns: repeat(7, minmax(0, 1fr));
}

.calendar-month-weekdays {
	padding-block: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	text-align: center;
}

.calendar-month-cell {
	position: relative;
	min-inline-size: 0;
	min-block-size: 9rem;
	padding: var(--space-1);
	border-block-start: 1px solid var(--border-subtle);
	border-inline-end: 1px solid var(--border-subtle);

	&:last-child {
		border-inline-end: 0;
	}

	&.is-outside {
		background: var(--surface-sunken);

		.calendar-month-date {
			color: var(--text-tertiary);
		}
	}

	&.is-selected {
		background: var(--surface-selected);
	}
}

.calendar-month-date {
	display: block;
	inline-size: 2rem;
	block-size: 2rem;
	margin: 0 auto var(--space-1);
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;

	&.is-today {
		background: var(--primary);
		color: var(--text-on-accent);
	}

	&:hover {
		box-shadow: 0 0 0 2px var(--border-strong);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}
}

.calendar-month-events {
	display: grid;
	gap: 3px;
}

.calendar-month-more {
	min-block-size: 1.5rem;
	padding: 0 var(--space-1);
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--accent-text);
	font: inherit;
	font-size: var(--text-xs);
	text-align: start;
	cursor: pointer;

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
	}
}

.calendar-month-count {
	display: none;
}

.is-dense .calendar-month-cell {
	min-block-size: 7rem;
}

@media (width <= 640px) {
	.calendar-month-cell,
	.is-dense .calendar-month-cell {
		min-block-size: 4.75rem;
		padding: 2px;
	}

	.calendar-month-date {
		inline-size: min(100%, 2.75rem);
		block-size: 2.75rem;
		margin-block-end: 0;
	}

	.calendar-month-events {
		display: none;
	}

	.calendar-month-count {
		display: block;
		inline-size: fit-content;
		min-inline-size: 1.25rem;
		margin-inline: auto;
		padding-inline: var(--space-1);
		border-radius: var(--radius-full);
		background: var(--surface-selected-strong);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		text-align: center;
	}
}
</style>
