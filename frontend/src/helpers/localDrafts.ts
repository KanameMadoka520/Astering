import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import {editorDraftRetainsEmpty} from '@/helpers/editorDraftStorage'
import {compassStorageKey, compassStorageKeys, removeCompassStorageByPrefix} from '@/helpers/compass/storage'
import {invalidateDraftLeases, isDraftLeaseStorageKey, isScopedContentDraftKey} from '@/helpers/draftScope'

const EDITOR_PREFIX = 'editorDraft-'
const SCOPED_EDITOR_PREFIX = 'editorDraft-v2:'

export type DraftScope = {
	// Compass drafts: `compassAccountNamespace()`.
	compass: string
	// Task editor drafts: `editorDraftNamespace()`.
	editor: string
}

export type LocalDraftCount = {
	compass: number
	tasks: number
	// Unsent task texts from before drafts were tied to an account; logging out removes them.
	legacy: number
}

function compassPrefix(namespace: string) {
	return namespace === '' ? null : `${compassStorageKey('draft', namespace)}:`
}

function editorPrefix(namespace: string) {
	return namespace === '' ? null : `${SCOPED_EDITOR_PREFIX}${namespace}:`
}

function storageKeys(storage: Storage): string[] {
	const keys: string[] = []
	try {
		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index)
			if (key !== null) keys.push(key)
		}
	} catch {
		// Storage the browser refuses to read holds nothing.
	}
	return keys
}

function hasText(storage: Storage, key: string): boolean {
	try {
		const value = storage.getItem(key)
		return value !== null && (editorDraftRetainsEmpty(key) || !isEditorContentEmpty(value))
	} catch {
		return false
	}
}

/** Writing that only this device holds for the given account, plus legacy task texts nobody can be matched to. */
export function countLocalDrafts(scope: DraftScope, storage: Storage = window.localStorage): LocalDraftCount {
	const compass = compassPrefix(scope.compass)
	const editor = editorPrefix(scope.editor)
	const keys = storageKeys(storage)
	return {
		compass: compass === null ? 0 : compassStorageKeys(compass).length,
		tasks: editor === null ? 0 : keys.filter(key => key.startsWith(editor) && hasText(storage, key)).length,
		legacy: keys.filter(key => key.startsWith(EDITOR_PREFIX) && !key.startsWith(SCOPED_EDITOR_PREFIX) && hasText(storage, key)).length,
	}
}

/** Removes this account's drafts from this device (memory included) and keeps unmounting editors from rewriting them. */
export function clearAccountDrafts(scope: DraftScope, storage: Storage = window.localStorage) {
	invalidateDraftLeases(scope.compass)
	invalidateDraftLeases(scope.editor)
	const compass = compassPrefix(scope.compass)
	if (compass !== null) removeCompassStorageByPrefix(compass)
	const editor = editorPrefix(scope.editor)
	if (editor === null) return
	try {
		storageKeys(storage).filter(key => key.startsWith(editor)).forEach(key => storage.removeItem(key))
	} catch {
		// Nothing persisted to remove.
	}
}

/**
 * Logout: tokens, settings and caches go, account-scoped drafts stay so an expired or revoked session does not take
 * unsaved writing with it. They only come back for the same account on the same server.
 */
export function clearStorageKeepingScopedDrafts(storage: Storage = window.localStorage) {
	// Removing only non-retained keys avoids a transient gap in cross-tab clear tombstones, and does not risk
	// losing a retained draft if storage refuses a later attempt to put it back.
	for (const key of storageKeys(storage)) {
		if (isScopedContentDraftKey(key) || isDraftLeaseStorageKey(key)) continue
		storage.removeItem(key)
	}
}
