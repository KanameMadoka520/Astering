import type {TaskRoutine} from '@/client/generated'

export type RoutinePeriod = 'daily' | 'weekly' | 'monthly'

export interface TaskRoutineSchedule {
	period: RoutinePeriod
	timezone: string
	reset_hour: number
	reset_minute: number
	week_start: number
	month_day: number
	target: number
	unit: string
}

export interface TaskRoutineSummary extends TaskRoutineSchedule {
	enabled: boolean
	paused: boolean
	revision: number
	// The current period's starting calendar date in the server's timezone.
	date: string
	completed_today: boolean
	// '' when there is no check-in for `date`.
	completed_at: string
	completed_by_id: number
	// The next anchored local period boundary; '' when the server sent none.
	next_reset_at: string
	period_start_at: string
	schedule_key: string
	current_amount: number
	completed_period: boolean
}

// What the API sends: every field may be missing, and unset times arrive as Go's zero time.
export type RawTaskRoutine = {[K in keyof TaskRoutine]?: TaskRoutine[K] | null}

export type RoutineStatus = 'pending' | 'done' | 'paused'

const ZERO_TIME = /^0001-01-01/
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export function routineTimeOrEmpty(value?: string | null): string {
	return value && !ZERO_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : ''
}

export function routineSchedule(
	raw?: Partial<TaskRoutineSchedule> | null,
	fallbackZone = '',
): TaskRoutineSchedule {
	return {
		period: raw?.period === 'weekly' || raw?.period === 'monthly' ? raw.period : 'daily',
		timezone: raw?.timezone || fallbackZone,
		reset_hour: raw?.reset_hour ?? 0,
		reset_minute: raw?.reset_minute ?? 0,
		week_start: raw?.week_start ?? 0,
		month_day: raw?.month_day || 1,
		target: raw?.target && raw.target > 0 ? raw.target : 1,
		unit: raw?.unit ?? '',
	}
}

export function validRoutineSchedule(schedule: TaskRoutineSchedule): boolean {
	return ['daily', 'weekly', 'monthly'].includes(schedule.period)
		&& Boolean(schedule.timezone)
		&& Number.isInteger(schedule.reset_hour) && schedule.reset_hour >= 0 && schedule.reset_hour <= 23
		&& Number.isInteger(schedule.reset_minute) && schedule.reset_minute >= 0 && schedule.reset_minute <= 59
		&& Number.isInteger(schedule.week_start) && schedule.week_start >= 0 && schedule.week_start <= 6
		&& Number.isInteger(schedule.month_day) && schedule.month_day >= 1 && schedule.month_day <= 31
		&& Number.isSafeInteger(schedule.target) && schedule.target >= 1
		&& [...schedule.unit].length <= 40
}

export function isLegacyRoutine(routine: TaskRoutineSchedule): boolean {
	return routine.period === 'daily' && routine.reset_hour === 0 && routine.reset_minute === 0
		&& routine.target === 1 && routine.unit === ''
}

export function normalizeTaskRoutine(raw: RawTaskRoutine | null | undefined): TaskRoutineSummary | null {
	if (!raw) return null
	const completedAt = routineTimeOrEmpty(raw.completed_at)
	const schedule = routineSchedule({
		period: raw.period ?? undefined,
		timezone: raw.timezone ?? undefined,
		reset_hour: raw.reset_hour ?? undefined,
		reset_minute: raw.reset_minute ?? undefined,
		week_start: raw.week_start ?? undefined,
		month_day: raw.month_day ?? undefined,
		target: raw.target ?? undefined,
		unit: raw.unit ?? undefined,
	})
	const completed = (raw.completed_period ?? raw.completed_today) === true && completedAt !== ''
	return {
		...schedule,
		enabled: raw.enabled === true,
		paused: raw.paused === true,
		revision: raw.revision ?? 0,
		date: raw.date && LOCAL_DATE.test(raw.date) ? raw.date : '',
		completed_today: completed,
		completed_period: completed,
		completed_at: completedAt,
		completed_by_id: raw.completed_by_id ?? 0,
		next_reset_at: routineTimeOrEmpty(raw.next_reset_at),
		period_start_at: routineTimeOrEmpty(raw.period_start_at),
		schedule_key: raw.schedule_key ?? '',
		current_amount: Number.isSafeInteger(raw.current_amount) && raw.current_amount! >= 0
			? raw.current_amount!
			: completed ? schedule.target : 0,
	}
}

