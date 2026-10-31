import type {Action, ModelStep, RunResult, Usage} from '@/client/generated'
import {
	compactionStatus,
	liveStepIndex,
	NO_COMPACTIONS,
	NO_STEPS,
	NO_SUBAGENTS,
	subagentStatus,
	type AutoCompaction,
	type SubagentStatus,
	type SubagentTask,
} from './aronaTimeline'

// Every figure keeps its scope: one request, the context in use, finished turn work, or work still in flight.
// Unreported stays null, never 0.

export type ContextStatus = NonNullable<RunResult['context_status']>

export type RequestUsage = {
	input: number | null
	output: number | null
	cached: number | null
	reasoning: number | null
}

export type CurrentRequest = {
	round: number | null
	model: string
	live: boolean
	elapsedMs: number | null
	firstTokenMs: number | null
	firstTextMs: number | null
	observedCharacters: number | null
	streaming: boolean
	usage: RequestUsage | null
}

/**
 * provider: the provider's measurement of the latest request; calibrated: that measurement plus an estimate of what
 * was added since; estimate: the backend's estimate alone; request: older turns, the latest reported request input.
 */
export type ContextSource = 'provider' | 'calibrated' | 'estimate' | 'request'

export type ContextOccupancy = {
	source: ContextSource
	round: number | null
	input: number
	cached: number | null
	window: number | null
	percent: number | null
	threshold: number | null
	maxOutput: number | null
}

/** Usage of a group of records: how many there are, how many reported, and the sum of what was reported. */
export type WorkUsage = {count: number, reported: number, usage: RequestUsage | null}
/** Finished compactions or subagents, with the number of requests behind them. */
export type WorkGroup = WorkUsage & {requests: number}

export type TurnTotals = {
	/**
	 * Every finished request behind the total: the turn's model and search requests and the requests of its finished
	 * compactions and subagents. The counts, the total and the cache rate below all share this scope.
	 */
	requests: number
	/** The turn's own finished model and search requests. */
	modelRequests: number
	searchRequests: number
	/** Search requests among `requests`: the turn's own and its finished subagents'. */
	allSearchRequests: number
	reportedRequests: number
	input: number | null
	output: number | null
	cached: number | null
	/** Cache hits over the input of those requests that reported cache, weighted by input; cacheMeasured of them did. */
	cacheRate: number | null
	cacheMeasured: number
	reasoning: number | null
	partial: boolean
	/** One usage per request in `requests`, for the cache breakdown of the same scope. */
	requestUsages: (Usage | undefined)[]
	/** Finished compactions and subagents; their usage is already part of the totals above. */
	compactions: WorkGroup
	subagents: WorkGroup
}

/** Work still running; the server adds it to the turn usage only when each part ends. */
export type InFlight = {
	request: boolean
	compactions: number
	subagents: number
	reported: number
	usage: RequestUsage | null
}

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function add(total: number | null, value: number | null): number | null {
	return value === null ? total : (total ?? 0) + value
}

function addUsage(total: RequestUsage | null, value: RequestUsage): RequestUsage {
	return {
		input: add(total?.input ?? null, value.input),
		output: add(total?.output ?? null, value.output),
		cached: add(total?.cached ?? null, value.cached),
		reasoning: add(total?.reasoning ?? null, value.reasoning),
	}
}

export function requestUsage(usage?: Usage): RequestUsage | null {
	if (!usage?.reported) return null
	const input = count(usage.input)
	const cached = usage.cache_reported ? count(usage.cached) : null
	return {
		input,
		output: count(usage.output),
		// Cache hits are a subset of input; an impossible pair is treated as unreported, like CacheUsage.
		cached: cached !== null && input !== null && cached <= input ? cached : null,
		reasoning: usage.reasoning_reported ? count(usage.reasoning) : null,
	}
}

export function workUsage(usages: readonly (Usage | undefined)[]): WorkUsage {
	let usage: RequestUsage | null = null
	let reported = 0
	for (const item of usages) {
		const value = requestUsage(item)
		if (!value) continue
		reported++
		usage = addUsage(usage, value)
	}
	return {count: usages.length, reported, usage}
}

// A running compaction only reports its attempts so far through progress; its own usage is set when it ends.
export function compactionUsage(event: AutoCompaction): Usage | undefined {
	return event.usage?.reported || compactionStatus(event) !== 'running' ? event.usage : event.progress?.usage
}

