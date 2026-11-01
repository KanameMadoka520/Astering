import type {Action, ModelStep, Operation, RunResult, ToolCall} from '@/client/generated'

// Runtime records are typed through RunResult, so they follow the generated SDK.
export type AutoCompaction = NonNullable<RunResult['auto_compactions']>[number]
export type SubagentTask = NonNullable<RunResult['subagents']>[number]

// Shared empties keep completed rounds' props identical between live frames.
export const NO_STEPS: readonly ModelStep[] = Object.freeze([])
export const NO_ACTIONS: readonly Action[] = Object.freeze([])
export const NO_OPERATIONS: readonly Operation[] = Object.freeze([])
export const NO_COMPACTIONS: readonly AutoCompaction[] = Object.freeze([])
export const NO_SUBAGENTS: readonly SubagentTask[] = Object.freeze([])

export const GROUP_MIN = 4

export type TimelineEntry = {
	key: string
	tool: string
	call?: ToolCall
	action?: Action
	operation?: Operation
}

export type TimelineGroup = {
	kind: 'group'
	key: string
	tool: string
	entries: TimelineEntry[]
	succeeded: number
	failed: number
	rejected: number
	pending: number
	durationMs: number | null
}

export type TimelineItem = {kind: 'entry', key: string, entry: TimelineEntry} | TimelineGroup

// Go measures these limits in UTF-8 bytes; a UTF-16 unit is one to three of them.
const utf8 = new TextEncoder()
function bytesOver(text: string, limit: number): boolean {
	return text.length > limit || (text.length * 3 > limit && utf8.encode(text).length > limit)
}

/**
 * Mirrors the backend's resolveInvocation: invoke_tool runs a discovered tool only for an envelope of exactly
 * {name, arguments}, with a usable name and an arguments object. Anything else runs, and fails, as invoke_tool itself.
 */
function invocation(call?: ToolCall): {name: string, args: Record<string, unknown>} | null {
	if (call?.function?.name !== 'invoke_tool') return null
	const raw = call.function.arguments ?? ''
	if (bytesOver(raw, 64000)) return null
	const envelope = parseJSON(raw)
	if (!isRecord(envelope) || Object.keys(envelope).sort().join() !== 'arguments,name') return null
	const {name, arguments: args} = envelope
	return typeof name === 'string' && name !== '' && name !== 'invoke_tool' && !bytesOver(name, 128) && isRecord(args) ? {name, args} : null
}

// Actions record the inner tool name of a discovered tool, and invoke_tool when the envelope was malformed.
export function callName(call?: ToolCall): string {
	return invocation(call)?.name ?? call?.function?.name ?? ''
}

/** The arguments the backend validates for this call: the inner object of a resolved invoke_tool, else the raw text. */
export function callArguments(call?: ToolCall): string {
	const resolved = invocation(call)
	return resolved ? JSON.stringify(resolved.args) : call?.function?.arguments ?? ''
}

// The backend re-encodes validated arguments with sorted keys, so key order and number spelling never decide a match.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
	return JSON.stringify(value) ?? 'null'
}

export function argumentKey(raw = ''): string {
	try {
		return canonical(JSON.parse(raw))
	} catch {
		return raw.trim()
	}
}

function matchKey(tool: string, raw?: string): string {
	return `${tool}\n${argumentKey(raw)}`
}

