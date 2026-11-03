<script setup lang="ts">
import {computed, nextTick, onMounted, ref, watch} from 'vue'
import {useEventListener, useResizeObserver} from '@vueuse/core'
import {useI18n} from 'vue-i18n'

import CalendarEventLink from './CalendarEventLink.vue'
import {
	calendarDateLabel,
	calendarTimeLabel,
	layoutCalendarTimeline,
	calendarDateAt,
	type CalendarDay,
	type CalendarSegment,
} from '@/helpers/calendar'
import {useIsMobile} from '@/composables/useIsMobile'
import {useTimeFormat} from '@/composables/useTimeFormat'
import {TIME_FORMAT} from '@/constants/timeFormat'
import {calendarLunarLabel} from '@/helpers/calendarDisplay'

const props = defineProps<{
	days: CalendarDay[]
	segments: Map<string, CalendarSegment[]>
	timezone: string
	today: string
	selectedDate: string
	hourHeight: number
	now: Date
	showLunar?: boolean
}>()
const emit = defineEmits<{
	select: [date: string]
	showDay: [date: string]
	create: [slot: {date: string, start?: string, end?: string, allDay?: boolean}]
}>()
const {t, locale} = useI18n({useScope: 'global'})
const {store: timeFormat} = useTimeFormat()
const narrow = useIsMobile()
const scroller = ref<HTMLElement>()
const header = ref<HTMLElement>()
const headerHeight = ref(0)
const savedScroll = {top: 0, left: 0}
const viewportWidth = ref(0)
let wasHidden = false
let pendingWindowScroll: {minute: number, left: number} | undefined

useResizeObserver(header, ([entry]) => {
	if (entry) headerHeight.value = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
})

function rememberScroll() {
	const viewport = scroller.value
	// Phone task dialogs hide #app. Its collapsed scroll area must not replace the visible position with zero.
	if (wasHidden || !props.days.length || !viewport || viewport.clientHeight === 0 || viewport.clientWidth === 0) return
	savedScroll.top = viewport.scrollTop
	savedScroll.left = viewport.scrollLeft
}

