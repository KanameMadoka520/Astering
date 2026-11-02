<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import CalendarEventLink from './CalendarEventLink.vue'
import {calendarDateLabel, type CalendarSegment} from '@/helpers/calendar'

const props = withDefaults(defineProps<{
	dates: string[]
	segments: Map<string, CalendarSegment[]>
	timezone: string
	today: string
	showEmpty?: boolean
}>(), {
	showEmpty: false,
})
const {t, locale} = useI18n({useScope: 'global'})
const groups = computed(() => props.dates
	.map(date => ({date, events: props.segments.get(date) ?? []}))
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
			<h2 class="calendar-agenda-heading">
				<time :datetime="group.date">{{ calendarDateLabel(group.date, locale, {
					weekday: 'long', month: 'long', day: 'numeric',
				}) }}</time>
				<span
					v-if="group.date === today"
					class="calendar-today-badge"
				>{{ t('calendar.today') }}</span>
			</h2>
			<div
				v-if="group.events.length"
				class="calendar-occupancy"
				aria-hidden="true"
			>
				<span
					v-for="event in group.events"
					:key="event.id"
					:style="{
						insetInlineStart: `${event.topMinutes / event.dayMinutes * 100}%`,
						inlineSize: `${Math.max(event.durationMinutes / event.dayMinutes * 100, .5)}%`,
					}"
				/>
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
				{{ t('calendar.emptyDay') }}
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
	margin: 0 0 var(--space-3);
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);
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
	block-size: 4px;
	margin-block-end: var(--space-3);
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-sunken);

	span {
		position: absolute;
		block-size: 100%;
		background: var(--primary);
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
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
</style>