/** Same items in the same order; lets a computed keep its previous array so unchanged rounds keep identical props. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index])
}

export function finalAnswer(result: RunResult | undefined, running: boolean): string {
	if (running || !result) return ''
	if (result.reply) return result.reply
	const last = result.steps?.at(-1)
	return last && !last.tool_calls?.length ? last.text ?? '' : ''
}

// The answer block shows the last round's text; hide it in the timeline only when it is literally the same text.
export function hidesLastStepText(result: RunResult | undefined, running: boolean): boolean {
	const answer = finalAnswer(result, running).trim()
	const text = result?.steps?.at(-1)?.text?.trim()
	return Boolean(answer && text && text === answer)
}

export type CompactionStatus = 'running' | 'completed' | 'failed'
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped'
const COMPACTION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed'])
const SUBAGENT_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'stopped'])

// An unrecognised status reads as failed, so it is never mistaken for finished work.
export function compactionStatus(event: AutoCompaction): CompactionStatus {
	const status = event.status ?? ''
	return COMPACTION_STATUSES.has(status) ? status as CompactionStatus : 'failed'
}
export function subagentStatus(task: SubagentTask): SubagentStatus {
	const status = task.status ?? ''
	return SUBAGENT_STATUSES.has(status) ? status as SubagentStatus : 'failed'
}

/** Index of the round whose request is still streaming, or -1. */
export function liveStepIndex(result: RunResult | undefined, running: boolean): number {
	const steps = result?.steps ?? NO_STEPS
	const last = steps.at(-1)
	if (!running || result?.stage !== 'model' || !last) return -1
	// A new round is counted before its first upstream update; until then the last saved round is already finished.
	const rounds = result.budget?.rounds
	return typeof rounds === 'number' && typeof last.round === 'number' && rounds > last.round ? -1 : steps.length - 1
}

// Go timestamps carry nanoseconds; trimming to milliseconds parses in every browser. Zero time is unknown.
export function timeMs(value?: string): number | null {
	if (!value) return null
	const ms = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
	return Number.isFinite(ms) && ms > 0 ? ms : null
}

export type TimelineLayoutItem =
	| {kind: 'step', key: string, index: number, step: ModelStep}
	| {kind: 'compaction', key: string, event: AutoCompaction, first: boolean}
	| {kind: 'subagent', key: string, task: SubagentTask, first: boolean}

/**
 * Interleaves runtime records with the rounds: a compaction goes before the first round that started after it,
 * a subagent after the latest earlier round that called delegate_tasks. Anything unmatched follows the last round
 * in start order. `first` marks where a one-time explanation belongs.
 */
export function timelineLayout(
	steps: readonly ModelStep[],
	actions: readonly Action[] = NO_ACTIONS,
	compactions: readonly AutoCompaction[] = NO_COMPACTIONS,
	subagents: readonly SubagentTask[] = NO_SUBAGENTS,
): TimelineLayoutItem[] {
	const starts = steps.map(step => timeMs(step.started))
	const delegated = new Set(actions.filter(action => action.tool === 'delegate_tasks').map(action => action.round))
	const spawns = steps.map(step => (step.round !== undefined && delegated.has(step.round)) || Boolean(step.tool_calls?.some(call => callName(call) === 'delegate_tasks')))
	const before = steps.map((): TimelineLayoutItem[] => [])
	const after = steps.map((): TimelineLayoutItem[] => [])
	const tail: {at: number, item: TimelineLayoutItem}[] = []
	compactions.forEach((event, index) => {
		const at = timeMs(event.started)
		const item: TimelineLayoutItem = {kind: 'compaction', key: `compaction-${event.id || index}`, event, first: false}
		const next = at === null ? -1 : starts.findIndex(start => start !== null && start > at)
		if (next < 0) tail.push({at: at ?? Number.MAX_SAFE_INTEGER, item})
		else before[next].push(item)
	})
	subagents.forEach((task, index) => {
		const at = timeMs(task.started)
		const item: TimelineLayoutItem = {kind: 'subagent', key: `subagent-${task.id || index}`, task, first: false}
		let spawner = -1
		for (let i = steps.length - 1; at !== null && i >= 0; i--) {
			const start = starts[i]
			if (spawns[i] && start !== null && start <= at) {
				spawner = i
				break
			}
		}
		if (spawner < 0) tail.push({at: at ?? Number.MAX_SAFE_INTEGER, item})
		else after[spawner].push(item)
	})
	const items: TimelineLayoutItem[] = []
	steps.forEach((step, index) => items.push(...before[index], {kind: 'step', key: `step-${index}`, index, step}, ...after[index]))
	items.push(...tail.sort((a, b) => a.at - b.at).map(entry => entry.item))
	for (const kind of ['compaction', 'subagent'] as const) {
		const first = items.find(item => item.kind === kind)
		if (first && first.kind !== 'step') first.first = true
	}
	return items
}

