import {describe, expect, it} from 'vitest'
import type {ChatTurn} from '@/client/generated'
import {hasSteeringRequest, pendingSteeringCount, steeringItems, type LocalSteer, type SteeringEntry} from './turnSteering'

function entry(id: string, created: string, status: SteeringEntry['status'] = 'pending'): SteeringEntry {
	return {
		id,
		request_id: `r-${id}`,
		message: `Instruction ${id}`,
		created,
		status,
	}
}

function local(requestID: string, state: LocalSteer['state'] = 'sending', turn = 't1'): LocalSteer {
	return {
		chat: 'c1',
		turn,
		request_id: requestID,
		message: `Local ${requestID}`,
		state,
	}
}

describe('steeringItems', () => {
	it('keeps the server\'s acceptance order even when the clock stepped back or times are equal', () => {
		const entries = [
			entry('a', '2026-11-01T06:10:00Z'),
			entry('b', '2026-11-01T06:05:00Z'),
			entry('c', '2026-11-01T06:05:00Z'),
			entry('d', ''),
		]
		expect(steeringItems(entries, 'running').map(item => item.id)).toEqual(['a', 'b', 'c', 'd'])
	})

	it('passes the server\'s id and status through and maps what the row says', () => {
		const items = steeringItems([
			{...entry('a', '2026-11-01T06:05:00Z', 'applied'), applied_at: '2026-11-01T06:06:00Z'},
			entry('b', '2026-11-01T06:07:00Z'),
		], 'running')
		expect(items).toEqual([
			{
				key: 'r-a',
				id: 'a',
				status: 'applied',
				message: 'Instruction a',
				created: '2026-11-01T06:05:00Z',
				appliedAt: '2026-11-01T06:06:00Z',
				state: 'applied',
			},
			{
				key: 'r-b',
				id: 'b',
				status: 'pending',
				message: 'Instruction b',
				created: '2026-11-01T06:07:00Z',
				appliedAt: undefined,
				state: 'pending',
			},
		])
	})

	it.each<[ChatTurn['status'], string]>([
		['running', 'pending'],
		['awaiting_approval', 'pending'],
		['awaiting_input', 'pending'],
		['paused', 'pending'],
		['completed', 'missed'],
		['failed', 'missed'],
		['stopped', 'missed'],
		['interrupted', 'missed'],
	])('shows a pending instruction of a %s turn as %s', (status, state) => {
		const [item] = steeringItems([entry('a', '2026-11-01T06:05:00Z')], status)
		expect(item.state).toBe(state)
		// The row's own state never replaces the server's status.
		expect(item.status).toBe('pending')
	})

	it('keeps an applied instruction applied after the run ends, and an unknown status unknown', () => {
		const items = steeringItems([
			entry('a', '2026-11-01T06:05:00Z', 'applied'),
			{...entry('b', '2026-11-01T06:06:00Z'), status: 'discarded' as never},
		], 'completed')
		expect(items.map(item => item.state)).toEqual(['applied', 'unknown'])
	})

	it('adds this tab\'s unconfirmed instructions last, once, without server fields', () => {
		const items = steeringItems([entry('a', '2026-11-01T06:05:00Z')], 'running', [
			local('r-a', 'sent'),
			local('r-new'),
			local('r-acknowledged', 'sent'),
		])
		expect(items.map(item => [item.key, item.state, item.id, item.status])).toEqual([
			['r-a', 'pending', 'a', 'pending'],
			['r-new', 'sending', undefined, undefined],
			['r-acknowledged', 'pending', undefined, undefined],
		])
	})

	it('handles a turn without instructions', () => {
		expect(steeringItems(undefined, 'running')).toEqual([])
		expect(steeringItems(null, 'completed')).toEqual([])
	})
})

describe('steering lookups', () => {
	const turn: ChatTurn = {
		id: 't1',
		status: 'running',
		steering: [
			entry('a', '2026-11-01T06:05:00Z', 'applied'),
			entry('b', '2026-11-01T06:06:00Z'),
			entry('c', '2026-11-01T06:07:00Z'),
		],
	}

	it('counts the instructions the run has not taken in', () => {
		expect(pendingSteeringCount(turn)).toBe(2)
		expect(pendingSteeringCount({id: 't2'})).toBe(0)
		expect(pendingSteeringCount(undefined)).toBe(0)
	})

	it('finds an instruction by its request id only', () => {
		expect(hasSteeringRequest(turn, 'r-b')).toBe(true)
		expect(hasSteeringRequest(turn, 'b')).toBe(false)
		expect(hasSteeringRequest(turn, '')).toBe(false)
		expect(hasSteeringRequest(undefined, 'r-b')).toBe(false)
	})
})
