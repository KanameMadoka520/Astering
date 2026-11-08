import {beforeEach, describe, expect, it, vi} from 'vitest'

const auth = vi.hoisted(() => ({id: 1, epoch: 1}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => null,
	getTokenIdentity: () => ({id: auth.id, type: 1}),
	getAuthSessionEpoch: () => auth.epoch,
}))

import {appendAronaDraft, stageAronaDraftHandoff, takeAronaDraftHandoff} from './aronaDraftHandoff'

describe('Arona source draft handoff', () => {
	beforeEach(() => {
		auth.id = 1
		auth.epoch = 1
		window.API_URL = ''
	})

	it('passes text exactly once without replacing existing writing', () => {
		const id = stageAronaDraftHandoff('Selected transcript')
		expect(takeAronaDraftHandoff('unrelated')).toBe('')
		expect(appendAronaDraft('Existing draft', takeAronaDraftHandoff(id)))
			.toBe('Existing draft\n\nSelected transcript')
		expect(takeAronaDraftHandoff(id)).toBe('')
	})

	it.each(['account', 'session', 'server'])('rejects an old %s handoff', boundary => {
		const id = stageAronaDraftHandoff('Private text')
		if (boundary === 'account') auth.id = 2
		if (boundary === 'session') auth.epoch++
		if (boundary === 'server') window.API_URL = 'https://other.example/api/v2'
		expect(takeAronaDraftHandoff(id)).toBe('')
		auth.id = 1
		auth.epoch = 1
		window.API_URL = ''
		expect(takeAronaDraftHandoff(id)).toBe('')
	})
})