function claim(used: Set<number>, count: number, matches: (index: number) => boolean): number {
	for (let index = 0; index < count; index++) {
		if (!used.has(index) && matches(index)) {
			used.add(index)
			return index
		}
	}
	return -1
}

/**
 * Pairs a round's calls in passes, so each call keeps its own status and result: an action with the same tool and
 * arguments; a rejected review decision with the same tool and arguments; then, because a reviewer may edit the
 * arguments, the k-th unexplained call of a name takes the k-th remaining action of that name; last, when allowed,
 * a remaining rejected decision of that name. Unpaired actions follow as their own rows.
 */
function pairCalls(step: ModelStep, own: readonly Action[], rejected: readonly Operation[], rejectedByName: boolean) {
	const entries: TimelineEntry[] = (step.tool_calls ?? []).map((call, index) => ({key: `call-${index}`, tool: callName(call), call}))
	const callKeys = entries.map(entry => matchKey(entry.tool, callArguments(entry.call)))
	const actionKeys = own.map(action => matchKey(action.tool ?? '', action.arguments))
	const rejectedKeys = rejected.map(operation => matchKey(operation.tool ?? '', operation.arguments))
	const usedActions = new Set<number>()
	const usedRejected = new Set<number>()
	const unexplained = (entry: TimelineEntry) => !entry.action && !entry.operation
	entries.forEach((entry, index) => {
		const match = claim(usedActions, own.length, j => actionKeys[j] === callKeys[index])
		if (match >= 0) entry.action = own[match]
	})
	entries.forEach((entry, index) => {
		if (!unexplained(entry)) return
		const match = claim(usedRejected, rejected.length, j => rejectedKeys[j] === callKeys[index])
		if (match >= 0) entry.operation = rejected[match]
	})
	entries.forEach(entry => {
		if (!unexplained(entry)) return
		const match = claim(usedActions, own.length, j => own[j].tool === entry.tool)
		if (match >= 0) entry.action = own[match]
	})
	if (rejectedByName) {
		entries.forEach(entry => {
			if (!unexplained(entry)) return
			const match = claim(usedRejected, rejected.length, j => rejected[j].tool === entry.tool)
			if (match >= 0) entry.operation = rejected[match]
		})
	}
	own.forEach((action, index) => {
		if (!usedActions.has(index)) entries.push({key: `action-${index}`, tool: action.tool ?? '', action})
	})
	return {entries, claimed: rejected.filter((_, index) => usedRejected.has(index))}
}

/**
 * A rejected review decision leaves a receipt but no action and no round. Each one belongs to the earliest round
 * with a matching unexplained call: same tool and arguments first, then same tool (a reviewer may edit, then reject).
 * Returns each round's own decisions; rounds without any share one empty array.
 */
export function rejectedByStep(steps: readonly ModelStep[], actions: readonly Action[], rejected: readonly Operation[]): (readonly Operation[])[] {
	const assigned = steps.map((): Operation[] => [])
	if (!rejected.length) return assigned.map(() => NO_OPERATIONS)
	const rounds = new Map<number | undefined, Action[]>()
	for (const action of actions) {
		const own = rounds.get(action.round)
		if (own) own.push(action)
		else rounds.set(action.round, [action])
	}
	let left = rejected
	for (const byName of [false, true]) {
		steps.forEach((step, index) => {
			// Only rounds that called a rejected tool can hold a decision; long turns skip the rest cheaply.
			const tools = new Set(left.map(operation => operation.tool))
			if (!tools.size || !step.tool_calls?.some(call => tools.has(callName(call)))) return
			const own = rounds.get(step.round) ?? NO_ACTIONS
			const added = pairCalls(step, own, [...assigned[index], ...left], byName).claimed.filter(operation => !assigned[index].includes(operation))
			assigned[index].push(...added)
			left = left.filter(operation => !added.includes(operation))
		})
	}
	return assigned.map(list => list.length ? list : NO_OPERATIONS)
}

