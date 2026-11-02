import {describe, expect, it} from 'vitest'

import {
	addCalendarDays,
	addCalendarMonths,
	calendarDateAt,
	calendarDateLabel,
	calendarHourHeight,
	calendarRange,
	calendarSegments,
	calendarTimeLabel,
	clampCalendarDate,
	layoutTimedEvents,
	parseCalendarDate,
	resolveCalendarWallTime,
	type CalendarDay,
	type CalendarItem,
	type CalendarSegment,
} from './calendar'

const SHANGHAI_DAYS: CalendarDay[] = [
	{
		date: '2026-11-03',
		start_at: '2026-11-02T16:00:00Z',
		end_at: '2026-11-03T16:00:00Z',
	},
	{
		date: '2026-11-04',
		start_at: '2026-11-03T16:00:00Z',
		end_at: '2026-11-04T16:00:00Z',
	},
	{
		date: '2026-11-05',
		start_at: '2026-11-04T16:00:00Z',
		end_at: '2026-11-05T16:00:00Z',
	},
]

function task(
	id: number,
	start_date?: string,
	end_date?: string,
	due_date?: string,
): CalendarItem {
	return {
		id,
		start_date,
		end_date,
		due_date,
	}
}

function firstDay(items: CalendarItem[]): CalendarSegment[] {
	return calendarSegments(items, SHANGHAI_DAYS).get('2026-11-03')!
}

describe('calendar civil dates and ranges', () => {
	it('strictly validates real civil dates without rolling invalid dates or accepting timestamps', () => {
		for (const invalid of [undefined, null, 20261103, '', '2026-2-03', '2026-02-29', '2024-02-30',
			'0000-01-01', '2026-13-01', '2026-11-03T00:00:00Z', '2026-11-03tail']) {
			expect(parseCalendarDate(invalid)).toBeNull()
		}
		expect(parseCalendarDate('2024-02-29')).toBe('2024-02-29')
		expect(parseCalendarDate('0001-01-01')).toBe('0001-01-01')
		expect(addCalendarDays('0099-12-31', 1)).toBe('0100-01-01')
		expect(() => calendarRange('day', '2026-02-29')).toThrow(RangeError)
	})

	it('advances calendar dates and clamps month navigation without changing civil time zones', () => {
		expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
		expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31')
		expect(addCalendarMonths('2024-01-31', 1)).toBe('2024-02-29')
		expect(addCalendarMonths('2026-03-31', -1)).toBe('2026-02-28')
		expect(addCalendarMonths('2026-11-30', 2)).toBe('2027-01-30')
		expect(() => addCalendarDays('2026-11-03', 0.5)).toThrow(RangeError)
	})

	it('builds 42 month cells from the configured week start with an exclusive API end', () => {
		const range = calendarRange('month', '2026-11-17', 1)
		expect(range.from).toBe('2026-10-26')
		expect(range.to).toBe('2026-12-07')
		expect(range.dates).toHaveLength(42)
		expect(range.dates.at(-1)).toBe('2026-12-06')
		expect(new Set(range.dates).size).toBe(42)
		expect(calendarRange('month', '2026-11-17', 0).from).toBe('2026-11-01')
	})

	it('clamps URL anchors so month padding and exclusive ends stay inside the API date domain', () => {
		expect(clampCalendarDate('1969-12-31')).toBe('1971-01-01')
		expect(clampCalendarDate('9999-01-01')).toBe('9997-12-31')
		expect(clampCalendarDate('2026-11-03')).toBe('2026-11-03')
		expect(clampCalendarDate('2026-02-30')).toBeNull()
		for (const input of ['0001-01-01', '1971-01-01', '9997-12-31', '9999-12-31']) {
			const range = calendarRange('month', input, 1)
			expect(range.dates).toHaveLength(42)
			expect(range.from >= '1970-01-01').toBe(true)
			expect(range.to < '9999-01-01').toBe(true)
		}
	})

	it('aligns whole weeks while three-day navigation advances without snapping to the same week', () => {
		expect(calendarRange('week', '2026-11-03', 1)).toMatchObject({
			from: '2026-11-02',
			to: '2026-11-09',
		})
		expect(calendarRange('week', '2026-11-03', 1, 14)).toMatchObject({
			from: '2026-11-02',
			to: '2026-11-16',
		})
		const range = calendarRange('week', '2026-11-03', 1, 3)
		expect(range).toEqual({
			from: '2026-11-03',
			to: '2026-11-06',
			dates: ['2026-11-03', '2026-11-04', '2026-11-05'],
		})
		expect(calendarRange('week', range.to, 1, 3).from).toBe('2026-11-06')
		expect(calendarRange('day', '2026-11-03').dates).toEqual(['2026-11-03'])
		expect(calendarRange('agenda', '2026-11-03').to).toBe('2026-11-17')
		expect(calendarRange('agenda', '2026-11-03').dates).toHaveLength(14)
	})
})

