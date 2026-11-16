import {resolveCalendarWallTime} from '@/helpers/calendar'
import {i18n} from '@/i18n'

export type AutomationSchedule = {
	kind: 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'interval'
	at?: string
	time?: string
	weekdays?: number[]
	day?: number
	month?: number
	interval_minutes?: number
}

export const scheduleKinds = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'interval'] as const

export function automationTime(value: string | null | undefined, timezone: string): string {
	if (!value || !Number.isFinite(Date.parse(value))) return i18n.global.t('automations.notScheduled')
	try {
		return new Intl.DateTimeFormat(i18n.global.locale.value, {
			timeZone: timezone,
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(value))
	} catch {
		return value
	}
}

export function automationWallTime(value: string | undefined, timezone: string): string {
	if (!value || !Number.isFinite(Date.parse(value))) return ''
	try {
		const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(value))
		const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
		return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
	} catch {
		return ''
	}
}

export function onceSchedule(value: string, timezone: string, occurrence: number): AutomationSchedule | undefined {
	const resolved = resolveCalendarWallTime(value, timezone)
	if (resolved.kind === 'invalid') return undefined
	const at = resolved.kind === 'valid' ? resolved.instant : resolved.instants[occurrence]
	return at ? {kind: 'once', at} : undefined
}

export function scheduleDescription(schedule: AutomationSchedule, timezone: string): string {
	const t = i18n.global.t
	if (schedule.kind === 'once') return automationTime(schedule.at, timezone)
	if (schedule.kind === 'interval') return t('automations.intervalSummary', {minutes: schedule.interval_minutes ?? 1})
	const time = schedule.time || '09:00'
	if (schedule.kind === 'weekly') {
		const days = (schedule.weekdays ?? []).map(day => t(`automations.dayNames.${day}`)).join(' · ')
		return t('automations.weeklySummary', {days, time})
	}
	if (schedule.kind === 'monthly') return t('automations.monthlySummary', {day: schedule.day ?? 1, time})
	if (schedule.kind === 'yearly') return t('automations.yearlySummary', {month: schedule.month ?? 1, day: schedule.day ?? 1, time})
	return t('automations.recurringSummary', {frequency: t(`automations.schedules.${schedule.kind}`), time})
}