/**
 * The round's timeline entries. `rejected` holds this round's own decisions from rejectedByStep. Pass operations
 * only for the live round: running receipts fill the matching pending call, never a rejected one, or are appended.
 */
export function stepEntries(
	step: ModelStep,
	actions: readonly Action[],
	operations: readonly Operation[] = NO_OPERATIONS,
	rejected: readonly Operation[] = NO_OPERATIONS,
): TimelineEntry[] {
	const own = actions.filter(action => action.round === step.round)
	const {entries} = pairCalls(step, own, rejected, true)
	operations.forEach((operation, index) => {
		if (operation.status !== 'running') return
		const key = matchKey(operation.tool ?? '', operation.arguments)
		const open = (entry: TimelineEntry) => !entry.action && !entry.operation && entry.tool === operation.tool
		const pending = entries.find(entry => open(entry) && matchKey(entry.tool, callArguments(entry.call)) === key) ?? entries.find(open)
		if (pending) {
			pending.operation = operation
			return
		}
		// The action may land before the receipt leaves "running"; it already shows this operation.
		if (operation.arguments && own.some(action => matchKey(action.tool ?? '', action.arguments) === key)) return
		entries.push({key: `operation-${operation.id || index}`, tool: operation.tool ?? '', operation})
	})
	return entries
}

export function groupEntries(entries: readonly TimelineEntry[], min = GROUP_MIN): TimelineItem[] {
	const items: TimelineItem[] = []
	let start = 0
	while (start < entries.length) {
		let end = start + 1
		while (end < entries.length && entries[end].tool === entries[start].tool) end++
		const run = entries.slice(start, end)
		if (run.length >= min) items.push(summarizeGroup(run))
		else items.push(...run.map(entry => ({kind: 'entry' as const, key: entry.key, entry})))
		start = end
	}
	return items
}

function summarizeGroup(entries: TimelineEntry[]): TimelineGroup {
	let succeeded = 0, failed = 0, rejected = 0, pending = 0, durationMs: number | null = null
	for (const {action, operation} of entries) {
		if (!action) {
			if (operation?.status === 'rejected') rejected++
			else pending++
			continue
		}
		if (action.success) succeeded++
		else failed++
		if (typeof action.duration_ms === 'number') durationMs = (durationMs ?? 0) + action.duration_ms
	}
	return {kind: 'group', key: `group-${entries[0].key}`, tool: entries[0].tool, entries, succeeded, failed, rejected, pending, durationMs}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function parseJSON(raw: string): unknown {
	try { return JSON.parse(raw) } catch { return raw }
}

// One line for a collapsed row; partial JSON from a streaming draft falls back to the raw text.
export function argumentSummary(raw?: string, max = 160): string {
	if (!raw) return ''
	const value = parseJSON(raw)
	if (typeof value === 'string') return clip(value.replace(/\s+/g, ' ').trim(), max)
	const scalar = (item: unknown) => typeof item === 'string' ? item : JSON.stringify(item) ?? ''
	const text = isRecord(value)
		? Object.entries(value).map(([key, item]) => `${key}: ${scalar(item)}`).join(', ')
		: scalar(value)
	return clip(text.replace(/\s+/g, ' ').trim(), max)
}

// Counts code points, so emoji and CJK are one character each. The streamed reasoning is counted on every frame, so
// this walks the text instead of spreading it into an array of characters.
export function characterCount(text?: string): number {
	if (!text) return 0
	let count = text.length
	for (let index = 0; index < text.length - 1; index++) {
		const code = text.charCodeAt(index)
		if (code < 0xD800 || code > 0xDBFF) continue
		const next = text.charCodeAt(index + 1)
		// A high surrogate followed by a low one is a single code point; a lone half counts as one, as before.
		if (next >= 0xDC00 && next <= 0xDFFF) {
			count--
			index++
		}
	}
	return count
}
