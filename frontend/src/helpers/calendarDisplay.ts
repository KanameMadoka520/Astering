import {parseCalendarDate} from '@/helpers/calendar'

const lunarFormatters = new Map<string, Intl.DateTimeFormat | null>()

// Civil dates stay civil: the device's timezone must not move a selected day.
export function calendarLunarLabel(date: string, locale: string): string {
	if (!parseCalendarDate(date)) return ''
	const language = locale.toLowerCase().startsWith('zh') ? locale : 'en'
	if (!lunarFormatters.has(language)) {
		try {
			lunarFormatters.set(language, new Intl.DateTimeFormat(language, {
				calendar: 'chinese',
				timeZone: 'UTC',
				month: 'short',
				day: 'numeric',
			}))
		} catch {
			lunarFormatters.set(language, null)
		}
	}
	const formatter = lunarFormatters.get(language)
	const instant = new Date(`${date}T12:00:00Z`)
	if (!formatter || !Number.isFinite(instant.getTime())) return ''
	try {
		if (formatter.resolvedOptions().calendar !== 'chinese') return ''
		const parts = formatter.formatToParts(instant)
		const month = parts.find(part => part.type === 'month')?.value ?? ''
		const day = parts.find(part => part.type === 'day')?.value ?? ''
		return language.startsWith('zh') ? `${month}${day}` : `${month} ${day}`.trim()
	} catch {
		return ''
	}
}
