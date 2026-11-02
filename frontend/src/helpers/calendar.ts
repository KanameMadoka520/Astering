import {parseDateOrNull} from '@/helpers/parseDateOrNull'
import type {
	CalendarDayBoundary,
	CalendarTask,
} from '@/client/generated'

const MINUTE_MS = 60_000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export type CalendarView = 'month' | 'week' | 'day' | 'agenda'
export type CalendarWeekDays = 3 | 7 | 14

export interface CalendarRange {
	from: string
	/** Exclusive civil date, matching the calendar API. */
	to: string
	dates: string[]
}

export type CalendarDay = Required<CalendarDayBoundary>
export type CalendarItem = Partial<CalendarTask>

export interface CalendarSegment {
	id: string
	taskId: number
	item: CalendarItem
	kind: 'range' | 'start' | 'end' | 'due' | 'all_day'
	date: string
	startMs: number
	endMs: number
	/** Actual elapsed minutes since the server's local midnight, including DST changes. */
	topMinutes: number
	durationMinutes: number
	dayMinutes: number
	continuesBefore: boolean
	continuesAfter: boolean
}

export interface CalendarPlacement extends CalendarSegment {
	column: number
	columnCount: number
	visualTopMinutes: number
	visualDurationMinutes: number
}

function civilDate(value: unknown): Date | null {
	if (typeof value !== 'string') return null
	const match = DATE_PATTERN.exec(value)
	if (!match) return null
	const [year, month, day] = match.slice(1).map(Number)
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
	const date = new Date(0)
	date.setUTCFullYear(year, month - 1, day)
	date.setUTCHours(0, 0, 0, 0)
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
		? date
		: null
}

export function parseCalendarDate(value: unknown): string | null {
	return civilDate(value) ? value as string : null
}

export function clampCalendarDate(value: unknown): string | null {
	const valid = parseCalendarDate(value)
	if (!valid) return null
	// Month padding needs room on both sides of the API's 1970–9998 date domain.
	return valid < '1971-01-01' ? '1971-01-01' : valid > '9997-12-31' ? '9997-12-31' : valid
}

function requiredDate(value: string): Date {
	const date = civilDate(value)
	if (!date) throw new RangeError('Invalid calendar date')
	return date
}

function dateKey(date: Date): string {
	const year = date.getUTCFullYear()
	if (year < 1 || year > 9999) throw new RangeError('Calendar date is outside the supported range')
	return date.toISOString().slice(0, 10)
}

export function addCalendarDays(value: string, amount: number): string {
	if (!Number.isSafeInteger(amount)) throw new RangeError('Invalid calendar day offset')
	const date = requiredDate(value)
	date.setUTCDate(date.getUTCDate() + amount)
	return dateKey(date)
}

export function addCalendarMonths(value: string, amount: number): string {
	if (!Number.isSafeInteger(amount)) throw new RangeError('Invalid calendar month offset')
	const date = requiredDate(value)
	const day = date.getUTCDate()
	date.setUTCDate(1)
	date.setUTCMonth(date.getUTCMonth() + amount)
	const last = new Date(date)
	last.setUTCMonth(last.getUTCMonth() + 1, 0)
	date.setUTCDate(Math.min(day, last.getUTCDate()))
	return dateKey(date)
}

export function calendarRange(
	view: CalendarView,
	value: string,
	weekStart = 0,
	dayCount: CalendarWeekDays = 7,
): CalendarRange {
	const date = requiredDate(clampCalendarDate(value) ?? value)
	const start = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 0
	let length = 1
	if (view === 'month') {
		date.setUTCDate(1)
		date.setUTCDate(1 - (date.getUTCDay() - start + 7) % 7)
		length = 42
	} else if (view === 'week') {
		if (dayCount !== 3) date.setUTCDate(date.getUTCDate() - (date.getUTCDay() - start + 7) % 7)
		length = dayCount === 3 || dayCount === 14 ? dayCount : 7
	} else if (view === 'agenda') {
		length = 14
	}
	const from = dateKey(date)
	return {
		from,
		to: addCalendarDays(from, length),
		dates: Array.from({length}, (_, index) => addCalendarDays(from, index)),
	}
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = JSON.stringify([locale, options])
	const cached = formatters.get(key)
	if (cached) return cached
	const created = new Intl.DateTimeFormat(locale, options)
	if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!)
	formatters.set(key, created)
	return created
}

