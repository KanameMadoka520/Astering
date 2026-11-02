<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import CalendarEventLink from './CalendarEventLink.vue'
import {calendarDateLabel, calendarTimeLabel, type CalendarSegment} from '@/helpers/calendar'

const props = withDefaults(defineProps<{
	dates: string[]
	segments: Map<string, CalendarSegment[]>
	timezone: string
	today: string
	showEmpty?: boolean
	allowCreate?: boolean
	loading?: boolean
}>(), {
	showEmpty: false,
	allowCreate: false,
	loading: false,
})
const emit = defineEmits<{create: [date: string]}>()
const {t, locale} = useI18n({useScope: 'global'})
const groups = computed(() => props.dates
	.map(date => {
		const events = props.segments.get(date) ?? []
		const timedEvents = events.filter(event => event.kind !== 'all_day')
		const ranges = events.filter(event => event.kind === 'range')
			.map(event => [event.topMinutes, event.topMinutes + event.durationMinutes])
			.sort((a, b) => a[0] - b[0])
		let busyMinutes = 0
		let end = 0
		for (const range of ranges) {
			busyMinutes += Math.max(0, range[1] - Math.max(end, range[0]))
			end = Math.max(end, range[1])
		}
		return {
			date,
			events,
			timedEvents,
			clocks: timedEvents.length ? [0, .25, .5, .75, 1].map(fraction => {
				const first = timedEvents[0]
				const midnight = first.startMs - first.topMinutes * 60000
				return calendarTimeLabel(new Date(midnight + fraction * first.dayMinutes * 60000), props.timezone, locale.value)
			}) : [],
			count: new Set(events.map(event => event.taskId)).size,
			busy: new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}).format(busyMinutes / 60),
		}
	})
	.filter(group => props.showEmpty || group.events.length > 0))
</script>

<template>
	<div class="calendar-agenda">
		<section
			v-for="group in groups"
			:key="group.date"
			class="calendar-agenda-day"
			:data-agenda-date="group.date"
		>
			<header class="calendar-agenda-header">
				<h2 class="calendar-agenda-heading">
					<time :datetime="group.date">{{ calendarDateLabel(group.date, locale, {
						weekday: 'long', month: 'long', day: 'numeric',
					}) }}</time>
					<span
						v-if="group.date === today"
						class="calendar-today-badge"
					>{{ t('calendar.today') }}</span>
				</h2>
				<button
					v-if="allowCreate"
					type="button"
					class="calendar-day-create"
					:aria-label="t('calendar.createOnDate', {date: calendarDateLabel(group.date, locale, {month: 'long', day: 'numeric'})})"
					@click="emit('create', group.date)"
				>
					<Icon icon="plus" />
				</button>
			</header>
			<p
				v-if="group.events.length"
				class="calendar-agenda-summary"
			>
				{{ t('calendar.daySummary', {count: group.count, hours: group.busy}) }}
			</p>
			<div
				v-if="group.timedEvents.length"
				class="calendar-occupancy"
				aria-hidden="true"
			>
				<span
					v-for="event in group.timedEvents"
					:key="event.id"
					:class="{'is-point': event.kind !== 'range', 'is-due': event.kind === 'due'}"
					:style="{
						insetInlineStart: `${event.topMinutes / event.dayMinutes * 100}%`,
						inlineSize: `${Math.max(event.durationMinutes / event.dayMinutes * 100, .5)}%`,
					}"
				/>
			</div>
			<div
				v-if="group.timedEvents.length"
				class="calendar-occupancy-hours"
				aria-hidden="true"
			>
				<span
					v-for="(hour, index) in group.clocks"
					:key="index"
				>{{ hour }}</span>
			</div>
			<ul
				v-if="group.events.length"
				class="calendar-agenda-events"
			>
				<li
					v-for="event in group.events"
					:key="event.id"
				>
					<CalendarEventLink
						:segment="event"
						:timezone="timezone"
					/>
				</li>
			</ul>
			<p
				v-else
				class="calendar-day-empty"
			>
				{{ t(loading ? 'calendar.loading' : 'calendar.emptyDay') }}
				<button
					v-if="allowCreate"
					type="button"
					class="calendar-day-empty-create"
					@click="emit('create', group.date)"
				>
					{{ t('calendar.create.label') }}
				</button>
			</p>
		</section>
	</div>
</template>

<style scoped lang="scss">
.calendar-agenda {
	display: grid;
	gap: var(--space-5);
	min-inline-size: 0;
}

.calendar-agenda-day {
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
}

.calendar-agenda-heading {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);
}

.calendar-agenda-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
}

.calendar-day-create {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: var(--target-min);
	block-size: var(--target-min);
	padding: 0;
	border: 0;
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	cursor: pointer;

	&:focus-visible { outline: 2px solid var(--focus-ring-color); }
}

.calendar-agenda-summary {
	margin-block: var(--space-2) var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.calendar-today-badge {
	padding: 2px var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
}

.calendar-occupancy {
	position: relative;
	block-size: 6px;
	margin-block-end: var(--space-1);
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-sunken);

	span {
		position: absolute;
		block-size: 100%;
		background: var(--primary);

		&.is-point {
			min-inline-size: 3px;
			border-radius: var(--radius-full);
		}

		&.is-due { background: var(--warning); }
	}
}

.calendar-occupancy-hours {
	display: flex;
	justify-content: space-between;
	margin-block-end: var(--space-4);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	font-variant-numeric: tabular-nums;

	span {
		max-inline-size: 19%;
		overflow-wrap: anywhere;
	}
}

.calendar-agenda-events {
	display: grid;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.calendar-day-empty {
	display: grid;
	justify-items: start;
	gap: var(--space-3);
	margin-block: var(--space-4) 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.calendar-day-empty-create {
	min-block-size: var(--target-min);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface);
	color: var(--accent-text);
	font: inherit;
	cursor: pointer;

	&:focus-visible { outline: 2px solid var(--focus-ring-color); }
}
</style>