describe('calendar formatting and zoom', () => {
	it('uses the requested account zone and keeps civil date labels anchored', () => {
		const instant = '2026-11-02T16:30:00Z'
		expect(calendarDateAt(instant, 'Asia/Shanghai')).toBe('2026-11-03')
		expect(calendarDateAt(instant, 'America/Los_Angeles')).toBe('2026-11-02')
		expect(calendarTimeLabel(instant, 'Asia/Shanghai', 'en-US')).toBe('00:30')
		expect(calendarDateLabel('2026-11-03', 'en-US', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZone: 'America/Los_Angeles',
		})).toBe('November 3, 2026')
		expect(calendarDateAt(instant, 'Invalid/Timezone')).toBe('')
		expect(calendarDateAt('0001-01-01T00:00:00Z', 'UTC')).toBe('')
		expect(calendarDateLabel('2026-02-30', 'en-US')).toBe('')
	})

	it('distinguishes both repeated local hours by offset and bounds wide desktop zoom', () => {
		expect(calendarTimeLabel('2026-11-01T05:30:00Z', 'America/New_York', 'en-US', false, true))
			.toBe('01:30 GMT-4')
		expect(calendarTimeLabel('2026-11-01T06:30:00Z', 'America/New_York', 'en-US', false, true))
			.toBe('01:30 GMT-5')
		expect(calendarHourHeight(25)).toBe(16)
		expect(calendarHourHeight(250)).toBe(160)
		expect(calendarHourHeight(-50)).toBe(16)
		expect(calendarHourHeight(900)).toBe(160)
		expect(calendarHourHeight(Number.NaN)).toBe(64)
	})
})

describe('resolveCalendarWallTime', () => {
	it('resolves an explicit account zone and fractional-hour offsets independently of the browser', () => {
		expect(resolveCalendarWallTime('2026-11-03T09:30', 'Asia/Shanghai')).toEqual({
			kind: 'valid',
			instant: '2026-11-03T01:30:00.000Z',
		})
		expect(resolveCalendarWallTime('2026-11-03T09:30', 'Asia/Kolkata')).toEqual({
			kind: 'valid',
			instant: '2026-11-03T04:00:00.000Z',
		})
		expect(resolveCalendarWallTime('2026-11-03T09:30', 'Asia/Kathmandu')).toEqual({
			kind: 'valid',
			instant: '2026-11-03T03:45:00.000Z',
		})
	})

	it('rejects DST gaps and skipped dates without advancing the requested wall time', () => {
		expect(resolveCalendarWallTime('2026-03-08T02:30', 'America/New_York')).toEqual({kind: 'invalid'})
		expect(resolveCalendarWallTime('2026-10-04T02:15', 'Australia/Lord_Howe')).toEqual({kind: 'invalid'})
		expect(resolveCalendarWallTime('2011-12-30T12:00', 'Pacific/Apia')).toEqual({kind: 'invalid'})
	})

	it('returns both fall-back instants in actual chronological order, including half-hour folds', () => {
		expect(resolveCalendarWallTime('2026-11-01T01:30', 'America/New_York')).toEqual({
			kind: 'ambiguous',
			instants: ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
		})
		expect(resolveCalendarWallTime('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual({
			kind: 'ambiguous',
			instants: ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'],
		})
	})

	it('fails closed for invalid input instead of using an implicit browser zone', () => {
		for (const invalid of ['2026-02-29T12:00', '2026-11-03T24:00', '2026-11-03T09:60',
			'2026-11-03 09:30', '2026-11-03T09:30:00', '2026-11-03T09:30Z']) {
			expect(resolveCalendarWallTime(invalid, 'UTC')).toEqual({kind: 'invalid'})
		}
		expect(resolveCalendarWallTime('2026-11-03T09:30', 'Invalid/Zone')).toEqual({kind: 'invalid'})
	})
})

