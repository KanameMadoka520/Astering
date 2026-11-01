import {parseDateOrNull} from '@/helpers/parseDateOrNull'

export const ASSISTANT_TIME_ZONE = 'Asia/Shanghai'
export const ASSISTANT_ZONE_LABEL = 'GMT+8'

// Asia/Shanghai has had no DST since 1991, so a fixed +08:00 equals it for every server timestamp.
const OFFSET_MS = 8 * 3600_000
const DAY_MS = 24 * 3600_000

export type AssistantInstant = {
	ms: number
	iso: string
	full: string
	day: string
	time: string
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, '0')
}

function shifted(ms: number): Date {
	return new Date(ms + OFFSET_MS)
}

function dayOf(date: Date): string {
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Converts a server timestamp into its GMT+8 representations. Returns null for anything that
 * is not a real instant (missing, unparseable, Go zero time or not after the Unix epoch).
 */
export function assistantInstant(value: unknown): AssistantInstant | null {
	if (typeof value !== 'string') return null
	const ms = parseDateOrNull(value)?.getTime() ?? 0
	if (ms <= 0) return null

	const date = shifted(ms)
	const day = dayOf(date)
	const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
	const clock = `${time}:${pad(date.getUTCSeconds())}`
	return {
		ms,
		iso: `${day}T${clock}+08:00`,
		full: `${day} ${clock} ${ASSISTANT_ZONE_LABEL}`,
		day,
		time,
	}
}

export function assistantDay(ms: number): string {
	return dayOf(shifted(ms))
}

/**
 * Shortest text that still names the day unambiguously: the date is dropped only for today
 * and the year only within the current year.
 */
export function compactAssistantTime(instant: AssistantInstant, today: string): string {
	const zoned = `${instant.time} ${ASSISTANT_ZONE_LABEL}`
	if (instant.day === today) return zoned
	if (instant.day.slice(0, 4) === today.slice(0, 4)) return `${instant.day.slice(5)} ${zoned}`
	return `${instant.day} ${zoned}`
}

export function msUntilNextAssistantDay(ms: number): number {
	const sinceMidnight = ((ms + OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS
	return DAY_MS - sinceMidnight
}
