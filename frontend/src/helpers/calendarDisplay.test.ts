import {describe, expect, it} from 'vitest'

import {calendarLunarLabel} from './calendarDisplay'

describe('calendar lunar date labels', () => {
	it('uses the civil UTC day rather than a device-local date', () => {
		const formatter = new Intl.DateTimeFormat('zh-CN', {
			calendar: 'chinese',
			timeZone: 'UTC',
			month: 'short',
			day: 'numeric',
		})
		const parts = formatter.formatToParts(new Date('2026-11-03T12:00:00Z'))
		const expected = `${parts.find(part => part.type === 'month')!.value}${parts.find(part => part.type === 'day')!.value}`
		expect(calendarLunarLabel('2026-11-03', 'zh-CN')).toBe(expected)
		expect(calendarLunarLabel('2026-11-03', 'zh-CN')).toBe(expected)
	})

	it('does not roll an invalid civil date into a different lunar day', () => {
		for (const value of ['2026-02-30', '2026-13-01', '2026-11-03T00:00:00Z', '']) {
			expect(calendarLunarLabel(value, 'zh-CN')).toBe('')
		}
	})

	it('uses a readable English Chinese-calendar label when explicitly enabled', () => {
		const label = calendarLunarLabel('2026-11-03', 'en-US')
		expect(label).not.toBe('')
		expect(label).not.toBe(calendarLunarLabel('2026-11-03', 'zh-CN'))
	})
})
