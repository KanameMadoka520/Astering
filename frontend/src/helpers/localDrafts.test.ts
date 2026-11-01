import {afterEach, describe, expect, it, vi} from 'vitest'

import {removeToken, saveToken} from '@/helpers/auth'
import {captureClientRequestContext} from '@/client/requestContext'
import {captureDraftLease, editorDraftNamespace} from '@/helpers/draftScope'
import {captureEditorDraftLease, clearEditorDraft, loadEditorDraft, saveEditorDraft, scopedEditorDraftKey} from '@/helpers/editorDraftStorage'
import {compassAccountNamespace, readCompassStorage, removeCompassStorageByPrefix, writeCompassStorage} from '@/helpers/compass/storage'
import {compassDraftKey} from '@/helpers/compass/drafts'
import {clearAccountDrafts, clearStorageKeepingScopedDrafts, countLocalDrafts} from '@/helpers/localDrafts'

const API = 'https://tasks.example.com/api/v1/'
const OTHER_API = 'https://other.example.com/api/v1/'
const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
const asUser = (id: number) => saveToken(token(id), false)

function editorNamespace(apiBaseUrl: string, id: number) {
	return editorDraftNamespace({...captureClientRequestContext(), apiBaseUrl, identity: {id, type: 1}})
}

function scope(id: number, apiBaseUrl = API) {
	return {compass: compassAccountNamespace(apiBaseUrl, id), editor: editorNamespace(apiBaseUrl, id)}
}

function writeTaskDraft(id: number, taskId: number, text: string, apiBaseUrl = API) {
	saveEditorDraft(scopedEditorDraftKey(editorNamespace(apiBaseUrl, id), `task-description-${taskId}`), text)
}

function compassKey(id: number, apiBaseUrl = API) {
	return compassDraftKey(compassAccountNamespace(apiBaseUrl, id), 5, 0)
}

afterEach(() => {
	vi.restoreAllMocks()
	removeCompassStorageByPrefix('tcymc-compass-draft:')
	removeToken()
	localStorage.clear()
})

describe('editor draft namespace', () => {
	it('is empty without an account, so nothing is kept for nobody', () => {
		removeToken()
		expect(editorDraftNamespace()).toBe('')
		expect(scopedEditorDraftKey(editorDraftNamespace(), 'task-description-1')).toBe('')
	})

	it('differs per account and per API server', () => {
		expect(editorNamespace(API, 1)).not.toBe(editorNamespace(API, 2))
		expect(editorNamespace(API, 1)).not.toBe(editorNamespace(OTHER_API, 1))
	})
})

describe('countLocalDrafts', () => {
	it("counts this account's drafts only and older drafts that belong to nobody", () => {
		writeTaskDraft(1, 10, '<p>mine</p>')
		writeTaskDraft(1, 11, '<p></p>')
		writeTaskDraft(2, 10, '<p>account B</p>')
		writeTaskDraft(1, 12, '<p>other server</p>', OTHER_API)
		writeCompassStorage(compassKey(1), '{"v":1}')
		writeCompassStorage(compassKey(2), '{"v":1}')
		localStorage.setItem('editorDraft-task-description-3', '<p>from before accounts</p>')

		expect(countLocalDrafts(scope(1))).toEqual({compass: 1, tasks: 2, legacy: 1})
		expect(countLocalDrafts(scope(2))).toEqual({compass: 1, tasks: 1, legacy: 1})
		expect(countLocalDrafts(scope(1, OTHER_API))).toEqual({compass: 0, tasks: 1, legacy: 1})
	})

	it('finds nothing without an account', () => {
		writeTaskDraft(1, 10, '<p>mine</p>')
		expect(countLocalDrafts({compass: '', editor: ''})).toEqual({compass: 0, tasks: 0, legacy: 0})
	})
})

