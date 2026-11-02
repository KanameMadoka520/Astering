<script setup lang="ts">
import {computed, nextTick, onMounted, ref, watch} from 'vue'
import {useMediaQuery, useResizeObserver} from '@vueuse/core'
import {useI18n} from 'vue-i18n'

import CalendarEventLink from './CalendarEventLink.vue'
import {
	calendarDateLabel,
	calendarTimeLabel,
	layoutTimedEvents,
	type CalendarDay,
	type CalendarSegment,
} from '@/helpers/calendar'
import {useTimeFormat} from '@/composables/useTimeFormat'
import {TIME_FORMAT} from '@/constants/timeFormat'

const props = defineProps<{
	days: CalendarDay[]
	segments: Map<string, CalendarSegment[]>
	timezone: string
	today: string
	selectedDate: string
	hourHeight: number
	now: Date
}>()
const emit = defineEmits<{
	select: [date: string]
}>()
const {t, locale} = useI18n({useScope: 'global'})
const {store: timeFormat} = useTimeFormat()
const narrow = useMediaQuery('(max-width: 640px)')
const scroller = ref<HTMLElement>()
const savedScroll = {top: 0, left: 0}
let wasHidden = false

function rememberScroll() {
	const viewport = scroller.value
	// Phone task dialogs hide #app. Its collapsed scroll area must not replace the visible position with zero.
	if (wasHidden || !viewport || viewport.clientHeight === 0 || viewport.clientWidth === 0) return
	savedScroll.top = viewport.scrollTop
	savedScroll.left = viewport.scrollLeft
}

useResizeObserver(scroller, ([entry]) => {
	if (!entry) return
	if (entry.contentRect.height === 0 || entry.contentRect.width === 0) {
		wasHidden = true
		return
	}
	if (!wasHidden || !scroller.value) return
	wasHidden = false
	// Restore only after the phone dialog has released the hidden background, not during ordinary zoom/resize.
	scroller.value.scrollTop = savedScroll.top
	scroller.value.scrollLeft = savedScroll.left
})
const dayMinutes = (day: CalendarDay) => (Date.parse(day.end_at) - Date.parse(day.start_at)) / 60_000
const maxMinutes = computed(() => Math.max(1440, ...props.days.map(dayMinutes)))
const columns = computed(() => props.days.map(day => {
	const minutes = dayMinutes(day)
	return {
		day,
		minutes,
		events: layoutTimedEvents(
			props.segments.get(day.date) ?? [],
			(narrow.value ? 44 : 24) / props.hourHeight * 60,
		),
		ticks: Array.from({length: Math.ceil(minutes / 60) + 1}, (_, index) => {
			const minute = Math.min(index * 60, minutes)
			return {
				minute,
				label: calendarTimeLabel(
					new Date(Date.parse(day.start_at) + minute * 60_000),
					props.timezone,
					locale.value,
					timeFormat.value === TIME_FORMAT.HOURS_12,
					minutes !== 1440,
				),
			}
		}),
	}
}))
const gridStyle = computed(() => ({
	gridTemplateColumns: `repeat(${Math.max(props.days.length, 1)}, minmax(0, 1fr))`,
	minInlineSize: props.days.length > 1 ? `${props.days.length * (narrow.value ? 176 : 68)}px` : '0',
}))
const nowLines = computed(() => new Map(props.days.flatMap(day => {
	const minute = (props.now.getTime() - Date.parse(day.start_at)) / 60_000
	return minute >= 0 && minute < dayMinutes(day) ? [[day.date, minute] as const] : []
})))
const variableDay = computed(() => props.days.some(day => dayMinutes(day) !== 1440))

onMounted(async () => {
	await nextTick()
	if (!scroller.value) return
	const current = nowLines.value.get(props.today)
	scroller.value.scrollTop = Math.max(0, (current === undefined ? 8 * 60 : current - 60) / 60 * props.hourHeight)
	rememberScroll()
})
watch(() => props.hourHeight, async (height, previous) => {
	const viewport = scroller.value
	if (!viewport || previous <= 0) return
	const minuteAtTop = viewport.scrollTop / previous * 60
	await nextTick()
	if (scroller.value === viewport) {
		viewport.scrollTop = minuteAtTop / 60 * height
		rememberScroll()
	}
})
</script>