describe('calendarSegments', () => {
	it('clips cross-day intervals at real midnight and never creates an empty next-day tail', () => {
		const item = task(1, '2026-11-02T23:00:00+08:00', '2026-11-05T00:00:00+08:00')
		const result = calendarSegments([item], SHANGHAI_DAYS)
		expect(result.get('2026-11-03')).toEqual([expect.objectContaining({
			id: '1:range:2026-11-03',
			item,
			startMs: Date.parse('2026-11-03T00:00:00+08:00'),
			endMs: Date.parse('2026-11-04T00:00:00+08:00'),
			topMinutes: 0,
			durationMinutes: 1440,
			continuesBefore: true,
			continuesAfter: true,
		})])
		expect(result.get('2026-11-04')?.[0]).toMatchObject({
			continuesBefore: true,
			continuesAfter: false,
			durationMinutes: 1440,
		})
		expect(result.get('2026-11-05')).toEqual([])
	})

	it('keeps cutoff points separate from ranges and never treats due as an inferred end', () => {
		const segments = firstDay([
			task(1, '2026-11-03T09:00:00+08:00', '2026-11-03T10:00:00+08:00', '2026-11-03T11:00:00+08:00'),
			task(2, '2026-11-03T12:00:00+08:00', undefined, '2026-11-03T13:00:00+08:00'),
			task(3, undefined, '2026-11-03T14:00:00+08:00'),
		])
		expect(segments.map(event => `${event.taskId}:${event.kind}`)).toEqual([
			'1:range', '1:due', '2:start', '2:due', '3:end',
		])
		expect(segments.find(event => event.kind === 'range')?.durationMinutes).toBe(60)
		expect(segments.filter(event => event.kind !== 'range').every(event => event.durationMinutes === 0)).toBe(true)
	})

	it('keeps exact seconds, exposes reverse bounds as points and collapses identical endpoints', () => {
		const segments = firstDay([
			task(1, '2026-11-03T09:00:30+08:00', '2026-11-03T09:01:15+08:00'),
			task(2, '2026-11-03T12:00:00+08:00', '2026-11-03T11:00:00+08:00'),
			task(3, '2026-11-03T14:00:00+08:00', '2026-11-03T14:00:00+08:00'),
		])
		expect(segments.find(event => event.taskId === 1)).toMatchObject({
			topMinutes: 540.5,
			durationMinutes: 0.75,
		})
		expect(segments.filter(event => event.taskId === 2).map(event => event.kind)).toEqual(['end', 'start'])
		expect(segments.filter(event => event.taskId === 3).map(event => event.kind)).toEqual(['start'])
	})

	it('excludes the right API boundary, ignores missing dates and deduplicates task identities', () => {
		const due = task(1, undefined, undefined, '2026-11-03T00:00:00+08:00')
		const result = calendarSegments([
			due,
			due,
			task(2, undefined, undefined, '2026-11-06T00:00:00+08:00'),
			task(3, '0001-01-01T00:00:00Z', 'invalid'),
			{},
		], [...SHANGHAI_DAYS].reverse())
		expect([...result.values()].flat()).toHaveLength(1)
		expect(result.get('2026-11-03')?.[0]).toMatchObject({
			kind: 'due',
			topMinutes: 0,
		})
	})

	it('uses 23-hour spring and 25-hour fall days rather than wall-clock subtraction', () => {
		const spring: CalendarDay = {
			date: '2026-03-08',
			start_at: '2026-03-08T05:00:00Z',
			end_at: '2026-03-09T04:00:00Z',
		}
		const fall: CalendarDay = {
			date: '2026-11-01',
			start_at: '2026-11-01T04:00:00Z',
			end_at: '2026-11-02T05:00:00Z',
		}
		const result = calendarSegments([
			task(1, '2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00'),
			task(2, '2026-11-01T01:50:00-04:00', '2026-11-01T01:10:00-05:00'),
		], [spring, fall])
		expect(result.get(spring.date)?.[0]).toMatchObject({
			topMinutes: 90,
			durationMinutes: 60,
			dayMinutes: 1380,
		})
		expect(result.get(fall.date)?.[0]).toMatchObject({
			topMinutes: 110,
			durationMinutes: 20,
			dayMinutes: 1500,
		})
	})
})

