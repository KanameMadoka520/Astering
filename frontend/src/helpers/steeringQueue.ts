import {ref} from 'vue'
import type {ClientRequestContext} from '@/client/requestContext'

/**
 * An instruction whose delivery this page has not seen confirmed. It is stored before its request starts, so a
 * reload, a closed panel or a later failure never loses the text, and a retry reuses the same request id.
 */
export type QueuedSteer = {
	chat: string
	turn: string
	requestID: string
	message: string
	// 'failed' means delivery is unknown (network or server error, or a page that went away mid-request);
	// 'refused' means the server answered that it queued nothing.
	state: 'sending' | 'failed' | 'refused'
	// The text the failure put back into the composer, '' when only the note keeps it.
	restored: string
	reason: string
}

export type SteerQueue = {
	// The account and server scope these entries belong to; see steerQueueOwner.
	owner: string
	entries: readonly QueuedSteer[]
	// False when session storage refused the entries: they last only while this page stays open.
	saved: boolean
}

const version = ref(0)
// Requests this page is still waiting on. A 'sending' entry without one was cut off with an earlier page.
const inFlight = new Set<string>()
// Where session storage is unavailable or full, and without a known account, whose entries another login could read.
const unsaved = new Map<string, readonly QueuedSteer[]>()

// The same account and server scope as the composer drafts, so another login never sees these.
function storageKey(context: ClientRequestContext) {
	return `tcy-ai-steer:${JSON.stringify([context.apiBaseUrl, context.identity])}`
}

/** Compared with a shown queue's owner before acting on its entries: the account can change unseen. */
export function steerQueueOwner(context: ClientRequestContext): string {
	return storageKey(context)
}

function isQueuedSteer(value: unknown): value is QueuedSteer {
	const entry = value as Partial<QueuedSteer> | null
	return typeof entry === 'object' && entry !== null
		&& ['chat', 'turn', 'requestID', 'message', 'restored', 'reason'].every(key => typeof entry[key as keyof QueuedSteer] === 'string')
		&& ['sending', 'failed', 'refused'].includes(entry.state as string)
}

// undefined when the storage cannot be read at all.
function stored(key: string): readonly QueuedSteer[] | undefined {
	let raw: string | null
	try {
		raw = sessionStorage.getItem(key)
	} catch {
		return undefined
	}
	try {
		const parsed: unknown = JSON.parse(raw || '[]')
		return Array.isArray(parsed) ? parsed.filter(isQueuedSteer) : []
	} catch {
		return []
	}
}

/** The account's unconfirmed instructions, reactive to every change this page makes. */
export function readSteerQueue(context: ClientRequestContext): SteerQueue {
	void version.value
	const key = storageKey(context)
	const memory = unsaved.get(key)
	const persisted = memory || !context.identity ? undefined : stored(key)
	const entries = memory ?? persisted ?? []
	return {
		owner: key,
		entries: entries.map(entry => entry.state === 'sending' && !inFlight.has(entry.requestID)
			? {...entry, state: 'failed'}
			: entry),
		saved: !memory && persisted !== undefined,
	}
}

/** Writes for the context the caller captured; callers check it is still current after any await. */
export function updateSteerQueue(
	context: ClientRequestContext,
	update: (entries: readonly QueuedSteer[]) => readonly QueuedSteer[],
) {
	const key = storageKey(context)
	const current = unsaved.get(key) ?? (context.identity ? stored(key) : undefined) ?? []
	const next = update(current)
	if (next === current) return
	if (!context.identity) {
		unsaved.set(key, next)
		version.value++
		return
	}
	try {
		if (next.length) sessionStorage.setItem(key, JSON.stringify(next))
		else sessionStorage.removeItem(key)
		unsaved.delete(key)
	} catch {
		unsaved.set(key, next)
	}
	version.value++
}

export function markSteerInFlight(requestID: string, sending: boolean) {
	if (sending) inFlight.add(requestID)
	else inFlight.delete(requestID)
	version.value++
}
