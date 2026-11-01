import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computed} from 'vue'
import type {ClientRequestContext} from '@/client/requestContext'
import {markSteerInFlight, readSteerQueue, steerQueueOwner, updateSteerQueue, type QueuedSteer} from './steeringQueue'

function context(id: number | null, apiBaseUrl = '/api/v2'): ClientRequestContext {
	return {
		identity: id === null ? null : {
			id,
			type: 1,
		},
		authSessionEpoch: 0,
		apiBaseUrl,
	}
}

function entry(requestID: string, state: QueuedSteer['state'] = 'failed'): QueuedSteer {
	return {
		chat: 'c1',
		turn: 't1',
		requestID,
		message: `Instruction ${requestID}`,
		state,
		restored: '',
		reason: '',
	}
}

const add = (owner: ClientRequestContext, item: QueuedSteer) => updateSteerQueue(owner, entries => [...entries, item])

beforeEach(() => {
	sessionStorage.clear()
})
afterEach(() => {
	vi.restoreAllMocks()
})

describe('steering queue', () => {
	it('keeps each account\'s and server\'s instructions apart, in the order they were added', () => {
		add(context(7), entry('a'))
		add(context(7), entry('b'))
		add(context(8), entry('c'))
		add(context(7, 'https://other.example/api/v2'), entry('d'))

		expect(readSteerQueue(context(7)).entries.map(item => item.requestID)).toEqual(['a', 'b'])
		expect(readSteerQueue(context(8)).entries.map(item => item.requestID)).toEqual(['c'])
		expect(readSteerQueue(context(7)).owner).toBe(steerQueueOwner(context(7)))
		expect(steerQueueOwner(context(7))).not.toBe(steerQueueOwner(context(8)))
		expect(steerQueueOwner(context(7))).not.toBe(steerQueueOwner(context(7, 'https://other.example/api/v2')))
		// The auth epoch only fences requests: a new auth session of the same account keeps its queue.
		expect(readSteerQueue({...context(7), authSessionEpoch: 3}).owner).toBe(steerQueueOwner(context(7)))
		expect(readSteerQueue(context(7, 'https://other.example/api/v2')).entries.map(item => item.requestID)).toEqual(['d'])
	})

	it('keeps an instruction without a known account for this page only, and says so', () => {
		add(context(null), entry('a'))
		expect(sessionStorage.length).toBe(0)
		expect(readSteerQueue(context(null))).toMatchObject({
			entries: [{requestID: 'a'}],
			saved: false,
		})
		expect(readSteerQueue(context(7)).entries).toEqual([])
		updateSteerQueue(context(null), () => [])
	})

	it('survives a reload, and an instruction a closed page was still sending reads as unconfirmed', () => {
		add(context(7), entry('cut-off', 'sending'))
		markSteerInFlight('live', true)
		add(context(7), entry('live', 'sending'))

		expect(readSteerQueue(context(7)).entries.map(item => [item.requestID, item.state])).toEqual([
			['cut-off', 'failed'],
			['live', 'sending'],
		])
		// What the storage holds is unchanged: only this page knows which requests it still waits on.
		expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).map((item: QueuedSteer) => item.state))
			.toEqual(['sending', 'sending'])
		markSteerInFlight('live', false)
		expect(readSteerQueue(context(7)).entries.map(item => item.state)).toEqual(['failed', 'failed'])
	})

	it('updates readers when this page changes the queue', () => {
		const owner = context(7)
		const shown = computed(() => readSteerQueue(owner).entries.length)
		expect(shown.value).toBe(0)
		add(owner, entry('a'))
		expect(shown.value).toBe(1)
		updateSteerQueue(owner, entries => entries.filter(item => item.requestID !== 'a'))
		expect(shown.value).toBe(0)
		expect(sessionStorage.length).toBe(0)
	})

	it('drops stored data it cannot trust', () => {
		add(context(7), entry('a'))
		const key = sessionStorage.key(0)!
		sessionStorage.setItem(key, JSON.stringify([entry('ok'), {requestID: 'missing fields'}, null, 'text']))
		expect(readSteerQueue(context(7)).entries.map(item => item.requestID)).toEqual(['ok'])
		sessionStorage.setItem(key, '{not json')
		expect(readSteerQueue(context(7)).entries).toEqual([])
	})

	it('keeps instructions for this page and says so when the storage refuses them', () => {
		const refuse = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('Quota exceeded', 'QuotaExceededError')
		})
		add(context(9), entry('a'))
		expect(readSteerQueue(context(9))).toMatchObject({
			entries: [{requestID: 'a'}],
			saved: false,
		})

		refuse.mockRestore()
		add(context(9), entry('b'))
		expect(readSteerQueue(context(9))).toMatchObject({
			entries: [{requestID: 'a'}, {requestID: 'b'}],
			saved: true,
		})
	})
})
