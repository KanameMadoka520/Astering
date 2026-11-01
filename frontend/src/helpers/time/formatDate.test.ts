import {beforeEach, describe, expect, it} from 'vitest'
import {createPinia, setActivePinia} from 'pinia'

import {dateIsValid, formatDate, formatDateSince, formatDisplayDateFormat, formatISO} from './formatDate'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {DATE_DISPLAY} from '@/constants/dateDisplay'
import {i18n} from '@/i18n'
import {TIME_FORMAT} from '@/constants/timeFormat'

describe('dateIsValid', () => {
	it.each([
		['a valid date', new Date('2021-02-06T12:00:00Z'), true],
		['a valid date string', '2021-02-06 12:00', true],
		['an invalid date', new Date('not a date'), false],
		['an unparseable string', 'not a date', false],
		['null', null, false],
		['undefined', undefined, false],
		['the api zero time', '0001-01-01T00:00:00Z', false],
	])('returns %s', (_name, date, expected) => {
		expect(dateIsValid(date)).toBe(expected)
	})
})

describe('formatISO', () => {
	it('formats a valid date', () => {
		expect(formatISO(new Date('2021-02-06T12:00:00Z'))).toBe('2021-02-06T12:00:00.000Z')
	})

	it.each([
		['an invalid date', new Date('not a date')],
		['null', null],
		['undefined', undefined],
		['the api zero time', '0001-01-01T00:00:00Z'],
	])('returns an empty string for %s', (_name, date) => {
		expect(formatISO(date)).toBe('')
	})
})

describe('formatDate', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	it('formats a valid date', () => {
		expect(formatDate(new Date(2021, 1, 6, 12, 0), 'YYYY-MM-DD')).toBe('2021-02-06')
	})

	it.each([
		['an invalid date', new Date('not a date')],
		['null', null],
		['undefined', undefined],
		['the api zero time', '0001-01-01T00:00:00Z'],
	])('returns an empty string for %s', (_name, date) => {
		expect(formatDate(date, 'YYYY-MM-DD')).toBe('')
	})
})

describe('formatDateSince', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	it.each([
		['a few seconds ago', -10_000],
		['slightly ahead of the lagging now', 30_000],
	])('returns "just now" for a date %s', (_name, offset) => {
		const {now} = useGlobalNow()
		expect(formatDateSince(new Date(now.value.getTime() + offset))).toBe('just now')
	})

	it('returns a relative time for older dates', () => {
		const {now} = useGlobalNow()
		expect(formatDateSince(new Date(now.value.getTime() - 5 * 60_000))).toBe('5 minutes ago')
	})
})

describe('formatDisplayDateFormat', () => {
	it('builds a long date formatter once, not once per date', () => {
		const Original = Intl.DateTimeFormat
		let constructed = 0
		Intl.DateTimeFormat = class extends Original {
			constructor(...args: ConstructorParameters<typeof Original>) {
				super(...args)
				constructed++
			}
		} as typeof Intl.DateTimeFormat
		const dates = Array.from({length: 50}, (_, day) => new Date(Date.UTC(2026, 0, day + 1, 9, 30)))

		try {
			const shown = dates.map(date => formatDisplayDateFormat(date, DATE_DISPLAY.WEEKDAY_DAY_MONTH_YEAR, TIME_FORMAT.HOURS_24))

			expect(constructed).toBeLessThanOrEqual(1)
			expect(new Set(shown).size).toBe(50)
			expect(shown[0]).toBe(new Original(i18n.global.locale.value, {
				weekday: 'long',
				day: 'numeric',
				month: 'long',
				year: 'numeric',
				hour: 'numeric',
				minute: 'numeric',
				hour12: false,
			}).format(dates[0]))
		} finally {
			Intl.DateTimeFormat = Original
		}
	})
})