describe('clearAccountDrafts', () => {
	it("removes this account's drafts, including copies only kept in memory, and leaves other accounts alone", () => {
		writeTaskDraft(1, 10, '<p>mine</p>')
		writeTaskDraft(2, 10, '<p>account B</p>')
		writeCompassStorage(compassKey(2), '{"v":1,"who":"B"}')
		const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('full', 'QuotaExceededError')
		})
		expect(writeCompassStorage(compassKey(1), '{"v":1,"who":"A"}')).toBe(false)
		setItem.mockRestore()
		expect(readCompassStorage(compassKey(1))).toBe('{"v":1,"who":"A"}')

		clearAccountDrafts(scope(1))

		expect(readCompassStorage(compassKey(1))).toBeNull()
		expect(countLocalDrafts(scope(1))).toMatchObject({compass: 0, tasks: 0})
		expect(readCompassStorage(compassKey(2))).toBe('{"v":1,"who":"B"}')
		expect(countLocalDrafts(scope(2))).toMatchObject({compass: 1, tasks: 1})
	})

	it.each([1, 2])('old callbacks stay fenced after account %i signs in, including acknowledgements', id => {
		asUser(1)
		const key = scopedEditorDraftKey(editorNamespace(API, 1), 'task-description-10')
		const oldLease = captureEditorDraftLease(key)
		const oldCompassLease = captureDraftLease(scope(1).compass)
		clearAccountDrafts(scope(1))
		clearStorageKeepingScopedDrafts()
		asUser(id)
		const newLease = captureEditorDraftLease(key)
		saveEditorDraft(key, 'new session writing', newLease)
		writeCompassStorage(compassKey(1), 'new compass writing', captureDraftLease(scope(1).compass))
		saveEditorDraft(key, 'late old failure', oldLease)
		clearEditorDraft(key, oldLease)
		writeCompassStorage(compassKey(1), 'late compass dispose', oldCompassLease)
		expect(loadEditorDraft(key)).toBe('new session writing')
		expect(readCompassStorage(compassKey(1))).toBe('new compass writing')
	})

	it('observes a clear performed by another open tab', () => {
		const key = scopedEditorDraftKey(editorNamespace(API, 31), 'task-description-10')
		const oldLease = captureEditorDraftLease(key)
		localStorage.setItem(`draftLease-v1:${encodeURIComponent(oldLease.namespace)}`, 'other-tab-cleared')
		saveEditorDraft(key, 'new tab writing', captureEditorDraftLease(key))
		saveEditorDraft(key, 'late write', oldLease)
		clearEditorDraft(key, oldLease, 'new tab writing')
		expect(loadEditorDraft(key)).toBe('new tab writing')
	})

	it('does not let an old successful save delete newer typing in the same session', () => {
		const key = scopedEditorDraftKey(editorNamespace(API, 1), 'task-description-10')
		const lease = captureEditorDraftLease(key)
		saveEditorDraft(key, 'newer typing', lease)
		clearEditorDraft(key, lease, 'submitted older text')
		expect(loadEditorDraft(key)).toBe('newer typing')
	})

})

describe('clearStorageKeepingScopedDrafts', () => {
	it('keeps account-scoped drafts and removes tokens, settings and drafts nobody owns', () => {
		asUser(1)
		localStorage.setItem('desktopOAuthRefreshToken', 'refresh')
		localStorage.setItem('tcymc-ai-settings', '{"apiKey":"secret"}')
		localStorage.setItem('editorDraft-v2:fake-settings', 'secret')
		localStorage.setItem('editorDraft-task-description-3', '<p>from before accounts</p>')
		writeTaskDraft(1, 10, '<p>mine</p>')
		writeCompassStorage(compassKey(1), '{"v":1}')
		writeCompassStorage('tcymc-compass-reading:v1:x', '{}')

		clearStorageKeepingScopedDrafts()

		expect(localStorage.getItem('token')).toBeNull()
		expect(localStorage.getItem('desktopOAuthRefreshToken')).toBeNull()
		expect(localStorage.getItem('tcymc-ai-settings')).toBeNull()
		expect(localStorage.getItem('editorDraft-v2:fake-settings')).toBeNull()
		expect(localStorage.getItem('editorDraft-task-description-3')).toBeNull()
		expect(localStorage.getItem('tcymc-compass-reading:v1:x')).toBeNull()
		expect(countLocalDrafts(scope(1))).toEqual({compass: 1, tasks: 1, legacy: 0})
	})
})