describe('layoutTimedEvents', () => {
	it('gives adjoining events full width and only splits genuinely overlapping groups', () => {
		const result = layoutTimedEvents(firstDay([
			task(1, '2026-11-03T09:00:00+08:00', '2026-11-03T10:00:00+08:00'),
			task(2, '2026-11-03T10:00:00+08:00', '2026-11-03T11:00:00+08:00'),
			task(3, '2026-11-03T10:30:00+08:00', '2026-11-03T11:30:00+08:00'),
			task(4, '2026-11-03T13:00:00+08:00', '2026-11-03T14:00:00+08:00'),
		]))
		expect(result.map(event => [event.taskId, event.column, event.columnCount])).toEqual([
			[1, 0, 1],
			[2, 0, 2],
			[3, 1, 2],
			[4, 0, 1],
		])
	})

	it('reuses the smallest available lane and keeps chain groups stable across input order', () => {
		const segments = firstDay([
			task(1, '2026-11-03T09:00:00+08:00', '2026-11-03T12:00:00+08:00'),
			task(2, '2026-11-03T10:00:00+08:00', '2026-11-03T11:00:00+08:00'),
			task(3, '2026-11-03T11:00:00+08:00', '2026-11-03T13:00:00+08:00'),
			task(4, '2026-11-03T11:30:00+08:00', '2026-11-03T11:45:00+08:00'),
		])
		const result = layoutTimedEvents(segments)
		expect(result.map(event => [event.taskId, event.column, event.columnCount])).toEqual([
			[1, 0, 3],
			[2, 1, 3],
			[3, 1, 3],
			[4, 2, 3],
		])
		expect(layoutTimedEvents([...segments].reverse())).toEqual(result)
		expect(segments.every(event => !('column' in event))).toBe(true)
	})

	it('reserves visual collision space for short events and contains midnight markers in their day', () => {
		const result = layoutTimedEvents(firstDay([
			task(1, '2026-11-03T09:00:00+08:00', '2026-11-03T09:01:00+08:00'),
			task(2, '2026-11-03T09:05:00+08:00', '2026-11-03T09:06:00+08:00'),
			task(3, undefined, undefined, '2026-11-03T23:59:00+08:00'),
		]), 20)
		expect(result.slice(0, 2).map(event => event.columnCount)).toEqual([2, 2])
		expect(result[2]).toMatchObject({
			topMinutes: 1439,
			durationMinutes: 0,
			visualTopMinutes: 1420,
			visualDurationMinutes: 20,
		})
		expect(result.every(event => event.visualTopMinutes + event.visualDurationMinutes <= event.dayMinutes)).toBe(true)
	})

	it('does not collide equal wall-clock times in different days or collapse repeated DST hours', () => {
		const result = layoutTimedEvents([...calendarSegments([
			task(1, undefined, undefined, '2026-11-03T09:00:00+08:00'),
			task(2, undefined, undefined, '2026-11-04T09:00:00+08:00'),
		], SHANGHAI_DAYS).values()].flat())
		expect(result.map(event => event.columnCount)).toEqual([1, 1])
		const fall: CalendarDay = {
			date: '2026-11-01',
			start_at: '2026-11-01T04:00:00Z',
			end_at: '2026-11-02T05:00:00Z',
		}
		const segments = calendarSegments([
			task(1, '2026-11-01T01:15:00-04:00', '2026-11-01T01:45:00-04:00'),
			task(2, '2026-11-01T01:15:00-05:00', '2026-11-01T01:45:00-05:00'),
		], [fall]).get(fall.date)!
		expect(layoutTimedEvents(segments).map(event => [event.topMinutes, event.columnCount])).toEqual([
			[75, 1],
			[135, 1],
		])
	})

	it('clips a large synthetic history to visible days and assigns each dense event its own lane', () => {
		const items = Array.from({length: 5000}, (_, index) => task(
			index + 1,
			'2020-01-01T00:00:00Z',
			'2030-01-01T00:00:00Z',
		))
		const grouped = calendarSegments(items, SHANGHAI_DAYS)
		expect([...grouped.values()].flat()).toHaveLength(items.length * SHANGHAI_DAYS.length)
		const result = layoutTimedEvents(grouped.get('2026-11-03')!)
		expect(result).toHaveLength(5000)
		expect(new Set(result.map(event => event.column)).size).toBe(5000)
		expect(result.every(event => event.columnCount === 5000 && event.durationMinutes === 1440)).toBe(true)
	})
})
