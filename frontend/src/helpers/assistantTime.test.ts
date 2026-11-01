import {afterEach, describe, expect, it} from 'vitest'

import {
	ASSISTANT_TIME_ZONE,
	ASSISTANT_ZONE_LABEL,
	assistantDay,
	assistantInstant,
	compactAssistantTime,
	msUntilNextAssistantDay,
	type AssistantInstant,
} from './assistantTime'

const originalTimeZone = process.env.TZ

afterEach(() => {
	if (originalTimeZone === undefined) delete process.env.TZ
	else process.env.TZ = originalTimeZone
})

function instantOf(value: string): AssistantInstant {
	const instant = assistantInstant(value)
	if (!instant) throw new Error(`expected ${value} to be a valid instant`)
	return instant
}

const shanghaiParts = new Intl.DateTimeFormat('en-CA', {
	timeZone: ASSISTANT_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
})

function namedZoneFull(ms: number): string {
	const parts = Object.fromEntries(shanghaiParts.formatToParts(new Date(ms)).map(part => [part.type, part.value]))
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} GMT+8`
}

describe('assistantInstant', () => {
	it('converts a UTC server timestamp to GMT+8', () => {
		expect(assistantInstant('2026-11-01T06:03:27Z')).toEqual({
			ms: Date.UTC(2026, 10, 1, 6, 3, 27),
			iso: '2026-11-01T14:03:27+08:00',
			full: '2026-11-01 14:03:27 GMT+8',
			day: '2026-11-01',
			time: '14:03',
		})
	})

	it('moves the calendar day across GMT+8 midnight', () => {
		const afterMidnight = instantOf('2026-10-31T16:30:00Z')
		expect(afterMidnight.day).toBe('2026-11-01')
		expect(afterMidnight.time).toBe('00:30')
		expect(afterMidnight.iso).toBe('2026-11-01T00:30:00+08:00')

		expect(instantOf('2026-11-01T15:59:59Z').full).toBe('2026-11-01 23:59:59 GMT+8')
		expect(instantOf('2026-11-01T16:00:00Z').full).toBe('2026-11-02 00:00:00 GMT+8')
	})

	it('accepts timestamps written with other offsets', () => {
		const instant = instantOf('2026-11-01T09:00:00-05:00')
		expect(instant.full).toBe('2026-11-01 22:00:00 GMT+8')
		expect(instant.iso).toBe('2026-11-01T22:00:00+08:00')
		expect(instantOf('2026-11-01T14:03:27.987+08:00').iso).toBe('2026-11-01T14:03:27+08:00')
	})

	it.each([
		'2026-11-01T06:03:27Z',
		'2026-10-31T16:30:00Z',
		'2026-12-31T16:00:00Z',
		'2024-02-28T16:00:00Z',
		'2000-06-15T23:59:59Z',
		'1992-04-12T03:00:00Z',
		'2038-01-19T03:14:07Z',
	])('matches the named Asia/Shanghai zone for %s', value => {
		const instant = instantOf(value)
		expect(instant.full).toBe(namedZoneFull(instant.ms))
		expect(assistantDay(instant.ms)).toBe(instant.day)
	})

	it.each([
		['America/Los_Angeles', 23],
		['Pacific/Kiritimati', 20],
		['Asia/Tokyo', 15],
	])('ignores the browser zone %s', (timeZone, localHour) => {
		process.env.TZ = timeZone
		// Proves the runtime really switched zones, otherwise the helper assertions below prove nothing.
		expect(new Date('2026-11-01T06:03:27Z').getHours()).toBe(localHour)

		const instant = instantOf('2026-11-01T06:03:27Z')
		expect(instant.iso).toBe('2026-11-01T14:03:27+08:00')
		expect(instant.full).toBe('2026-11-01 14:03:27 GMT+8')
		expect(instant.day).toBe('2026-11-01')
		expect(instant.time).toBe('14:03')
		expect(instantOf('2026-10-31T16:30:00Z').day).toBe('2026-11-01')
		expect(assistantDay(Date.UTC(2026, 9, 31, 16, 30))).toBe('2026-11-01')
		expect(msUntilNextAssistantDay(Date.UTC(2026, 10, 1, 15, 59, 59))).toBe(1000)
	})

	it.each([
		undefined,
		null,
		'',
		'   ',
		'not a date',
		'0001-01-01T00:00:00Z',
		'1970-01-01T00:00:00Z',
		'1969-12-31T23:59:59Z',
		1730000000000,
		{},
		new Date('2026-11-01T06:03:27Z'),
	])('returns null for %j', value => {
		expect(assistantInstant(value)).toBeNull()
	})
})

describe('compactAssistantTime', () => {
	const instant = instantOf('2026-11-01T06:03:27Z')

	it('shows only the time for today', () => {
		expect(compactAssistantTime(instant, '2026-11-01')).toBe('14:03 GMT+8')
	})

	it('adds month and day for other days of the same year', () => {
		expect(compactAssistantTime(instant, '2026-11-02')).toBe('11-01 14:03 GMT+8')
		expect(compactAssistantTime(instant, '2026-01-01')).toBe('11-01 14:03 GMT+8')
	})

	it('adds the full date for other years', () => {
		expect(compactAssistantTime(instant, '2027-01-01')).toBe('2026-11-01 14:03 GMT+8')
		expect(compactAssistantTime(instantOf('2025-11-01T06:03:27Z'), '2026-11-01')).toBe('2025-11-01 14:03 GMT+8')
		expect(compactAssistantTime(instant, '')).toBe('2026-11-01 14:03 GMT+8')
	})

	it('keeps the date for an instant just past GMT+8 midnight seen from the previous day', () => {
		expect(compactAssistantTime(instantOf('2026-10-31T16:30:00Z'), '2026-10-31')).toBe('11-01 00:30 GMT+8')
	})

	it('always names the zone', () => {
		for (const today of ['2026-11-01', '2026-11-02', '2025-11-01']) {
			expect(compactAssistantTime(instant, today)).toContain(ASSISTANT_ZONE_LABEL)
		}
	})
})

describe('msUntilNextAssistantDay', () => {
	it('counts down to the next GMT+8 midnight', () => {
		expect(msUntilNextAssistantDay(Date.parse('2026-11-01T15:59:59.000Z'))).toBe(1000)
		expect(msUntilNextAssistantDay(Date.parse('2026-11-01T15:59:00.000Z'))).toBe(60_000)
		expect(msUntilNextAssistantDay(Date.parse('2026-11-01T06:03:27.000Z'))).toBe(9 * 3600_000 + 56 * 60_000 + 33_000)
	})

	it('waits a full day when called exactly at midnight', () => {
		expect(msUntilNextAssistantDay(Date.parse('2026-11-01T16:00:00.000Z'))).toBe(86_400_000)
		expect(msUntilNextAssistantDay(Date.parse('2026-11-01T16:00:00.001Z'))).toBe(86_399_999)
	})

	it('lands on the day after the current one', () => {
		const now = Date.parse('2026-12-31T20:15:00.000Z')
		expect(assistantDay(now)).toBe('2027-01-01')
		expect(assistantDay(now + msUntilNextAssistantDay(now))).toBe('2027-01-02')
		expect(assistantDay(now + msUntilNextAssistantDay(now) - 1)).toBe('2027-01-01')
	})
})