// Web search sub-requests are billed requests too, but never part of the chat context.
export function searchSteps(record?: {actions?: Action[] | null}): ModelStep[] {
	return (record?.actions ?? []).flatMap(action => action.search?.step ? [action.search.step] : [])
}

function finishedCompaction(event: AutoCompaction): boolean {
	return compactionStatus(event) !== 'running'
}

// Per-request usage, never a group total on top of it. Only a group without any request record falls back to its total,
// which then stands for at least one request.
function requestsOr(usages: (Usage | undefined)[], total?: Usage): (Usage | undefined)[] {
	return usages.length || !total?.reported ? usages : [total]
}

/** One usage per request of a finished compaction: every attempt of every batch. */
export function compactionRequests(event: AutoCompaction): (Usage | undefined)[] {
	return requestsOr((event.progress?.steps ?? NO_STEPS).map(step => step.usage), event.usage)
}

/** One usage per request of a finished subagent: its model rounds, its searches and its own finished compactions. */
export function subagentRequests(task: SubagentTask): (Usage | undefined)[] {
	return requestsOr([
		...[...(task.steps ?? NO_STEPS), ...searchSteps(task)].map(step => step.usage),
		...(task.auto_compactions ?? NO_COMPACTIONS).filter(finishedCompaction).flatMap(compactionRequests),
	], task.usage)
}

/** The last model request. Pass nowMs only while the turn runs; the request is live during the model stage. */
export function currentRequest(result: RunResult | undefined, nowMs?: number): CurrentRequest | null {
	const step = result?.steps?.at(-1)
	const live = nowMs !== undefined && result?.stage === 'model'
	const rounds = count(result?.budget?.rounds)
	// The next round is counted before its first upstream update; show it as waiting rather than reuse the last one.
	if (live && rounds !== null && rounds > (count(step?.round) ?? 0)) {
		return {round: rounds, model: '', live, elapsedMs: null, firstTokenMs: null, firstTextMs: null, observedCharacters: null, streaming: false, usage: null}
	}
	if (!step) return null
	const duration = count(step.duration_ms)
	const started = step.started ? Date.parse(step.started) : NaN
	return {
		round: count(step.round),
		model: step.model ?? '',
		live,
		elapsedMs: live && nowMs !== undefined && Number.isFinite(started) ? Math.max(duration ?? 0, nowMs - started) : duration,
		firstTokenMs: count(step.first_token_ms),
		firstTextMs: count(step.first_text_ms),
		observedCharacters: count(step.output_characters),
		streaming: Boolean(step.streaming),
		usage: requestUsage(step.usage),
	}
}

/**
 * Context in use is never a running total. The backend's context status wins when present; older turns fall back to
 * the latest reported request input (cache hits still occupy context). Zero capacity means unknown: no percentage.
 */
export function contextOccupancy(result?: RunResult): ContextOccupancy | null {
	const steps = result?.steps ?? NO_STEPS
	let latest: {step: ModelStep, input: number, cached: number | null} | null = null
	for (let index = steps.length - 1; index >= 0 && !latest; index--) {
		const usage = requestUsage(steps[index].usage)
		if (usage?.input) latest = {step: steps[index], input: usage.input, cached: usage.cached}
	}
	const maxOutput = count((latest?.step ?? steps.at(-1))?.max_output_tokens) || null
	const status = result?.context_status
	const tokens = count(status?.tokens)
	if (status && tokens) {
		const window = count(status.context_window) || null
		const source: ContextSource = status.source === 'provider' ? (status.estimated ? 'calibrated' : 'provider') : 'estimate'
		// Cache hits belong to the figure only when it is exactly the latest reported request input.
		const exact = source === 'provider' && latest?.input === tokens ? latest : null
		return {
			source,
			round: exact ? count(exact.step.round) : null,
			input: tokens,
			cached: exact?.cached ?? null,
			window,
			percent: window ? tokens / window : null,
			threshold: count(status.threshold_tokens) || null,
			maxOutput,
		}
	}
	if (!latest) return null
	const window = count(latest.step.context_window) || null
	return {
		source: 'request',
		round: count(latest.step.round),
		input: latest.input,
		cached: latest.cached,
		window,
		percent: window ? latest.input / window : null,
		threshold: null,
		maxOutput,
	}
}

