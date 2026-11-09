import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DOMWrapper, enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {ApiError} from '@/client/problem'

const sdk = vi.hoisted(() => ({noteSegmentsList: vi.fn()}))
const navigation = vi.hoisted(() => ({push: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useLiveNotePreferences', () => ({
	useLiveNotePreferences: () => ({timezone: {value: 'UTC'}}),
}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => null,
	getTokenIdentity: () => ({id: 1, type: 1}),
	getAuthSessionEpoch: () => 1,
	onTokenRefreshed: () => () => undefined,
}))
vi.mock('vue-router', async original => ({
	...await original<typeof import('vue-router')>(),
	useRouter: () => navigation,
}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string) => key,
		locale: {value: 'en'},
	}),
}))

import {noteKeys, receiveNoteTranscript} from '@/client/queries/notes'
import {captureClientRequestContext} from '@/client/requestContext'
import {takeAronaDraftHandoff} from '@/helpers/aronaDraftHandoff'
import XButton from '@/components/input/Button.vue'
import NoteTranscripts from './NoteTranscripts.vue'

enableAutoUnmount(afterEach)

function segment(id: number) {
	return {id, note_id: 3, client_id: `segment-${id}`, text: `Final ${id}`, start_ms: id * 1000, end_ms: id * 1000 + 900}
}
function page(first: number, total: number) {
	return {data: {
		items: Array.from({length: 100}, (_, index) => segment(first + index)),
		total, has_more: false, next_cursor: total, from_end: true,
	}}
}

describe('live transcript selection', () => {
	let client: QueryClient
	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.noteSegmentsList.mockResolvedValue(page(1, 100))
		navigation.push.mockResolvedValue(undefined)
	})
	afterEach(() => { client.clear() })
	function transcript(realModal = false) {
		return mount(NoteTranscripts, {
			attachTo: realModal ? document.body : undefined,
			props: {noteId: 3, noteTitle: 'Recording'},
			global: {
				plugins: [[VueQueryPlugin, {queryClient: client}]],
				components: {XButton},
				mocks: {$t: (key: string) => key},
				stubs: {Icon: true, Modal: !realModal, LiveVoiceRecorder: true},
			},
		})
	}

	it('freezes selected source while live tail advances, then explicitly resumes without carrying a stale selection', async () => {
		const wrapper = transcript()
		await flushPromises()
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
		receiveNoteTranscript(client, 3, {
			segment: segment(101), stats: {segment_count: 101, transcript_bytes: 1010, updated: '2026-11-08T12:00:00Z'},
		}, captureClientRequestContext())
		await flushPromises()
		expect(wrapper.findAll('.note-transcript')[0].text()).toContain('Final 1')
		expect(wrapper.text()).toContain('notes.transcript.paused')
		await wrapper.get('.note-transcripts__selection .button').trigger('click')
		expect(wrapper.emitted('append')?.[0][0]).toContain('Final 1')
		expect(wrapper.emitted('append')?.[0][0]).not.toContain('Final 101')
		sdk.noteSegmentsList.mockResolvedValue(page(2, 101))
		await wrapper.findAll('.note-transcripts__browsing button')[0].trigger('click')
		await flushPromises()
		expect(wrapper.findAll('.note-transcript')).toHaveLength(100)
		expect(wrapper.findAll('.note-transcript')[0].text()).toContain('Final 2')
		expect(wrapper.findAll('input:checked')).toHaveLength(0)
		expect(wrapper.text()).not.toContain('notes.transcript.paused')
		expect(wrapper.get('.note-transcripts__selection .button').attributes('aria-disabled')).toBe('true')
	})

	it('drops a frozen private snapshot if access is explicitly denied', async () => {
		const wrapper = transcript()
		await flushPromises()
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
		sdk.noteSegmentsList.mockRejectedValue(new ApiError({status: 403, detail: 'Forbidden'}))
		await client.invalidateQueries({queryKey: noteKeys.segmentPage(3, -1), exact: true})
		await flushPromises()
		expect(wrapper.findAll('.note-transcript')).toHaveLength(0)
		expect(wrapper.text()).not.toContain('Final 1')
	})

	it('uses one functional native Modal primary action, validates empty source, and only opens an Arona draft', async () => {
		const wrapper = transcript(true)
		await flushPromises()
		await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
		await wrapper.findAll('.note-transcripts__selection .button')[1].trigger('click')
		await flushPromises()
		const element = document.querySelector<HTMLDialogElement>('dialog[open]')
		expect(element).not.toBeNull()
		const dialog = new DOMWrapper(element!)
		const primary = dialog.get('.actions .button.is-primary')
		expect(primary.text()).toBe('notes.arona.continue')
		expect(dialog.findAll('button').filter(button => button.text() === 'notes.arona.continue')).toHaveLength(1)
		await dialog.get('textarea').setValue('  ')
		await primary.trigger('click')
		await flushPromises()
		expect(navigation.push).not.toHaveBeenCalled()
		expect(dialog.get('[role="alert"]').text()).toBe('notes.arona.emptySource')
		expect(document.activeElement).toBe(dialog.get('textarea').element)
		await dialog.get('textarea').setValue('Keep this source')
		await primary.trigger('click')
		await flushPromises()
		expect(navigation.push).toHaveBeenCalledTimes(1)
		expect(navigation.push).toHaveBeenCalledWith({name: 'tcy-ai', query: {notesDraft: expect.any(String)}})
		const handoff = takeAronaDraftHandoff(navigation.push.mock.calls[0][0].query.notesDraft)
		expect(handoff).toContain('[notes.arona.sourceLink](/notes/3)')
		expect(handoff).toContain('Keep this source')
		expect(handoff).not.toContain('Final 2')
		expect(takeAronaDraftHandoff(navigation.push.mock.calls[0][0].query.notesDraft)).toBe('')
	})
})