/** The routine summary embedded in a task read, or null when the task never had one. */
export function routineOf(task: {routine?: RawTaskRoutine | null} | null | undefined): TaskRoutineSummary | null {
	return normalizeTaskRoutine(task?.routine)
}

/** Enabled routines replace the ordinary done action; a disabled one only keeps its history. */
export function isRoutineTask(task: {routine?: RawTaskRoutine | null} | null | undefined): boolean {
	return routineOf(task)?.enabled === true
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

/** The calendar date (YYYY-MM-DD) `date` falls on in `timeZone`; '' for an unknown zone. */
export function localDate(date: Date, timeZone: string): string {
	let formatter = dateFormatters.get(timeZone)
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
		} catch {
			return ''
		}
		dateFormatters.set(timeZone, formatter)
	}
	const parts = formatter.formatToParts(date)
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
	return `${part('year')}-${part('month')}-${part('day')}`
}

/** Whether the stored period ended; its completion must no longer be shown as current. */
export function hasRoutineDayEnded(routine: TaskRoutineSummary, now: Date): boolean {
	const reset = Date.parse(routine.next_reset_at)
	if (!Number.isNaN(reset)) return now.getTime() >= reset
	// The browser cannot reconstruct anchored calendar periods safely across DST. Wait for a fresh server summary.
	if (!isLegacyRoutine(routine)) return false
	const today = localDate(now, routine.timezone)
	return routine.date !== '' && today !== '' && routine.date !== today
}

export function isCheckedInToday(routine: TaskRoutineSummary, now: Date): boolean {
	return routine.completed_today && !hasRoutineDayEnded(routine, now)
}

/** Null for a task that is not an enabled routine. */
export function routineStatus(routine: TaskRoutineSummary | null, now: Date): RoutineStatus | null {
	if (!routine?.enabled) return null
	if (routine.paused) return 'paused'
	return isCheckedInToday(routine, now) ? 'done' : 'pending'
}

/**
 * The server anchor for check-in or undo. Expired non-default calendars keep the stale anchor so the
 * server rejects with 409 and refreshes, rather than risking a write to a browser-invented period.
 */
export function routineToday(routine: TaskRoutineSummary, now: Date): string {
	if (routine.date && !hasRoutineDayEnded(routine, now)) return routine.date
	// A stale anchor deliberately produces a 409 and refresh; never write a guessed weekly/monthly period.
	if (!isLegacyRoutine(routine)) return routine.date
	return localDate(now, routine.timezone) || routine.date
}

/** Year and month (1–12) of the routine's current local day, for the history calendar. */
export function routineMonth(routine: TaskRoutineSummary, now: Date): {year: number, month: number} {
	const [year, month] = (localDate(now, routine.timezone) || routine.date).split('-').map(Number)
	if (year && month) return {year, month}
	return {year: now.getUTCFullYear(), month: now.getUTCMonth() + 1}
}

/** The earliest moment one of these routines starts a new day, or undefined when none is known. */
export function nextRoutineReset(routines: readonly TaskRoutineSummary[], now: Date): number | undefined {
	let next: number | undefined
	for (const routine of routines) {
		if (!routine.enabled || routine.paused) continue
		const reset = Date.parse(routine.next_reset_at)
		if (Number.isNaN(reset) || reset <= now.getTime()) continue
		next = next === undefined ? reset : Math.min(next, reset)
	}
	return next
}