/**
 * Finished work of the turn. The server's turn usage is authoritative and already holds every model request,
 * search, compaction and subagent once; per-request sums are only a fallback for results without it.
 * The cache rate covers the same requests, per request rather than from group totals (a group total marks cache as
 * reported once any part did), and only counts the requests that reported cache.
 */
export function turnTotals(result?: RunResult, running = false): TurnTotals {
	const live = liveStepIndex(result, running)
	const steps = (result?.steps ?? NO_STEPS).filter((_, index) => index !== live)
	const searches = searchSteps(result)
	const compactions = (result?.auto_compactions ?? NO_COMPACTIONS).filter(finishedCompaction)
	const subagents = (result?.subagents ?? NO_SUBAGENTS).filter(task => subagentStatus(task) !== 'running')
	const compactionUsages = compactions.map(compactionRequests)
	const subagentUsages = subagents.map(subagentRequests)
	const requestUsages = [...[...steps, ...searches].map(step => step.usage), ...compactionUsages.flat(), ...subagentUsages.flat()]
	const totals: TurnTotals = {
		requests: requestUsages.length,
		modelRequests: steps.length,
		searchRequests: searches.length,
		allSearchRequests: searches.length + subagents.reduce((sum, task) => sum + searchSteps(task).length, 0),
		reportedRequests: 0,
		input: null,
		output: null,
		cached: null,
		cacheRate: null,
		cacheMeasured: 0,
		reasoning: null,
		partial: false,
		requestUsages,
		compactions: {...workUsage(compactions.map(event => event.usage)), requests: compactionUsages.flat().length},
		subagents: {...workUsage(subagents.map(task => task.usage)), requests: subagentUsages.flat().length},
	}
	let sum: RequestUsage | null = null
	let cacheInput = 0, cached = 0
	for (const item of requestUsages) {
		const usage = requestUsage(item)
		if (!usage) continue
		totals.reportedRequests++
		sum = addUsage(sum, usage)
		if (usage.cached !== null && usage.input !== null) {
			totals.cacheMeasured++
			cached += usage.cached
			cacheInput += usage.input
		}
	}
	totals.cacheRate = totals.cacheMeasured && cacheInput > 0 ? cached / cacheInput : null
	const usage = result?.usage
	if (usage) {
		const reported = Boolean(usage.reported)
		totals.input = reported ? count(usage.input) : null
		totals.output = reported ? count(usage.output) : null
		totals.cached = reported && usage.cache_reported ? count(usage.cached) : null
		totals.reasoning = reported && usage.reasoning_reported ? count(usage.reasoning) : null
		totals.partial = Boolean(usage.partial) || totals.reportedRequests < totals.requests
	} else {
		totals.input = sum?.input ?? null
		totals.output = sum?.output ?? null
		totals.cached = sum?.cached ?? null
		totals.reasoning = sum?.reasoning ?? null
		totals.partial = totals.reportedRequests < totals.requests
	}
	return totals
}

/**
 * Work still running: the streaming request, running compactions and running subagents. Their reported usage so far
 * is a provisional figure shown apart from the totals, never added to them. The request counts only during the model
 * stage (liveStepIndex): once the stage moves on, the server total provably holds it and nothing here repeats it.
 */
export function inFlight(result: RunResult | undefined, running: boolean): InFlight | null {
	if (!running || !result) return null
	const live = liveStepIndex(result, running)
	const compactions = (result.auto_compactions ?? NO_COMPACTIONS).filter(event => compactionStatus(event) === 'running')
	const subagents = (result.subagents ?? NO_SUBAGENTS).filter(task => subagentStatus(task) === 'running')
	const usages = [
		...(live >= 0 ? [result.steps?.[live]?.usage] : []),
		...compactions.map(compactionUsage),
		...subagents.map(task => task.usage),
	]
	if (!usages.length) return null
	const work = workUsage(usages)
	return {request: live >= 0, compactions: compactions.length, subagents: subagents.length, reported: work.reported, usage: work.usage}
}

export function subagentCounts(result?: RunResult): Record<SubagentStatus, number> {
	const counts: Record<SubagentStatus, number> = {running: 0, completed: 0, failed: 0, stopped: 0}
	for (const task of result?.subagents ?? NO_SUBAGENTS) counts[subagentStatus(task)]++
	return counts
}
