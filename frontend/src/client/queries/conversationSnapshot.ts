import {
	hashKey,
	replaceEqualDeep,
	type QueryFunctionContext,
	type QueryKey,
} from '@tanstack/vue-query'
import type {ChatTurn, Conversation} from '@/client/generated'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	type ClientRequestContext,
} from '@/client/requestContext'

export type ConversationActivity = Pick<Conversation,
	| 'storage'
	| 'compact_progress'
	| 'compacting'
	| 'compact_text'
	| 'compact_error'
	| 'compactions'
> & {turn?: ChatTurn}
type Entry = {
	revision: number
	fullWriteRevision: number
	requests: Set<SnapshotRequest>
	activity?: {revision: number, value: Omit<ConversationActivity, 'turn'>}
	turns: Map<string, {revision: number, value: ChatTurn}>
}
type Scope = {
	context: string
	entries: Map<string, Entry>
}
type QueryClient = QueryFunctionContext['client']
type SnapshotRequest = {
	client: QueryClient
	key: QueryKey
	scope: Scope
	entry: Entry
	revision: number
	context: ClientRequestContext
	closed: boolean
	signal?: AbortSignal
	abort?: () => void
	response?: Conversation
}
const scopes = new WeakMap<QueryClient, Scope>()
const responses = new WeakMap<object, SnapshotRequest>()
const invalidResponses = new WeakSet<object>()

function release(request: SnapshotRequest) {
	if (request.closed) return
	request.closed = true
	if (request.response && responses.get(request.response) === request) {
		// Keep a lightweight rejection fence even if cancellation happens between the queryFn and cache commit.
		invalidResponses.add(request.response)
		responses.delete(request.response)
	}
	request.response = undefined
	if (request.abort) request.signal?.removeEventListener('abort', request.abort)
	request.entry.requests.delete(request)
	if (!request.entry.requests.size) {
		request.entry.activity = undefined
		request.entry.turns.clear()
		if (!request.client.getQueryCache().find({queryKey: request.key, exact: true})) {
			request.scope.entries.delete(hashKey(request.key))
		}
	}
}
function forget(scope: Scope, hash: string) {
	const entry = scope.entries.get(hash)
	if (entry) [...entry.requests].forEach(release)
	scope.entries.delete(hash)
}
function entryFor(client: QueryClient, key: QueryKey) {
	const context = captureClientRequestContext()
	const identity = JSON.stringify([context.apiBaseUrl, context.identity, context.authSessionEpoch])
	let scope = scopes.get(client)
	if (!scope) {
		scope = {
			context: identity,
			entries: new Map(),
		}
		scopes.set(client, scope)
		const retained = scope
		client.getQueryCache().subscribe(event => {
			if (event.type === 'removed') forget(retained, event.query.queryHash)
		})
	} else if (scope.context !== identity) {
		for (const hash of scope.entries.keys()) forget(scope, hash)
		scope.context = identity
	}
	const hash = hashKey(key)
	let entry = scope.entries.get(hash)
	if (!entry) {
		entry = {
			revision: 0,
			fullWriteRevision: 0,
			requests: new Set(),
			turns: new Map(),
		}
		scope.entries.set(hash, entry)
	}
	return {
		context,
		scope,
		entry,
	}
}
function assertRequest(request: SnapshotRequest) {
	assertClientRequestContext(request.context)
	if (request.closed || request.signal?.aborted || request.scope.entries.get(hashKey(request.key)) !== request.entry) {
		throw new DOMException('Conversation request was superseded', 'AbortError')
	}
}
function beginConversationSnapshot(client: QueryClient, key: QueryKey, signal?: AbortSignal) {
	// Even a write before the view's first GET needs a real query lifecycle: clear/remove must fence its response.
	client.getQueryCache().build(client, client.defaultQueryOptions({queryKey: key}))
	const {context, scope, entry} = entryFor(client, key)
	const request: SnapshotRequest = {
		client,
		key,
		context,
		scope,
		entry,
		revision: entry.revision,
		closed: false,
		signal,
	}
	entry.requests.add(request)
	request.abort = () => release(request)
	signal?.addEventListener('abort', request.abort, {once: true})
	return request
}
function withActivity(current: Conversation, activity: Omit<ConversationActivity, 'turn'>): Conversation {
	return {
		...current,
		...activity,
		compact_progress: activity.compact_progress,
		compact_text: activity.compact_text ?? '',
		compact_error: activity.compact_error ?? '',
	}
}
function withTurn(current: Conversation, turn: ChatTurn): Conversation {
	const turns = current.turns ?? []
	return {
		...current,
		turns: turns.some(item => item.id === turn.id)
			? turns.map(item => item.id === turn.id ? turn : item)
			: [...turns, turn],
	}
}

