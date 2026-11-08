import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DOMWrapper, enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {ApiError} from '@/client/problem'

const sdk = vi.hoisted(() => ({notesUpdate: vi.fn()}))
const session = vi.hoisted(() => ({epoch: 1}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => null,
	getTokenIdentity: () => ({id: 1, type: 1}),
	getAuthSessionEpoch: () => session.epoch,
	onTokenRefreshed: () => () => undefined,
}))
vi.mock('vue-router', async original => ({
	...await original<typeof import('vue-router')>(),
	onBeforeRouteLeave: vi.fn(),
	onBeforeRouteUpdate: vi.fn(),
}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import {noteKeys, normalizeNote} from '@/client/queries/notes'
import XButton from '@/components/input/Button.vue'
import NoteEditor from './NoteEditor.vue'

enableAutoUnmount(afterEach)

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

describe('note editor saves and drafts', () => {
	let client: QueryClient
	const original = normalizeNote({id: 3, title: 'Thoughts', content: 'Original', revision: 1})
	function editor(realModal = false, serverNote = original) {
		client.setQueryData(noteKeys.detail(3), original)
		return mount(NoteEditor, {
			attachTo: realModal ? document.body : undefined,
			props: {note: original, reload: async () => serverNote},
			global: {
				plugins: [[VueQueryPlugin, {queryClient: client}]],
				components: {XButton},
				mocks: {$t: (key: string) => key},
				stubs: {Icon: true, MarkdownBlock: true, Modal: !realModal},
			},
		})
	}
	beforeEach(() => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
		vi.clearAllMocks()
		session.epoch = 1
		client = new QueryClient({defaultOptions: {mutations: {retry: false}, queries: {retry: false}}})
	})
	afterEach(() => {
		client.clear()
		vi.useRealTimers()
	})

	it('keeps a deleted note’s unsaved text available for export without allowing saves, edits or reloads', async () => {
		const wrapper = editor()
		await wrapper.get('textarea').setValue('My only unsaved copy')
		expect(wrapper.get('.note-editor__footer').text()).toContain('notes.markdownHelp')
		expect(wrapper.vm.hasUnsavedDraft()).toBe(true)
		await wrapper.setProps({deleted: true})
		await vi.advanceTimersByTimeAsync(2400)
		await wrapper.trigger('keydown', {key: 's', ctrlKey: true})
		expect(sdk.notesUpdate).not.toHaveBeenCalled()
		expect(wrapper.get('textarea').element.value).toBe('My only unsaved copy')
		expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
		expect(wrapper.get('.note-editor__title').attributes('readonly')).toBeDefined()
		expect(wrapper.find('.note-editor__actions').exists()).toBe(false)
		expect(wrapper.get('[role="alert"]').text()).toBe('notes.deletedDraft.help')
		expect(wrapper.get('.note-editor__exports').findAll('button')).toHaveLength(2)
		expect(wrapper.get('.note-editor__footer').text()).toContain('notes.deletedDraft.formatHelp')
		expect(wrapper.get('.note-editor__footer').text()).not.toContain('notes.markdownHelp')
		await wrapper.vm.appendTranscript('Do not resurrect this note')
		expect(wrapper.get('textarea').element.value).toBe('My only unsaved copy')
	})

	it('does not reopen a deleted draft’s comparison after an earlier reload finishes', async () => {
		const pending = deferred<ReturnType<typeof normalizeNote>>()
		const wrapper = editor(true)
		await wrapper.get('textarea').setValue('The last local copy')
		await wrapper.setProps({note: {...original, revision: 2}, reload: () => pending.promise})
		await wrapper.get('[role="alert"] .button').trigger('click')
		await wrapper.setProps({deleted: true})
		pending.resolve({...original, content: 'A stale read before deletion', revision: 2})
		await flushPromises()
		expect(document.querySelector('dialog[open]')).toBeNull()
		expect(wrapper.get('textarea').element.value).toBe('The last local copy')
		expect(wrapper.get('.note-editor__status').text()).toBe('notes.deletedDraft.status')
		await vi.advanceTimersByTimeAsync(2400)
		expect(sdk.notesUpdate).not.toHaveBeenCalled()
	})

	it.each([
		'content',
		'title',
		'pinned',
	] as const)('preserves newer %s while a save is in flight, then saves against the new revision', async field => {
		const pending = deferred<{data: ReturnType<typeof normalizeNote>}>()
		sdk.notesUpdate.mockImplementationOnce(() => pending.promise)
		const wrapper = editor()
		const body = wrapper.get('textarea')
		await body.setValue('First version')
		await wrapper.get('.note-editor__actions .button.is-primary').trigger('click')
		await flushPromises()
		const expected = {
			title: 'Thoughts',
			content: 'First version',
			pinned: false,
		}
		if (field === 'content') {
			expected.content = 'Second version'
			await body.setValue(expected.content)
		} else if (field === 'title') {
			expected.title = 'Newer heading'
			await wrapper.get('.note-editor__title').setValue(expected.title)
		} else {
			expected.pinned = true
			await wrapper.findAll('.note-editor__actions .button')[0].trigger('click')
		}
		expect(sdk.notesUpdate).toHaveBeenCalledTimes(1)
		pending.resolve({data: {...original, content: 'First version', revision: 2}})
		await flushPromises()
		expect((body.element as HTMLTextAreaElement).value).toBe(expected.content)
		expect((wrapper.get('.note-editor__title').element as HTMLInputElement).value).toBe(expected.title)
		expect(wrapper.findAll('.note-editor__actions .button')[0].attributes('aria-pressed')).toBe(String(expected.pinned))
		sdk.notesUpdate.mockResolvedValueOnce({data: {...original, ...expected, revision: 3}})
		await vi.advanceTimersByTimeAsync(1200)
		await flushPromises()
		expect(sdk.notesUpdate).toHaveBeenLastCalledWith({
			path: {id: 3},
			body: {
				...expected,
				expected_revision: 2,
			},
		})
	})

	it.each([409, 503])('retains unsaved text after HTTP %s and does not retry it automatically', async status => {
		sdk.notesUpdate.mockRejectedValue(new ApiError({status, detail: 'Simulated failure'}))
		const wrapper = editor()
		await wrapper.get('textarea').setValue('Keep my draft')
		await wrapper.get('.note-editor__actions .button.is-primary').trigger('click')
		await flushPromises()
		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Keep my draft')
		expect(wrapper.get('[role="alert"]').text()).toContain(status === 409 ? 'notes.save.conflictHelp' : 'notes.save.error')
		await vi.advanceTimersByTimeAsync(6000)
		expect(sdk.notesUpdate).toHaveBeenCalledTimes(1)
	})

	it('never dispatches a timer save after the authentication session changed', async () => {
		const wrapper = editor()
		await wrapper.get('textarea').setValue('Old account draft')
		session.epoch++
		await vi.advanceTimersByTimeAsync(1200)
		expect(sdk.notesUpdate).not.toHaveBeenCalled()
	})

	it('reuses leave approval only for the same immutable editorial snapshot', async () => {
		const originalConfirm = Object.getOwnPropertyDescriptor(window, 'confirm')
		const confirm = vi.fn(() => true)
		Object.defineProperty(window, 'confirm', {
			configurable: true,
			writable: true,
			value: confirm,
		})
		try {
			const wrapper = editor()
			await wrapper.get('textarea').setValue('Unsaved first draft')
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(confirm).toHaveBeenCalledTimes(1)
			await wrapper.get('textarea').setValue('Unsaved newer draft')
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(confirm).toHaveBeenCalledTimes(2)
			await wrapper.get('.note-editor__title').setValue('Another heading')
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(confirm).toHaveBeenCalledTimes(3)
			await wrapper.findAll('.note-editor__actions .button')[0].trigger('click')
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(confirm).toHaveBeenCalledTimes(4)
			expect(wrapper.vm.mayLeave()).toBe(true)
			expect(confirm).toHaveBeenCalledTimes(4)
			expect(sdk.notesUpdate).not.toHaveBeenCalled()
		} finally {
			if (originalConfirm) Object.defineProperty(window, 'confirm', originalConfirm)
			else Reflect.deleteProperty(window, 'confirm')
		}
	})

	it('appends selected original words to the existing article draft instead of replacing it', async () => {
		const wrapper = editor()
		await wrapper.get('textarea').setValue('Work already in progress')
		await wrapper.vm.appendTranscript('[00:00–00:06] Selected original words')
		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value)
			.toBe('Work already in progress\n\n[00:00–00:06] Selected original words')
		expect(sdk.notesUpdate).not.toHaveBeenCalled()
	})

	it('uses the real compare Modal primary to keep a conflicted draft without silently saving it', async () => {
		sdk.notesUpdate.mockRejectedValue(new ApiError({status: 409, detail: 'note_revision_conflict'}))
		const wrapper = editor(true, {...original, content: 'Changed in another browser', revision: 2})
		await wrapper.get('textarea').setValue('Keep my local article')
		await wrapper.get('.note-editor__actions .button.is-primary').trigger('click')
		await flushPromises()
		await wrapper.get('[role="alert"] .button').trigger('click')
		await flushPromises()
		const element = document.querySelector<HTMLDialogElement>('dialog[open]')
		expect(element).not.toBeNull()
		const dialog = new DOMWrapper(element!)
		const primary = dialog.get('.actions .button.is-primary')
		expect(primary.text()).toBe('notes.save.keepDraft')
		expect(dialog.findAll('button').filter(button => button.text() === 'notes.save.keepDraft')).toHaveLength(1)
		await primary.trigger('click')
		await flushPromises()
		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Keep my local article')
		expect(wrapper.get('[role="alert"]').text()).toBe('notes.save.rebased')
		await vi.advanceTimersByTimeAsync(3000)
		expect(sdk.notesUpdate).toHaveBeenCalledTimes(1)
		sdk.notesUpdate.mockResolvedValueOnce({data: {...original, content: 'Keep my local article', revision: 3}})
		await wrapper.get('.note-editor__actions .button.is-primary').trigger('click')
		await flushPromises()
		expect(sdk.notesUpdate).toHaveBeenLastCalledWith({
			path: {id: 3}, body: {title: original.title, content: 'Keep my local article', pinned: false, expected_revision: 2},
		})
	})
})
