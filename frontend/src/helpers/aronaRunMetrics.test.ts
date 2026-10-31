import {describe, expect, it} from 'vitest'
import type {ModelStep, RunResult, Usage} from '@/client/generated'
import type {SubagentTask} from './aronaTimeline'
import {contextOccupancy, currentRequest, inFlight, turnTotals} from './aronaRunMetrics'

// Aggregated per-round figures from the real token audit: input / output / cached / reasoning / duration_ms.
const audit = [
	[111612, 99, 87071, 0, 10348],
	[111848, 22, 111609, 0, 7873],
	[112710, 100, 111845, 24, 7611],
	[120586, 2252, 112707, 516, 25336],
	[125860, 469, 120583, 59, 8260],
	[127830, 368, 125857, 0, 6648],
	[129497, 1593, 127827, 23, 13874],
	[133147, 463, 129494, 0, 9300],
	[135029, 944, 133144, 71, 14326],
	[136982, 292, 135026, 0, 7308],
]

function steps(rounds: number, contextWindow = 0): ModelStep[] {
	return audit.slice(0, rounds).map(([input, output, cached, reasoning, duration], index) => ({
		round: index + 1,
		model: 'gpt-6.1-sol',
		context_window: contextWindow,
		duration_ms: duration,
		usage: {reported: true, input, output, cached, cache_reported: true, reasoning, reasoning_reported: true},
	}))
}