export function calendarDateAt(value: Date | string | null | undefined, timeZone: string): string {
	const date = parseDateOrNull(value)
	if (!date) return ''
	try {
		const parts = formatter('en-US-u-ca-gregory-nu-latn', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(date)
		const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
		return parseCalendarDate(`${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`) ?? ''
	} catch {
		return ''
	}
}

export function calendarDateLabel(
	value: string,
	locale: string,
	options: Intl.DateTimeFormatOptions = {dateStyle: 'medium'},
): string {
	const date = civilDate(value)
	if (!date) return ''
	return formatter(locale, {
		...options,
		timeZone: 'UTC',
	}).format(date)
}

export function calendarTimeLabel(
	value: Date | string | null | undefined,
	timeZone: string,
	locale: string,
	hour12 = false,
	showOffset = false,
): string {
	const date = parseDateOrNull(value)
	if (!date) return ''
	return formatter(locale, {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		...hour12 ? {hour12: true} : {hourCycle: 'h23'},
		...showOffset ? {timeZoneName: 'shortOffset'} : {},
	}).format(date)
}

export function calendarHourHeight(zoomPercent: number): number {
	return Math.max(25, Math.min(250, Number.isFinite(zoomPercent) ? zoomPercent : 100)) * 0.64
}

export type CalendarWallTime =
	| {
		kind: 'valid'
		instant: string
	}
	| {
		kind: 'ambiguous'
		instants: string[]
	}
	| {kind: 'invalid'}

function wallClockStamp(instant: number, timeZone: string): number | null {
	const parts = formatter('en-US-u-ca-gregory-nu-latn', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(instant)
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
	const date = civilDate(`${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`)
	if (!date) return null
	date.setUTCHours(Number(part('hour')), Number(part('minute')), Number(part('second')), 0)
	return date.getTime()
}

export function resolveCalendarWallTime(value: string, timeZone: string): CalendarWallTime {
	const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
	const date = match ? civilDate(match[1]) : null
	if (!match || !date) return {kind: 'invalid'}
	date.setUTCHours(Number(match[2]), Number(match[3]), 0, 0)
	const naive = date.getTime()
	const offsets = new Set<number>()
	try {
		// Sample both sides of DST and whole-day changes; every candidate must round-trip exactly.
		for (let hours = -48; hours <= 48; hours += 6) {
			const probe = naive + hours * 60 * MINUTE_MS
			const stamp = wallClockStamp(probe, timeZone)
			if (stamp !== null) offsets.add(stamp - probe)
		}
		const instants = [...offsets]
			.map(offset => naive - offset)
			.filter(instant => wallClockStamp(instant, timeZone) === naive)
			.sort((a, b) => a - b)
			.map(instant => new Date(instant).toISOString())
		if (instants.length === 1) return {
			kind: 'valid',
			instant: instants[0],
		}
		if (instants.length > 1) return {
			kind: 'ambiguous',
			instants,
		}
	} catch {
		return {kind: 'invalid'}
	}
	return {kind: 'invalid'}
}

interface DayWindow {
	date: string
	startMs: number
	endMs: number
}

function dayWindows(days: readonly CalendarDay[]): DayWindow[] {
	const seen = new Set<string>()
	return days.flatMap(day => {
		const start = parseDateOrNull(day.start_at)
		const end = parseDateOrNull(day.end_at)
		if (!parseCalendarDate(day.date) || !start || !end || start >= end || seen.has(day.date)) return []
		seen.add(day.date)
		return [{
			date: day.date,
			startMs: start.getTime(),
			endMs: end.getTime(),
		}]
	}).sort((a, b) => a.startMs - b.startMs)
}

function firstWindow(windows: readonly DayWindow[], instant: number): number {
	let low = 0
	let high = windows.length
	while (low < high) {
		const middle = Math.floor((low + high) / 2)
		if (windows[middle].endMs <= instant) low = middle + 1
		else high = middle
	}
	return low
}

function segment(
	item: CalendarItem,
	taskId: number,
	kind: CalendarSegment['kind'],
	day: DayWindow,
	start: number,
	end: number,
): CalendarSegment {
	const startMs = Math.max(start, day.startMs)
	const endMs = Math.min(end, day.endMs)
	return {
		id: `${taskId}:${kind}:${day.date}`,
		taskId,
		item,
		kind,
		date: day.date,
		startMs,
		endMs,
		topMinutes: (startMs - day.startMs) / MINUTE_MS,
		durationMinutes: (endMs - startMs) / MINUTE_MS,
		dayMinutes: (day.endMs - day.startMs) / MINUTE_MS,
		continuesBefore: start < day.startMs,
		continuesAfter: end > day.endMs,
	}
}

export function calendarSegments(
	items: readonly CalendarItem[],
	days: readonly CalendarDay[],
): Map<string, CalendarSegment[]> {
	const windows = dayWindows(days)
	const result = new Map(windows.map(day => [day.date, [] as CalendarSegment[]]))
	const seen = new Set<number>()
	const point = (item: CalendarItem, taskId: number, kind: CalendarSegment['kind'], instant: number) => {
		const day = windows[firstWindow(windows, instant)]
		if (day && instant >= day.startMs) result.get(day.date)!.push(segment(item, taskId, kind, day, instant, instant))
	}
	for (const item of items) {
		const taskId = item.id
		if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0 || seen.has(taskId)) continue
		seen.add(taskId)
		const start = parseDateOrNull(item.start_date)?.getTime()
		const end = parseDateOrNull(item.end_date)?.getTime()
		const due = parseDateOrNull(item.due_date)?.getTime()
		if (item.all_day && parseCalendarDate(item.all_day_start) && parseCalendarDate(item.all_day_end)) {
			for (const day of windows) {
				if (day.date < item.all_day_start! || day.date >= item.all_day_end!) continue
				result.get(day.date)!.push({
					...segment(item, taskId, 'all_day', day, day.startMs, day.endMs),
					continuesBefore: day.date > item.all_day_start!,
					continuesAfter: addCalendarDays(day.date, 1) < item.all_day_end!,
				})
			}
		} else if (start !== undefined && end !== undefined && start < end) {
			for (let index = firstWindow(windows, start); index < windows.length && windows[index].startMs < end; index++) {
				const day = windows[index]
				result.get(day.date)!.push(segment(item, taskId, 'range', day, start, end))
			}
		} else {
			if (start !== undefined) point(item, taskId, 'start', start)
			if (end !== undefined && end !== start) point(item, taskId, 'end', end)
		}
		if (due !== undefined) point(item, taskId, 'due', due)
	}
	for (const segments of result.values()) {
		segments.sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs || compareId(a.id, b.id))
	}
	return result
}

