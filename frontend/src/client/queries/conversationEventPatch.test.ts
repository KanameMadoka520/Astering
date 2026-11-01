import {describe, expect, it} from 'vitest'
import {applyConversationPatch, ConversationStreamSyncError} from './conversationEventPatch'

describe('conversation event copy on write', () => {
	it('copies a changed branch once while retaining stable siblings and supporting append/set/remove', () => {
		const current = {
			turn: {
				result: {
					steps: [{text: 'Hello', reasoning: 'Thinking'}],
					actions: [{result: 'Stable result'}],
					pause: 'review',
				},
			},
		}
		const next = applyConversationPatch(current, [
			{op: 'append', path: ['turn', 'result', 'steps', '0', 'text'], value: ' world'},
			{op: 'append', path: ['turn', 'result', 'steps', '0', 'reasoning'], value: ' more'},
			{op: 'set', path: ['turn', 'result', 'steps', '1'], value: {text: 'Next round'}},
			{op: 'remove', path: ['turn', 'result', 'pause']},
			{op: 'set', path: ['turn', 'result', 'review'], value: null},
		]) as typeof current & {turn: {result: {review: null}}}
		expect(next.turn.result.steps).toEqual([
			{text: 'Hello world', reasoning: 'Thinking more'},
			{text: 'Next round'},
		])
		expect(next.turn.result.actions).toBe(current.turn.result.actions)
		expect(next.turn.result.review).toBeNull()
		expect(next.turn.result).not.toHaveProperty('pause')
		expect(current.turn.result.steps).toEqual([{text: 'Hello', reasoning: 'Thinking'}])
		expect(current.turn.result.pause).toBe('review')
	})

	it.each([
		{op: 'set', path: ['__proto__', 'polluted'], value: true},
		{op: 'set', path: ['turn', 'constructor'], value: true},
		{op: 'set', path: ['prototype'], value: true},
		{op: 'set', path: ['turn', 'steps', '-1'], value: true},
		{op: 'set', path: ['turn', 'steps', '01'], value: true},
		{op: 'set', path: ['turn', 'steps', '2'], value: true},
		{op: 'remove', path: ['turn', 'steps', '0']},
		{op: 'remove', path: ['missing']},
		{op: 'append', path: ['turn', 'steps'], value: 'not a string'},
		{op: 'set', path: ['turn', 'steps', '0']},
		{op: 'set', path: ['missing', 'field'], value: true},
		{op: 'set', path: [], value: {}},
		{op: 'set', path: [0], value: {}},
		{op: 'unknown', path: ['turn'], value: {}},
	])('rejects invalid operations atomically: %j', invalid => {
		const current = {turn: {steps: ['Original'], status: 'running'}}
		expect(() => applyConversationPatch(current, [
			{op: 'set', path: ['turn', 'status'], value: 'changed'},
			invalid,
		])).toThrow(ConversationStreamSyncError)
		expect(current).toEqual({turn: {steps: ['Original'], status: 'running'}})
		expect(Object.prototype).not.toHaveProperty('polluted')
	})
})
