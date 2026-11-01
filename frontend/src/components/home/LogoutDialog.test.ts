import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {nextTick} from 'vue'

const {logoutMock} = vi.hoisted(() => ({logoutMock: vi.fn()}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => ({info: {id: 1}, logout: logoutMock})}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => 'https://tasks.example.com/api/v1/'}))
vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))

import LogoutDialog from './LogoutDialog.vue'
import XButton from '@/components/input/Button.vue'
import {removeToken, saveToken} from '@/helpers/auth'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {captureEditorDraftLease, loadEditorDraft, saveEditorDraft, scopedEditorDraftKey} from '@/helpers/editorDraftStorage'

const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
let wrapper: VueWrapper<InstanceType<typeof LogoutDialog>> | undefined
let draftKey = ''

beforeEach(() => {
	logoutMock.mockReset().mockResolvedValue(undefined)
	saveToken(token(1), false)
	draftKey = scopedEditorDraftKey(editorDraftNamespace(), 'task-description-10')
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	document.body.innerHTML = ''
	removeToken()
	localStorage.clear()
})

async function open() {
	wrapper = mount(LogoutDialog, {
		attachTo: document.body,
		global: {
			mocks: {$t: (key: string) => key},
			components: {XButton},
			stubs: {Icon: true},
		},
	})
	wrapper.vm.request()
	await flushPromises()
	await nextTick()
	return wrapper
}

function footer() {
	const [cancel, confirm] = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog .actions .button'))
	return {cancel, confirm}
}

describe('LogoutDialog', () => {
	it('logs out right away when nothing unsaved is kept here', async () => {
		await open()
		expect(logoutMock).toHaveBeenCalledTimes(1)
		expect(document.querySelector('dialog[open]')).toBeNull()
	})

	it('asks first and keeps the drafts by default', async () => {
		saveEditorDraft(draftKey, '<p>half a sentence</p>')
		await open()
		expect(logoutMock).not.toHaveBeenCalled()
		const dialog = document.querySelector('dialog')
		expect(dialog?.textContent).toContain('user.auth.logoutDrafts.tasks')
		const checkbox = document.querySelector<HTMLInputElement>('[data-cy="logoutRemoveDrafts"]')
		expect(checkbox?.checked).toBe(false)
		const {confirm} = footer()
		expect(confirm?.textContent).toContain('user.auth.logoutDrafts.confirmKeep')

		confirm?.click()
		await flushPromises()

		expect(logoutMock).toHaveBeenCalledTimes(1)
		expect(loadEditorDraft(draftKey)).toBe('<p>half a sentence</p>')
	})

	it('Cancel does not log out', async () => {
		saveEditorDraft(draftKey, '<p>half a sentence</p>')
		await open()
		footer().cancel?.click()
		await flushPromises()
		expect(logoutMock).not.toHaveBeenCalled()
		expect(loadEditorDraft(draftKey)).toBe('<p>half a sentence</p>')
	})

	it('removes the drafts only when that is chosen, and nothing writes them back afterwards', async () => {
		saveEditorDraft(draftKey, '<p>half a sentence</p>')
		const oldLease = captureEditorDraftLease(draftKey)
		await open()
		const checkbox = document.querySelector<HTMLInputElement>('[data-cy="logoutRemoveDrafts"]')
		checkbox!.checked = true
		checkbox!.dispatchEvent(new Event('change'))
		await nextTick()
		const {confirm} = footer()
		expect(confirm?.textContent).toContain('user.auth.logoutDrafts.confirmRemove')

		confirm?.click()
		await flushPromises()

		expect(logoutMock).toHaveBeenCalledTimes(1)
		expect(loadEditorDraft(draftKey)).toBeNull()
		saveEditorDraft(draftKey, '<p>written by an editor while closing</p>', oldLease)
		expect(loadEditorDraft(draftKey)).toBeNull()
	})
})