<template>
	<div class="calendar-time-view">
		<p class="calendar-time-help">
			{{ t('calendar.timeGridHint') }}
		</p>
		<div
			ref="scroller"
			class="calendar-time-scroll"
			tabindex="0"
			role="region"
			:aria-label="t('calendar.timeGrid')"
			@scroll="rememberScroll"
			@click.capture="rememberScroll"
		>
			<div
				class="calendar-time-header"
				:style="gridStyle"
			>
				<button
					v-for="day in days"
					:key="day.date"
					type="button"
					class="calendar-time-date"
					:class="{'is-selected': day.date === selectedDate}"
					:aria-label="calendarDateLabel(day.date, locale, {
						weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
					})"
					:aria-pressed="day.date === selectedDate"
					@click="emit('select', day.date)"
				>
					<span>{{ calendarDateLabel(day.date, locale, {weekday: 'short'}) }}</span>
					<time
						:datetime="day.date"
						:class="{'is-today': day.date === today}"
					>{{ Number(day.date.slice(8)) }}</time>
				</button>
			</div>
			<div
				class="calendar-time-body"
				:style="gridStyle"
			>
				<div
					v-for="column in columns"
					:key="column.day.date"
					class="calendar-time-column"
					:style="{blockSize: `${maxMinutes / 60 * hourHeight}px`}"
					:data-timeline-date="column.day.date"
				>
					<div
						v-for="tick in column.ticks"
						:key="tick.minute"
						class="calendar-time-tick"
						:style="{insetBlockStart: `${tick.minute / 60 * hourHeight}px`}"
						aria-hidden="true"
					>
						<span>{{ tick.label }}</span>
					</div>
					<div class="calendar-time-events">
						<div
							v-for="event in column.events"
							:key="event.id"
							class="calendar-time-placement"
							:style="{
								insetBlockStart: `${event.visualTopMinutes / 60 * hourHeight}px`,
								blockSize: `${event.visualDurationMinutes / 60 * hourHeight}px`,
								insetInlineStart: `${event.column / event.columnCount * 100}%`,
								inlineSize: `${100 / event.columnCount}%`,
							}"
						>
							<CalendarEventLink
								:segment="event"
								:timezone="timezone"
								presentation="timeline"
							/>
						</div>
					</div>
					<div
						v-if="nowLines.has(column.day.date)"
						class="calendar-now-line"
						:style="{insetBlockStart: `${nowLines.get(column.day.date)! / 60 * hourHeight}px`}"
						:aria-label="t('calendar.currentTime')"
						role="img"
					/>
				</div>
			</div>
		</div>
		<p
			v-if="variableDay"
			class="calendar-time-help"
		>
			{{ t('calendar.dstHint', {timezone}) }}
		</p>
	</div>
</template>

<style scoped lang="scss">
.calendar-time-view {
	min-inline-size: 0;
}

.calendar-time-help {
	margin-block: 0 var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.calendar-time-scroll {
	position: relative;
	block-size: min(68dvh, 54rem);
	min-block-size: 16rem;
	overflow: auto;
	overscroll-behavior: contain;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
	}
}

.calendar-time-header,
.calendar-time-body {
	display: grid;
}

.calendar-time-header {
	position: sticky;
	z-index: 3;
	inset-block-start: 0;
	border-block-end: 1px solid var(--border-subtle);
	background: var(--surface);
}

.calendar-time-date {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	min-block-size: 3.25rem;
	padding: var(--space-1);
	border: 0;
	border-inline-end: 1px solid var(--border-subtle);
	background: transparent;
	color: var(--text-secondary);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;

	&.is-selected {
		background: var(--surface-selected);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}

	time {
		display: grid;
		inline-size: 2rem;
		block-size: 2rem;
		border-radius: 50%;
		color: var(--text-primary);
		font-size: var(--text-lg);
		place-items: center;

		&.is-today {
			background: var(--primary);
			color: var(--text-on-accent);
		}
	}
}

.calendar-time-column {
	position: relative;
	min-inline-size: 0;
	border-inline-end: 1px solid var(--border-subtle);
}

.calendar-time-tick {
	position: absolute;
	inset-inline: 0;
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	line-height: 1;

	span {
		display: inline-block;
		padding: 3px;
		background: var(--surface);
	}
}

.calendar-time-events {
	position: absolute;
	inset-block: 0;
	inset-inline: 2.75rem 2px;
}

.calendar-time-placement {
	position: absolute;
	padding: 1px;
}

.calendar-now-line {
	position: absolute;
	z-index: 2;
	inset-inline: 2.75rem 0;
	border-block-start: 2px solid var(--danger);
	pointer-events: none;

	&::before {
		position: absolute;
		inset-block-start: -4px;
		inset-inline-start: -4px;
		inline-size: 6px;
		block-size: 6px;
		border-radius: 50%;
		background: var(--danger);
		content: '';
	}
}
</style>
