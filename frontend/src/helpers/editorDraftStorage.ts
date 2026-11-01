import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import {captureDraftLease, isDraftLeaseCurrent, type DraftLease} from '@/helpers/draftScope'

const STORAGE_KEY_PREFIX = 'editorDraft-'

export function scopedEditorDraftKey(namespace: string, key: string): string {
	return namespace === '' ? '' : `v2:${namespace}:${key}`
}

export function captureEditorDraftLease(storageKey: string): DraftLease {
	const namespace = /^v2:([^:]+:\d+:\d+):/.exec(storageKey)?.[1] ?? `legacy:${storageKey}`
	return captureDraftLease(namespace)
}

function accepts(storageKey: string, lease?: DraftLease): boolean {
	return storageKey !== '' && (!lease || (
		isDraftLeaseCurrent(lease) && captureEditorDraftLease(storageKey).namespace === lease.namespace
	))
}

// Empty text can be an intentional edit of an existing description/comment, rather than no draft.
export function editorDraftRetainsEmpty(storageKey: string): boolean {
	return /:task-(?:description-\d+|comment-\d+-edit-\d+)$/.test(storageKey)
}

export function saveEditorDraft(storageKey: string, content: string, lease?: DraftLease) {
	if (!accepts(storageKey, lease)) return
	try {
		const key = `${STORAGE_KEY_PREFIX}${storageKey}`
		if (isEditorContentEmpty(content) && !editorDraftRetainsEmpty(storageKey)) {
			localStorage.removeItem(key)
		} else {
			if (localStorage.getItem(key) !== content) localStorage.setItem(key, content)
		}
	} catch (error) {
		console.warn('Failed to save editor draft:', error)
	}
}

export function loadEditorDraft(storageKey: string): string | null {
	if (!storageKey) return null
	try {
		return localStorage.getItem(`${STORAGE_KEY_PREFIX}${storageKey}`)
	} catch (error) {
		console.warn('Failed to load editor draft:', error)
		return null
	}
}

/** A server acknowledgement may remove only the exact text it saved, never newer typing. */
export function clearEditorDraft(storageKey: string, lease?: DraftLease, expected?: string) {
	if (!accepts(storageKey, lease)) return
	try {
		const key = `${STORAGE_KEY_PREFIX}${storageKey}`
		if (expected !== undefined && localStorage.getItem(key) !== expected) return
		localStorage.removeItem(key)
	} catch (error) {
		console.warn('Failed to clear editor draft:', error)
	}
}
