import {describe, expect, it} from 'vitest'
import {
	hasRoutineDayEnded,
	isRoutineTask,
	localDate,
	nextRoutineReset,
	normalizeTaskRoutine,
	routineMonth,
	routineOf,
	routineStatus,
	routineToday,
	type TaskRoutineSummary,
} from './taskRoutine'

function summary(overrides: Partial<TaskRoutineSummary> = {}): TaskRoutineSummary {
	return {
		...normalizeTaskRoutine({enabled: true})!,
		enabled: true,
		paused: false,
		timezone: 'Asia/Shanghai',
		revision: 1,
		date: '2026-11-01',
		completed_today: true,
		completed_at: '2026-11-01T08:30:00+08:00',
		completed_by_id: 1,
		// Midnight in Shanghai.
		next_reset_at: '2026-11-01T16:00:00Z',
		...overrides,
	}
}

describe('normalizeTaskRoutine', () => {
	it('treats Go zero times as unset and a check-in without a time as not done', () => {
		expect(normalizeTaskRoutine({
			enabled: true,
			completed_today: true,
			completed_at: '0001-01-01T00:00:00Z',
			next_reset_at: '0001-01-01T00:00:00Z',
			date: 'yesterday',
		})).toMatchObject({completed_today: false, completed_at: '', next_reset_at: '', date: ''})
	})

	it('keeps a disabled routine so its history stays reachable, and has none for plain tasks', () => {
		expect(routineOf({routine: {enabled: false, revision: 3}})).toMatchObject({enabled: false, revision: 3})
		expect(isRoutineTask({routine: {enabled: false, revision: 3}})).toBe(false)
		expect(routineOf({})).toBeNull()
		expect(isRoutineTask({routine: null})).toBe(false)
	})
})

describe('routine day', () => {
	it('shows today\'s check-in until the routine\'s local midnight, then pending again', () => {
		const routine = summary()
		expect(routineStatus(routine, new Date('2026-11-01T15:59:00Z'))).toBe('done')
		expect(routineStatus(routine, new Date('2026-11-01T16:00:00Z'))).toBe('pending')
	})

	it('falls back to the calendar date in the routine zone when the server sent no reset time', () => {
		const routine = summary({next_reset_at: ''})
		expect(hasRoutineDayEnded(routine, new Date('2026-11-01T15:00:00Z'))).toBe(false)
		expect(hasRoutineDayEnded(routine, new Date('2026-11-01T16:30:00Z'))).toBe(true)
	})

	it('reports paused before anything else and nothing for disabled routines', () => {
		expect(routineStatus(summary({paused: true}), new Date('2026-11-01T10:00:00Z'))).toBe('paused')
		expect(routineStatus(summary({enabled: false}), new Date('2026-11-01T10:00:00Z'))).toBeNull()
		expect(routineStatus(null, new Date())).toBeNull()
	})

	it('sends the server\'s date while it is current and the routine zone\'s date after midnight', () => {
		const routine = summary()
		expect(routineToday(routine, new Date('2026-11-01T10:00:00Z'))).toBe('2026-11-01')
		expect(routineToday(routine, new Date('2026-11-01T16:05:00Z'))).toBe('2026-11-02')
	})

	it('uses the routine zone, not the browser zone, across a date line', () => {
		const instant = new Date('2026-11-01T20:00:00Z')
		expect(localDate(instant, 'Asia/Shanghai')).toBe('2026-11-02')
		expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-11-01')
		expect(localDate(instant, 'Not/AZone')).toBe('')
	})

	it('derives the history month from the routine\'s current day', () => {
		expect(routineMonth(summary({date: '2026-12-31', next_reset_at: '2026-12-31T16:00:00Z'}), new Date('2026-12-31T16:30:00Z')))
			.toEqual({year: 2027, month: 1})
	})

	it('finds the earliest upcoming reset among active routines', () => {
		const now = new Date('2026-11-01T10:00:00Z')
		expect(nextRoutineReset([
			summary({next_reset_at: '2026-11-02T05:00:00Z'}),
			summary({next_reset_at: '2026-11-01T16:00:00Z'}),
			summary({paused: true, next_reset_at: '2026-11-01T11:00:00Z'}),
			summary({next_reset_at: '2026-11-01T09:00:00Z'}),
		], now)).toBe(Date.parse('2026-11-01T16:00:00Z'))
		expect(nextRoutineReset([], now)).toBeUndefined()
	})

	it('keeps a weekly quota anchored through local midnights, then refuses to guess its next date', () => {
		const routine = summary({
			period: 'weekly',
			reset_hour: 6,
			target: 7,
			current_amount: 7,
			date: '2026-10-26',
			next_reset_at: '2026-11-01T22:00:00Z',
		})
		expect(routineStatus(routine, new Date('2026-11-01T20:00:00Z'))).toBe('done')
		expect(routineToday(routine, new Date('2026-11-01T20:00:00Z'))).toBe('2026-10-26')
		expect(routineMonth(routine, new Date('2026-11-01T20:00:00Z'))).toEqual({year: 2026, month: 11})
		expect(routineStatus(routine, new Date('2026-11-01T22:00:00Z'))).toBe('pending')
		expect(routineToday(routine, new Date('2026-11-01T22:00:00Z'))).toBe('2026-10-26')
	})

	it('preserves the server quota while defaulting legacy daily records to one', () => {
		expect(normalizeTaskRoutine({
			enabled: true,
			period: 'monthly',
			target: 100,
			current_amount: 42,
			unit: 'pages',
			completed_period: false,
		})).toMatchObject({period: 'monthly', target: 100, current_amount: 42, completed_period: false})
		expect(normalizeTaskRoutine({
			completed_today: true,
			completed_at: '2026-11-01T08:30:00+08:00',
		})).toMatchObject({period: 'daily', target: 1, current_amount: 1, completed_period: true})
	})
})