function compareId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

class MinHeap<T> {
	private values: T[] = []

	constructor(private compare: (a: T, b: T) => number) {}

	get size(): number {
		return this.values.length
	}

	peek(): T | undefined {
		return this.values[0]
	}

	push(value: T) {
		let index = this.values.length
		this.values.push(value)
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2)
			if (this.compare(this.values[parent], value) <= 0) break
			this.values[index] = this.values[parent]
			index = parent
		}
		this.values[index] = value
	}

	pop(): T | undefined {
		const result = this.values[0]
		const tail = this.values.pop()
		if (this.values.length && tail !== undefined) {
			let index = 0
			while (index * 2 + 1 < this.values.length) {
				let child = index * 2 + 1
				if (child + 1 < this.values.length && this.compare(this.values[child + 1], this.values[child]) < 0) child++
				if (this.compare(tail, this.values[child]) <= 0) break
				this.values[index] = this.values[child]
				index = child
			}
			this.values[index] = tail
		}
		return result
	}
}

function layoutDay(segments: readonly CalendarSegment[], minimum: number): CalendarPlacement[] {
	const placements = segments.map(event => {
		const duration = Math.min(event.dayMinutes, Math.max(event.durationMinutes, minimum))
		return {
			...event,
			column: 0,
			columnCount: 1,
			visualTopMinutes: Math.max(0, Math.min(event.topMinutes, event.dayMinutes - duration)),
			visualDurationMinutes: duration,
		}
	}).sort((a, b) => a.visualTopMinutes - b.visualTopMinutes
		|| b.visualDurationMinutes - a.visualDurationMinutes
		|| compareId(a.id, b.id))
	const active = new MinHeap<{
		end: number
		column: number
	}>((a, b) => a.end - b.end || a.column - b.column)
	const free = new MinHeap<number>((a, b) => a - b)
	let nextColumn = 0
	let groupStart = 0
	const finishGroup = (until: number) => {
		for (let index = groupStart; index < until; index++) placements[index].columnCount = nextColumn
		groupStart = until
	}
	for (let index = 0; index < placements.length; index++) {
		const event = placements[index]
		while (active.peek() && active.peek()!.end <= event.visualTopMinutes) free.push(active.pop()!.column)
		if (active.size === 0) {
			finishGroup(index)
			nextColumn = 0
			while (free.size) free.pop()
		}
		event.column = free.pop() ?? nextColumn++
		active.push({
			end: event.visualTopMinutes + event.visualDurationMinutes,
			column: event.column,
		})
	}
	finishGroup(placements.length)
	return placements
}