/** Keep only updates overlapping an HTTP read, not a permanent preference for the stream. */
function reconcile(request: SnapshotRequest, incoming: Conversation, current?: Conversation): Conversation {
	assertRequest(request)
	const {entry, revision} = request
	if (entry.fullWriteRevision > revision && current) {
		// A newer confirmed write already contains the streamed progress. Do not replay older activity over it,
		// but an overlapping request may have created a distinct turn that was not present in that snapshot.
		const known = new Set(current.turns?.map(turn => turn.id))
		const additions = incoming.turns?.filter(turn => turn.id && !known.has(turn.id)) ?? []
		return additions.length ? {
			...current,
			turns: [...current.turns ?? [], ...additions],
		} : current
	}
	let next = incoming
	if (entry.activity && entry.activity.revision > revision) next = withActivity(next, entry.activity.value)
	for (const turn of entry.turns.values()) {
		if (turn.revision > revision) next = withTurn(next, turn.value)
	}
	return next
}

/** Tag the raw response; reconcile at Query's actual cache commit, after its promise continuation. */
export async function readConversationSnapshot(
	client: QueryClient,
	key: QueryKey,
	signal: AbortSignal,
	read: () => Promise<Conversation>,
): Promise<Conversation> {
	const request = beginConversationSnapshot(client, key, signal)
	try {
		const value = await read()
		assertRequest(request)
		request.response = value
		invalidResponses.delete(value)
		responses.set(value, request)
		return value
	} catch (cause) {
		release(request)
		throw cause
	}
}
export function shareConversationSnapshot(previous: unknown, next: unknown): unknown {
	if (next && typeof next === 'object' && invalidResponses.has(next)) {
		throw new DOMException('Conversation request was superseded', 'AbortError')
	}
	const request = next && typeof next === 'object' ? responses.get(next) : undefined
	if (!request) return replaceEqualDeep(previous, next)
	responses.delete(next as object)
	try {
		return replaceEqualDeep(previous, reconcile(request, next as Conversation, previous as Conversation | undefined))
	} finally {
		release(request)
	}
}

/** A mutation commits once while still bound to the request that obtained its full snapshot. */
export async function writeConversationSnapshot(
	client: QueryClient,
	key: QueryKey,
	write: () => Promise<Conversation>,
): Promise<Conversation> {
	const request = beginConversationSnapshot(client, key)
	try {
		const value = await write()
		const next = reconcile(request, value, client.getQueryData<Conversation>(key))
		// Reads do not fence an already-started write: a GET can still have sampled the old server state.
		request.entry.fullWriteRevision = ++request.entry.revision
		return client.setQueryData<Conversation>(key, next)!
	} finally {
		release(request)
	}
}

export function applyConversationActivity(client: QueryClient, key: QueryKey, value: ConversationActivity) {
	// Do not resurrect a removed conversation, or create an incomplete detail without its first GET.
	if (!client.getQueryCache().find({queryKey: key, exact: true})) return undefined
	const {entry} = entryFor(client, key)
	const revision = ++entry.revision
	const {turn, ...activity} = value
	if (entry.requests.size) {
		entry.activity = {
			revision,
			value: activity,
		}
		if (turn?.id) entry.turns.set(turn.id, {
			revision,
			value: turn,
		})
	}
	return client.setQueryData<Conversation>(key, current => {
		if (!current) return current
		const next = withActivity(current, activity)
		return turn ? withTurn(next, turn) : next
	})
}