useResizeObserver(scroller, ([entry]) => {
	if (!entry) return
	if (entry.contentRect.height === 0 || entry.contentRect.width === 0) {
		wasHidden = true
		return
	}
	viewportWidth.value = entry.contentRect.width
	if (!wasHidden || !scroller.value) return
	wasHidden = false
	// Restore only after the phone dialog has released the hidden background, not during ordinary zoom/resize.
	scroller.value.scrollTop = savedScroll.top
	scroller.value.scrollLeft = savedScroll.left
})
const dayMinutes = (day: CalendarDay) => (Date.parse(day.end_at) - Date.parse(day.start_at)) / 60_000
const maxMinutes = computed(() => Math.max(1440, ...props.days.map(dayMinutes)))
const minimumDayWidth = computed(() => narrow.value ? 176 : 140)
const gridWidth = computed(() => Math.max(viewportWidth.value, 64 + props.days.length * minimumDayWidth.value))
const maximumColumns = computed(() => Math.max(1, Math.min(4,
	Math.floor((gridWidth.value - 64) / Math.max(props.days.length, 1) / 68),
)))
const columns = computed(() => props.days.map(day => {
	const minutes = dayMinutes(day)
	return {
		day,
		minutes,
		...layoutCalendarTimeline(
			props.segments.get(day.date) ?? [],
			44 / props.hourHeight * 60,
			maximumColumns.value,
		),
		allDay: (props.segments.get(day.date) ?? []).filter(event => event.kind === 'all_day'),
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
	gridTemplateColumns: `4rem repeat(${Math.max(props.days.length, 1)}, minmax(0, 1fr))`,
	minInlineSize: `${64 + props.days.length * minimumDayWidth.value}px`,
}))
const nowLines = computed(() => new Map(props.days.flatMap(day => {
	const minute = (props.now.getTime() - Date.parse(day.start_at)) / 60_000
	return minute >= 0 && minute < dayMinutes(day) ? [[day.date, minute] as const] : []
})))
const variableDay = computed(() => props.days.some(day => dayMinutes(day) !== 1440))

const selection = ref<{day: CalendarDay, from: number, to: number}>()
let committedPointerAt = -1000
const selectionStyle = computed(() => {
	const value = selection.value
	if (!value) return {}
	return {
		insetBlockStart: `${Math.min(value.from, value.to) / 60 * props.hourHeight}px`,
		blockSize: `${Math.max(15, Math.abs(value.to - value.from) + 15) / 60 * props.hourHeight}px`,
	}
})
function wallTime(day: CalendarDay, minute: number) {
	const instant = new Date(Date.parse(day.start_at) + minute * 60_000)
	return `${calendarDateAt(instant, props.timezone)}T${calendarTimeLabel(instant, props.timezone, 'en-GB')}`
}
function createRange(day: CalendarDay, from: number, to: number) {
	emit('create', {
		date: day.date,
		start: wallTime(day, from),
		end: wallTime(day, Math.min(dayMinutes(day), to)),
	})
}
function slotMinute(event: MouseEvent | PointerEvent, day: CalendarDay) {
	const column = scroller.value?.querySelector<HTMLElement>(`[data-timeline-date="${day.date}"]`)
	if (!column) return 0
	return Math.max(0, Math.min(dayMinutes(day) - 15,
		Math.floor((event.clientY - column.getBoundingClientRect().top) / props.hourHeight * 4) * 15,
	))
}
function pointerStart(event: PointerEvent, day: CalendarDay) {
	if (event.pointerType !== 'mouse' || event.button !== 0
		|| !(event.target instanceof Element) || !event.target.closest('.calendar-time-slot')) return
	event.preventDefault()
	const minute = slotMinute(event, day)
	selection.value = {day, from: minute, to: minute}
	scroller.value?.setPointerCapture(event.pointerId)
}
useEventListener('pointermove', (event: PointerEvent) => {
	if (!selection.value) return
	selection.value = {...selection.value, to: slotMinute(event, selection.value.day)}
})
useEventListener('pointerup', () => {
	const value = selection.value
	if (!value) return
	selection.value = undefined
	committedPointerAt = performance.now()
	const from = Math.min(value.from, value.to)
	const to = value.from === value.to ? from + 30 : Math.max(value.from, value.to) + 15
	createRange(value.day, from, to)
})
useEventListener('pointercancel', () => { selection.value = undefined })
function slotClick(event: MouseEvent, day: CalendarDay, minute: number) {
	if (event.detail > 0 && performance.now() - committedPointerAt < 350) return
	const from = event.detail === 0 ? minute : slotMinute(event, day)
	createRange(day, from, from + 30)
}
function slotKeydown(event: KeyboardEvent, dayIndex: number, minute: number) {
	let nextDay = dayIndex
	let nextMinute = minute
	const lastSlot = (day: CalendarDay) => Math.floor((dayMinutes(day) - 1) / 60) * 60
	if (event.key === 'ArrowLeft') nextDay--
	else if (event.key === 'ArrowRight') nextDay++
	else if (event.key === 'ArrowUp') nextMinute -= 60
	else if (event.key === 'ArrowDown') nextMinute += 60
	else if (event.key === 'Home') nextMinute = 0
	else if (event.key === 'End') nextMinute = lastSlot(props.days[dayIndex])
	else return
	event.preventDefault()
	const day = props.days[Math.max(0, Math.min(props.days.length - 1, nextDay))]
	nextMinute = Math.max(0, Math.min(lastSlot(day), nextMinute))
	scroller.value?.querySelector<HTMLElement>(
		`[data-slot-date="${day.date}"][data-slot-minute="${nextMinute}"]`,
	)?.focus()
}
watch(() => [props.days, props.hourHeight, props.timezone], () => { selection.value = undefined })

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
watch(() => props.days, async (days, previous) => {
	const viewport = scroller.value
	if (!viewport) return
	// A new query window temporarily has no days. Preserve the visible time, not old task data.
	if (!days.length && previous.length && viewport.clientHeight > 0) {
		pendingWindowScroll = {minute: viewport.scrollTop / props.hourHeight * 60, left: viewport.scrollLeft}
		return
	}
	if (!days.length || !pendingWindowScroll) return
	const position = pendingWindowScroll
	await nextTick()
	if (props.days !== days || scroller.value !== viewport) return
	viewport.scrollTop = position.minute / 60 * props.hourHeight
	viewport.scrollLeft = position.left
	pendingWindowScroll = undefined
	rememberScroll()
})
</script>

<template>
	<div class="calendar-time-view">
		<div
			ref="scroller"
			class="calendar-time-scroll"
			:style="{scrollPaddingBlockStart: `${headerHeight}px`}"
			tabindex="0"
			role="region"
			:aria-label="t('calendar.timeGrid')"
			@scroll="rememberScroll"
			@click.capture="rememberScroll"
			@keydown.esc="selection = undefined"
		>
			<div
				ref="header"
				class="calendar-time-header-shell"
			>
				<div
					class="calendar-time-header"
					:style="gridStyle"
				>
					<div class="calendar-ruler-heading">
						{{ timezone.split('/').at(-1)?.replaceAll('_', ' ') }}
					</div>
					<button
						v-for="day in days"
						:key="day.date"
						type="button"
						class="calendar-time-date"
						:class="{'is-selected': day.date === selectedDate}"
						:aria-label="calendarDateLabel(day.date, locale, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})"
						:aria-pressed="day.date === selectedDate"
						@click="emit('select', day.date)"
					>
						<span>{{ calendarDateLabel(day.date, locale, {weekday: 'short'}) }}</span>
						<time
							:datetime="day.date"
							:class="{'is-today': day.date === today}"
						>{{ Number(day.date.slice(8)) }}</time>
						<small v-if="showLunar">{{ calendarLunarLabel(day.date, locale) }}</small>
					</button>
				</div>
				<div
					class="calendar-all-day-strip"
					:style="gridStyle"
				>
					<span class="calendar-all-day-label">{{ t('calendar.allDay') }}</span>
					<div
						v-for="column in columns"
						:key="column.day.date"
						class="calendar-all-day-cell"
					>
						<CalendarEventLink
							v-for="event in column.allDay.slice(0, 2)"
							:key="event.id"
							:segment="event"
							:timezone="timezone"
							presentation="compact"
						/>
						<button
							v-if="column.allDay.length > 2"
							class="calendar-all-day-more"
							type="button"
							@click="emit('showDay', column.day.date)"
						>
							{{ t('calendar.overflowCount', {count: column.allDay.length - 2}) }}
						</button>
						<button
							v-if="!column.allDay.length"
							class="calendar-all-day-add"
							type="button"
							:aria-label="`${t('calendar.create.label')} · ${column.day.date} · ${t('calendar.allDay')}`"
							@click="emit('create', {date: column.day.date, allDay: true})"
						>
							+
						</button>
					</div>
				</div>
			</div>
			<div
				class="calendar-time-body"
				:style="gridStyle"
			>
				<div
					class="calendar-time-ruler"
					:style="{blockSize: `${maxMinutes / 60 * hourHeight}px`}"
					aria-hidden="true"
				>
					<div
						v-for="tick in variableDay ? [] : columns[0]?.ticks ?? []"
						:key="tick.minute"
						class="calendar-ruler-tick"
						:style="{insetBlockStart: `${tick.minute / 60 * hourHeight}px`}"
					>
						{{ tick.label }}
					</div>
				</div>
				<div
					v-for="(column, dayIndex) in columns"
					:key="column.day.date"
					class="calendar-time-column"
					:class="{'is-today': column.day.date === today}"
					:style="{blockSize: `${maxMinutes / 60 * hourHeight}px`}"
					:data-timeline-date="column.day.date"
					@pointerdown="pointerStart($event, column.day)"
				>
					<template
						v-for="tick in column.ticks"
						:key="tick.minute"
					>
						<button
							v-if="tick.minute < column.minutes"
							type="button"
							class="calendar-time-slot"
							:style="{insetBlockStart: `${tick.minute / 60 * hourHeight}px`, blockSize: `${Math.min(60, column.minutes - tick.minute) / 60 * hourHeight}px`}"
							:data-slot-date="column.day.date"
							:data-slot-minute="tick.minute"
							:tabindex="column.day.date === (days.some(day => day.date === selectedDate) ? selectedDate : days[0]?.date) && tick.minute === 540 ? 0 : -1"
							:aria-label="t('calendar.createAtTime', {date: column.day.date, time: tick.label})"
							@click="slotClick($event, column.day, tick.minute)"
							@keydown="slotKeydown($event, dayIndex, tick.minute)"
						>
							<span
								v-if="variableDay"
								class="calendar-variable-tick"
							>{{ tick.label }}</span>
						</button>
					</template>
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
						<button
							v-for="group in column.overflow"
							:key="group.id"
							type="button"
							class="calendar-time-overflow"
							:data-overflow-date="column.day.date"
							:data-overflow-count="group.segments.length"
							:aria-label="`${t('calendar.overflowCount', {count: group.segments.length})} · ${t('calendar.showDay')}`"
							:style="{
								insetBlockStart: `${group.visualTopMinutes / 60 * hourHeight}px`,
								blockSize: `${group.visualDurationMinutes / 60 * hourHeight}px`,
								insetInlineStart: `${group.column / group.columnCount * 100}%`,
								inlineSize: `${100 / group.columnCount}%`,
							}"
							@click="emit('showDay', column.day.date)"
						>
							<span>{{ t('calendar.overflowCount', {count: group.segments.length}) }}</span>
						</button>
					</div>
					<div
						v-if="selection?.day.date === column.day.date"
						class="calendar-time-selection"
						:style="selectionStyle"
						aria-hidden="true"
					>
						{{ wallTime(column.day, Math.min(selection.from, selection.to)).slice(11) }}
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
		<p class="calendar-time-help">
			{{ t('calendar.timeGridHint') }}
		</p>
		<p class="calendar-time-help">
			{{ t('calendar.dragHint') }}
		</p>
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
	margin-block: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.calendar-time-scroll {
	position: relative;
	block-size: max(20rem, calc(100dvh - var(--header-height) - var(--page-gutter) - var(--calendar-command-height, 8rem) - 4rem));
	min-block-size: 20rem;
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
.calendar-time-header-shell {
	position: sticky;
	z-index: 5;
	inset-block-start: 0;
	inline-size: max-content;
	min-inline-size: 100%;
	background: var(--surface);
}
.calendar-time-header, .calendar-time-body, .calendar-all-day-strip {
	display: grid;
}
.calendar-time-header {
	border-block-end: 1px solid var(--border-subtle);
}
.calendar-ruler-heading, .calendar-all-day-label {
	position: sticky;
	z-index: 2;
	inset-inline-start: 0;
	display: grid;
	padding: var(--space-1);
	background: var(--surface);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	place-items: center;
	overflow-wrap: anywhere;
}
.calendar-time-date {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	min-block-size: 3.5rem;
	padding: var(--space-1);
	border: 0;
	border-inline-start: 1px solid var(--border-subtle);
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
		flex-shrink: 0;
		inline-size: 2rem;
		block-size: 2rem;
		border-radius: 50%;
		color: var(--text-primary);
		font-size: var(--text-lg);
		place-items: center;
	}
	time.is-today {
		background: var(--primary);
		color: var(--text-on-accent);
	}
	small {
		color: var(--text-tertiary);
		font-size: var(--text-2xs);
	}
}
.calendar-all-day-strip {
	border-block-end: 1px solid var(--border-subtle);
}
.calendar-all-day-cell {
	display: grid;
	align-content: start;
	gap: 2px;
	min-block-size: 2.25rem;
	padding: 3px;
	border-inline-start: 1px solid var(--border-subtle);
}
.calendar-all-day-add, .calendar-all-day-more {
	min-block-size: 1.75rem;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-tertiary);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;
}
.calendar-all-day-add {
	opacity: 0;
}
.calendar-all-day-cell:hover .calendar-all-day-add, .calendar-all-day-add:focus-visible {
	opacity: 1;
	background: var(--surface-hover);
}
.calendar-time-ruler {
	position: sticky;
	z-index: 3;
	inset-inline-start: 0;
	border-inline-end: 1px solid var(--border-subtle);
	background: var(--surface);
}
.calendar-ruler-tick {
	position: absolute;
	inset-inline: 0;
	padding: 3px var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	line-height: 1.2;
	text-align: end;
}
.calendar-time-column {
	position: relative;
	min-inline-size: 0;
	border-inline-end: 1px solid var(--border-subtle);
}
.calendar-time-slot {
	position: absolute;
	inset-inline: 0;
	inline-size: 100%;
	padding: 0;
	border: 0;
	border-block-start: 1px solid var(--border-subtle);
	border-radius: 0;
	background: transparent;
	cursor: crosshair;
	&:hover {
		background: color-mix(in srgb, var(--primary) 5%, transparent);
	}
	&:focus-visible {
		z-index: 1;
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
		background: var(--surface-selected);
	}
}
.calendar-variable-tick {
	position: absolute;
	inset-block-start: 2px;
	inset-inline-start: 2px;
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
}
.calendar-time-events {
	position: absolute;
	inset-block: 0;
	inset-inline: 3px;
	pointer-events: none;
}
.calendar-time-placement {
	position: absolute;
	padding: 1px;
	pointer-events: auto;
}
.calendar-time-overflow {
	position: absolute;
	display: flex;
	align-items: flex-start;
	min-inline-size: 0;
	padding: 4px;
	overflow: hidden;
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-sm);
	background: var(--surface-selected);
	color: var(--accent-text);
	font: inherit;
	font-size: var(--text-xs);
	line-height: 18px;
	text-align: start;
	cursor: pointer;
	pointer-events: auto;
	span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
}
.calendar-time-selection {
	position: absolute;
	z-index: 2;
	inset-inline: 3px;
	padding: 3px;
	border: 1px solid var(--primary);
	border-radius: var(--radius-sm);
	background: color-mix(in srgb, var(--primary) 15%, transparent);
	color: var(--accent-text);
	font-size: var(--text-xs);
	pointer-events: none;
}
.calendar-now-line {
	position: absolute;
	z-index: 2;
	inset-inline: 0;
	border-block-start: 2px solid var(--danger);
	pointer-events: none;
	&::before {
		position: absolute;
		inset-block-start: -4px;
		inset-inline-start: -3px;
		inline-size: 6px;
		block-size: 6px;
		border-radius: 50%;
		background: var(--danger);
		content: '';
	}
}
@media (width <= 768px) {
	.calendar-time-scroll {
		block-size: max(20rem, calc(100dvh - var(--header-height) - var(--page-gutter) - var(--calendar-command-height, 10rem) - 8rem));
	}
	.calendar-time-date {
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.calendar-all-day-add {
		opacity: .7;
	}
}
</style>
