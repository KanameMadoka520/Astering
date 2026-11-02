<script setup lang="ts">
import {computed} from 'vue'
import {useRoute} from 'vue-router'
import {useI18n} from 'vue-i18n'

import {
	addCalendarDays,
	calendarDateAt,
	calendarDateLabel,
	calendarTimeLabel,
	type CalendarSegment,
} from '@/helpers/calendar'
import {useTimeFormat} from '@/composables/useTimeFormat'
import {TIME_FORMAT} from '@/constants/timeFormat'

const props = withDefaults(defineProps<{
	segment: CalendarSegment
	timezone: string
	presentation?: 'compact' | 'card' | 'timeline'
}>(), {
	presentation: 'card',
})
const {t, locale} = useI18n({useScope: 'global'})
const route = useRoute()
const {store: timeFormat} = useTimeFormat()
const time = (instant: string | number) => calendarTimeLabel(
	typeof instant === 'number' ? new Date(instant) : instant,
	props.timezone,
	locale.value,
	timeFormat.value === TIME_FORMAT.HOURS_12,
	props.segment.dayMinutes !== 1440,
)
const color = computed(() => {
	const value = props.segment.item.hex_color || props.segment.item.project_color || ''
	return /^#?[\da-f]{6}$/i.test(value) ? `#${value.replace('#', '')}` : 'var(--primary)'
})
const title = computed(() => props.segment.item.title || t('calendar.untitled'))
const important = computed(() => (props.segment.item.priority ?? 0) >= 3)
const timeLabel = computed(() => {
	const segment = props.segment
	if (segment.kind === 'all_day') return t('calendar.allDay')
	if (segment.kind === 'range') {
		return `${time(segment.startMs)}–${time(segment.endMs)}`
	}
	return t(`calendar.kind.${segment.kind}`, {time: time(segment.startMs)})
})
const fullLabel = computed(() => {
	const segment = props.segment
	const fullTime = (value: string | number) => `${calendarDateLabel(
		calendarDateAt(typeof value === 'number' ? new Date(value) : value, props.timezone),
		locale.value,
		{year: 'numeric', month: 'short', day: 'numeric'},
	)} ${time(value)}`
	const timing = segment.kind === 'all_day'
		? `${t('calendar.allDay')} · ${segment.item.all_day_start}–${addCalendarDays(segment.item.all_day_end!, -1)}`
		: segment.kind === 'range'
			? `${fullTime(segment.item.start_date!)}–${fullTime(segment.item.end_date!)}`
			: t(`calendar.kind.${segment.kind}`, {time: fullTime(segment.startMs)})
	return [
		title.value,
		timing,
		segment.item.project_title,
		important.value ? t('calendar.important') : '',
		segment.item.done ? t('task.attributes.done') : '',
	].filter(Boolean).join(' · ')
})
</script>

<template>
	<RouterLink
		:to="{
			name: 'task.detail',
			params: {id: segment.taskId},
			state: {backdropView: route.fullPath},
		}"
		class="calendar-event"
		:class="[
			`is-${presentation}`,
			`is-${segment.kind}`,
			{'is-done': segment.item.done, 'is-important': important},
		]"
		:style="{'--calendar-event-color': color}"
		:aria-label="fullLabel"
		:title="fullLabel"
		:data-task-id="segment.taskId"
		:data-event-kind="segment.kind"
	>
		<span class="calendar-event-title">
			<span
				v-if="segment.continuesBefore"
				aria-hidden="true"
			>‹ </span>
			{{ title }}
			<span
				v-if="segment.continuesAfter"
				aria-hidden="true"
			> ›</span>
		</span>
		<span class="calendar-event-time">{{ timeLabel }}</span>
		<span
			v-if="presentation === 'card' && segment.item.project_title"
			class="calendar-event-project"
		>{{ segment.item.project_title }}</span>
		<span
			v-if="important"
			class="calendar-important-dot"
			aria-hidden="true"
		/>
	</RouterLink>
</template>

<style scoped lang="scss">
.calendar-event {
	position: relative;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-inline-size: 0;
	padding: var(--space-2) var(--space-3);
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--calendar-event-color);
	border-radius: var(--radius-sm);
	background: color-mix(in srgb, var(--calendar-event-color) 10%, var(--surface));
	color: var(--text-primary);
	text-decoration: none;
	font-size: var(--text-sm);
	line-height: var(--leading-tight);

	&:hover {
		background: color-mix(in srgb, var(--calendar-event-color) 18%, var(--surface));
		color: var(--text-primary);
	}

	&:focus-visible {
		z-index: 2;
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}

	&.is-done {
		opacity: .65;

		.calendar-event-title {
			text-decoration: line-through;
		}
	}

	&.is-due {
		border-inline-start-style: dotted;
	}

	&.is-compact {
		gap: 1px;
		min-block-size: 2.1rem;
		padding: 3px var(--space-1);
		font-size: var(--text-xs);

		.calendar-event-time {
			font-size: var(--text-2xs);
		}
	}

	&.is-card .calendar-event-title {
		white-space: normal;
		overflow-wrap: anywhere;
	}

	&.is-timeline {
		block-size: 100%;
		padding: 2px var(--space-1);
		font-size: var(--text-xs);
	}

}

.calendar-event-title,
.calendar-event-time,
.calendar-event-project {
	flex-shrink: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.calendar-event-title {
	font-weight: var(--weight-semibold);
	line-height: 18px;
}

.calendar-event-time,
.calendar-event-project {
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: 16px;
}

.calendar-important-dot {
	position: absolute;
	inset-block-start: var(--space-1);
	inset-inline-end: var(--space-1);
	inline-size: 5px;
	block-size: 5px;
	border-radius: 50%;
	background: var(--warning);
}
</style>