describe('Arona run metrics keep their scopes apart', () => {
	it('separates the last request, the context it occupies and the turn total', () => {
		const result: RunResult = {stage: 'completed', steps: steps(9)}
		expect(currentRequest(result)).toMatchObject({round: 9, live: false, elapsedMs: 14326, usage: {input: 135029, cached: 133144, output: 944, reasoning: 71}})
		expect(contextOccupancy(result)).toEqual({source: 'request', round: 9, input: 135029, cached: 133144, window: null, percent: null, threshold: null, maxOutput: null})
		const totals = turnTotals(result)
		expect(totals).toMatchObject({requests: 9, reportedRequests: 9, input: 1108119, output: 6310, reasoning: 693, cached: 1060137, partial: false})
		expect(totals.cacheRate).toBeCloseTo(0.9567, 4)
	})

	it('reports a context share only against a configured capacity', () => {
		expect(contextOccupancy({steps: steps(9, 200000)})).toMatchObject({input: 135029, window: 200000, percent: 135029 / 200000})
		expect(contextOccupancy({steps: steps(10)})).toMatchObject({round: 10, input: 136982, percent: null})
	})

	it('keeps an unreported live request unknown instead of zero-filling it', () => {
		const started = '2026-11-01T08:00:00.000Z'
		const live: RunResult = {stage: 'model', steps: [...steps(9), {round: 10, started, streaming: true, output_characters: 312, usage: {reported: false, input: 0, output: 0}}]}
		const request = currentRequest(live, Date.parse(started) + 5000)
		expect(request).toMatchObject({round: 10, live: true, elapsedMs: 5000, observedCharacters: 312, usage: null})
		// The context still comes from round 9, the latest request the provider actually reported.
		expect(contextOccupancy(live)).toMatchObject({round: 9, input: 135029})
		// The streaming request is not finished work: the total covers rounds 1-9 and round 10 stays in flight.
		expect(turnTotals(live, true)).toMatchObject({requests: 9, reportedRequests: 9, input: 1108119, output: 6310, partial: false})
		expect(inFlight(live, true)).toEqual({request: true, compactions: 0, subagents: 0, reported: 0, usage: null})
		// Once the stage moves on, round 10 is finished work in the total and nothing repeats it as in flight.
		const settled: RunResult = {...live, stage: 'validation'}
		expect(turnTotals(settled, true)).toMatchObject({requests: 10, reportedRequests: 9})
		expect(inFlight(settled, true)).toBeNull()
		// Right after round 10 is counted, before its first update, round 9 is not mistaken for the live request.
		expect(currentRequest({stage: 'model', budget: {rounds: 10}, steps: steps(9)}, Date.parse(started))).toMatchObject({round: 10, live: true, elapsedMs: null, usage: null})

		const silent = turnTotals({steps: [{round: 1, usage: {reported: false}}, {round: 2}]})
		expect(silent).toMatchObject({requests: 2, reportedRequests: 0, input: null, output: null, cached: null, cacheRate: null, reasoning: null, partial: true})
		expect(contextOccupancy({steps: [{round: 1, context_window: 200000, usage: {reported: false}}]})).toBeNull()
	})

	it('adds search sub-requests to the turn total but never to the context', () => {
		const result: RunResult = {steps: steps(1), actions: [{round: 1, tool: 'web_search', success: true, search: {step: {usage: {reported: true, input: 900, output: 100}}}}]}
		expect(turnTotals(result)).toMatchObject({requests: 2, searchRequests: 1, input: 111612 + 900, output: 199, cacheMeasured: 1, cached: 87071})
		// Cache rate stays weighted by the requests that reported cache, so the search input does not dilute it.
		expect(turnTotals(result).cacheRate).toBeCloseTo(87071 / 111612, 6)
		expect(contextOccupancy(result)).toMatchObject({input: 111612})
	})

	it('prefers the backend context status and never invents a capacity', () => {
		const base: RunResult = {steps: steps(9)}
		// Exactly round 9's reported input, so its cache hits apply; with no capacity the threshold is only a policy.
		expect(contextOccupancy({...base, context_status: {tokens: 135029, estimated: false, context_window: 0, threshold_tokens: 128000, source: 'provider'}}))
			.toEqual({source: 'provider', round: 9, input: 135029, cached: 133144, window: null, percent: null, threshold: 128000, maxOutput: null})
		// After tool results arrive the figure is the last report plus an estimate, not one request's input.
		expect(contextOccupancy({...base, context_status: {tokens: 141200, estimated: true, context_window: 200000, threshold_tokens: 180000, source: 'provider'}}))
			.toMatchObject({source: 'calibrated', round: null, cached: null, input: 141200, percent: 141200 / 200000, threshold: 180000})
		expect(contextOccupancy({context_status: {tokens: 9800, estimated: true, context_window: 0, threshold_tokens: 128000, source: 'estimate'}}))
			.toMatchObject({source: 'estimate', input: 9800, window: null, percent: null})
	})

	it('takes the turn usage from the server once and keeps running work provisional', () => {
		const started = '2026-11-01T08:00:00.123456789Z'
		const usage = (input: number, output: number, cached?: number): Usage =>
			cached === undefined ? {reported: true, input, output} : {reported: true, input, output, cached, cache_reported: true}
		const subagent = (id: string, status: 'running' | 'completed' | 'stopped', total: Usage, extra: Partial<SubagentTask> = {}): SubagentTask =>
			({id, goal: 'Read project 7', status, stage: 'model', started, model: 'gpt-6.1-sol', steps: [], actions: [], usage: total, duration_ms: 4000, reply: '', error: '', ...extra})
		const result: RunResult = {
			stage: 'execute',
			steps: steps(2),
			// Server total: rounds 1-2 (223,460 / 121) + the finished compaction (30,000 / 2,000) + the finished subagent (50,000 / 800).
			usage: {reported: true, partial: true, input: 303460, output: 2921, cached: 234680, cache_reported: true},
			// Its one request did not report cache.
			auto_compactions: [{id: 'c1', status: 'completed', started, before_tokens: 130000, after_tokens: 18000, attachment_count: 2, summary: 'Checkpoint', usage: usage(30000, 2000), duration_ms: 9000, progress: {steps: [{round: 1, usage: usage(30000, 2000)}]}}],
			subagents: [
				// Two rounds with cache, one search without, and its own compaction: 50,000 / 800 in four requests.
				subagent('a', 'completed', {...usage(50000, 800, 36000), partial: false}, {
					steps: [{round: 1, usage: usage(20000, 300, 15000)}, {round: 2, usage: usage(22000, 350, 21000)}],
					actions: [{round: 1, tool: 'web_search', success: true, search: {step: {usage: usage(5000, 100)}}}],
					auto_compactions: [{id: 'c2', status: 'completed', started, usage: usage(3000, 50, 0), progress: {steps: [{round: 1, usage: usage(3000, 50, 0)}]}}],
				}),
				subagent('b', 'running', usage(12000, 300)),
				subagent('c', 'stopped', {reported: false}),
			],
		}
		const totals = turnTotals(result, true)
		expect(totals).toMatchObject({
			requests: 7, modelRequests: 2, searchRequests: 0, allSearchRequests: 1, reportedRequests: 7, input: 303460, output: 2921, partial: true,
			compactions: {count: 1, reported: 1, requests: 1, usage: {input: 30000, output: 2000}},
			subagents: {count: 2, reported: 1, requests: 4, usage: {input: 50000, output: 800}},
		})
		// The cache rate covers the same requests as the total, per request: 5 of the 7 reported cache. Neither the
		// parent rounds alone (88.9%) nor a group total added on top of its own requests.
		expect(totals.cacheMeasured).toBe(5)
		expect(totals.cacheRate).toBeCloseTo((198680 + 15000 + 21000) / (223460 + 20000 + 22000 + 3000), 6)
		expect(totals.requestUsages).toHaveLength(7)
		expect(inFlight(result, true)).toMatchObject({request: false, compactions: 0, subagents: 1, reported: 1, usage: {input: 12000, output: 300}})
		expect(inFlight(result, false)).toBeNull()
	})
})