export function layoutTimedEvents(
	segments: readonly CalendarSegment[],
	minimumVisualMinutes = 15,
): CalendarPlacement[] {
	const minimum = Number.isFinite(minimumVisualMinutes) ? Math.max(1, minimumVisualMinutes) : 15
	const days = new Map<string, CalendarSegment[]>()
	for (const event of segments) {
		const current = days.get(event.date) ?? []
		current.push(event)
		days.set(event.date, current)
	}
	return [...days.entries()]
		.sort(([a], [b]) => compareId(a, b))
		.flatMap(([, events]) => layoutDay(events, minimum))
}

export interface CalendarTimelineOverflow {
	id: string
	date: string
	visualTopMinutes: number
	visualDurationMinutes: number
	column: number
	columnCount: number
	segments: CalendarSegment[]
}

/** Keep readable columns bounded; crowded groups open the same complete day agenda. */
export function layoutCalendarTimeline(
	segments: readonly CalendarSegment[],
	minimumVisualMinutes: number,
	maximumColumns: number,
): {
	events: CalendarPlacement[]
	overflow: CalendarTimelineOverflow[]
} {
	const maximum = Number.isFinite(maximumColumns) ? Math.max(1, Math.floor(maximumColumns)) : 1
	const placements = layoutTimedEvents(segments.filter(event => event.kind !== 'all_day'), minimumVisualMinutes)
	const events: CalendarPlacement[] = []
	const overflow: CalendarTimelineOverflow[] = []
	let group: CalendarPlacement[] = []
	let groupEnd = 0
	const finish = () => {
		if (!group.length) return
		if (group[0].columnCount <= maximum) {
			for (const event of group) events.push(event)
			return
		}
		const hidden = group.filter(event => event.column >= maximum - 1)
		events.push(...group.filter(event => event.column < maximum - 1).map(event => ({
			...event,
			columnCount: maximum,
		})))
		let top = Number.POSITIVE_INFINITY
		let end = 0
		for (const event of hidden) {
			top = Math.min(top, event.visualTopMinutes)
			end = Math.max(end, event.visualTopMinutes + event.visualDurationMinutes)
		}
		overflow.push({
			id: `overflow:${group[0].id}`,
			date: group[0].date,
			visualTopMinutes: top,
			visualDurationMinutes: end - top,
			column: maximum - 1,
			columnCount: maximum,
			segments: hidden,
		})
	}
	for (const event of placements) {
		if (group.length && (event.date !== group[0].date || event.visualTopMinutes >= groupEnd)) {
			finish()
			group = []
			groupEnd = 0
		}
		group.push(event)
		groupEnd = Math.max(groupEnd, event.visualTopMinutes + event.visualDurationMinutes)
	}
	finish()
	return {events, overflow}
}
