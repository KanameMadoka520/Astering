import {captureClientRequestContext, type ClientRequestContext} from '@/client/requestContext'

/**
 * Local drafts that may outlive a session. Each key carries the account and API server it was written for, so a
 * later login only gets its own drafts back. Everything else in local storage is cleared on logout.
 */
/** The account + API scope of task editor drafts; '' without a signed-in identity (nothing is kept then). */
export function editorDraftNamespace(context: ClientRequestContext = captureClientRequestContext()): string {
	const identity = context.identity
	if (!identity) return ''
	return `${encodeURIComponent(context.apiBaseUrl)}:${identity.type}:${identity.id}`
}

// Tombstones survive logout so another open tab can reject a late write/ack from before an explicit clear.
const LEASE_PREFIX = 'draftLease-v1:'
export type DraftLease = Readonly<{
	namespace: string,
	generation: string,
}>
const generations = new Map<string, string>()

function currentGeneration(namespace: string): string {
	if (generations.has(namespace)) return generations.get(namespace)!
	try {
		return localStorage.getItem(`${LEASE_PREFIX}${encodeURIComponent(namespace)}`) ?? ''
	} catch {
		return generations.get(namespace) ?? ''
	}
}

export function captureDraftLease(namespace: string): DraftLease {
	return {namespace, generation: currentGeneration(namespace)}
}

export function invalidateDraftLeases(namespace: string) {
	if (namespace === '') return
	const generation = crypto.randomUUID()
	try {
		localStorage.setItem(`${LEASE_PREFIX}${encodeURIComponent(namespace)}`, generation)
		generations.delete(namespace)
	} catch {
		generations.set(namespace, generation)
		// Storage refusal limits this fence to this tab, just like the in-memory draft fallback.
	}
}

export function isDraftLeaseCurrent(lease: DraftLease): boolean {
	return lease.generation === currentGeneration(lease.namespace)
}

export function isDraftLeaseStorageKey(key: string): boolean {
	if (!key.startsWith(LEASE_PREFIX)) return false
	try {
		return /^[^:]+:\d+(?::\d+)?$/.test(decodeURIComponent(key.slice(LEASE_PREFIX.length)))
	} catch {
		return false
	}
}

/** Only known, account/API-scoped writing survives logout; settings and unowned legacy keys never do. */
export function isScopedContentDraftKey(key: string): boolean {
	return /^editorDraft-v2:[^:]+:\d+:\d+:task-(?:description-\d+|comment-\d+(?:-edit-\d+)?)$/.test(key)
		|| /^tcymc-compass-draft:v1:[^:]+:\d+:\d+:(?:\d+|new)$/.test(key)
}
