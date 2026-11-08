import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver} from '@tanstack/vue-query'
import {ApiError} from '@/client/problem'
import {captureClientRequestContext, isRequestContextAbort} from '@/client/requestContext'
import type {LiveNoteReceipt} from './liveNotes'
import type {Note, NoteSegmentPage, NoteSummary} from './notes'
import type {Paginated} from './pagination'

const sdk = vi.hoisted(() => ({
	notesCreate: vi.fn(),
	notesDelete: vi.fn(),
	notesList: vi.fn(),
	notesRead: vi.fn(),
	notesUpdate: vi.fn(),
	noteSegmentsList: vi.fn(),
}))
const session = vi.hoisted(() => ({epoch: 1}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => null,
	getTokenIdentity: () => ({id: 1, type: 1}),
	getAuthSessionEpoch: () => session.epoch,
	onTokenRefreshed: () => () => undefined,
}))

import {
	deleteNoteMutationOptions,
	normalizeNote,
	noteKeys,
	noteQuery,
	noteSegmentsQuery,
	notesQuery,
	receiveNoteTranscript,
	updateNoteMutationOptions,
} from './notes'

const updated = '2026-11-08T12:00:00Z'
function receipt(id: number, count = id): LiveNoteReceipt {
	return {
		segment: {id, note_id: 3, client_id: `segment-${id}`, text: `Final ${id}`, start_ms: id * 1000, end_ms: id * 1000 + 900},
		stats: {segment_count: count, transcript_bytes: count * 10, updated},
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

describe('personal notes query boundary', () => {
	let client: QueryClient
	beforeEach(() => {
		vi.clearAllMocks()
		session.epoch = 1
		client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})
	})

	it('keeps list metadata paginated without materializing article content', async () => {
		sdk.notesList.mockResolvedValue({data: {
			items: [{id: 3, title: 'Third', excerpt: 'Preview', content: 'Must not be retained in the row'}],
			total: 22,
			total_pages: 2,
			per_page: 20,
			page: 2,
		}})
		const page = await client.fetchQuery(notesQuery({q: 'Third', pinned: false}, 2))
		expect(sdk.notesList).toHaveBeenCalledWith({
			query: {q: 'Third', pinned: 'false', page: 2},
			signal: expect.any(AbortSignal),
		})
		expect(page.items[0]).not.toHaveProperty('content')
		expect(page.total_pages).toBe(2)
	})

	it('sends the user-opened revision and retains the cached version on conflict', async () => {
		const original = normalizeNote({id: 3, title: 'Before', content: 'Saved', revision: 2})
		client.setQueryData(noteKeys.detail(3), original)
		const conflict = new ApiError({status: 409, detail: 'note_revision_conflict'})
		sdk.notesUpdate.mockRejectedValue(conflict)
		const mutation = client.getMutationCache().build(client, updateNoteMutationOptions())
		await expect(mutation.execute({id: 3, title: 'Mine', content: 'New', pinned: true, expected_revision: 2}))
			.rejects.toBe(conflict)
		expect(sdk.notesUpdate).toHaveBeenCalledWith({
			path: {id: 3},
			body: {title: 'Mine', content: 'New', pinned: true, expected_revision: 2},
		})
		expect(client.getQueryData(noteKeys.detail(3))).toEqual(original)
	})

	it('turns a deleted open detail into null and drops its cached transcript', async () => {
		client.setQueryData(noteKeys.detail(3), normalizeNote({id: 3, title: 'Delete'}))
		client.setQueryData(noteKeys.segmentPage(3, 0), {items: [{id: 5, text: 'Original'}]})
		sdk.notesDelete.mockResolvedValue({data: undefined})
		await client.getMutationCache().build(client, deleteNoteMutationOptions()).execute(3)
		expect(client.getQueryData(noteKeys.detail(3))).toBeNull()
		expect(client.getQueryData(noteKeys.segmentPage(3, 0))).toBeUndefined()
	})

	it('does not write a response to a different authentication session', async () => {
		const original = normalizeNote({id: 3, title: 'Before', revision: 2})
		client.setQueryData(noteKeys.detail(3), original)
		sdk.notesUpdate.mockImplementation(async () => {
			session.epoch++
			return {data: {id: 3, title: 'Saved for old session', revision: 3}}
		})
		const mutation = client.getMutationCache().build(client, updateNoteMutationOptions())
		await expect(mutation.execute({id: 3, title: 'New', content: '', pinned: false, expected_revision: 2}))
			.rejects.toSatisfy(isRequestContextAbort)
		expect(client.getQueryData(noteKeys.detail(3))).toEqual(original)
	})

	it('requests a bounded forward transcript cursor, not all recorded history', async () => {
		sdk.noteSegmentsList.mockResolvedValue({data: {items: [{id: 8, text: 'Final'}], next_cursor: 8, total: 120, has_more: true}})
		const result = await client.fetchQuery(noteSegmentsQuery(3, 7))
		expect(sdk.noteSegmentsList).toHaveBeenCalledWith({
			path: {id: 3},
			query: {after_id: 7, per_page: 100},
			signal: expect.any(AbortSignal),
		})
		expect(result.items[0]).toMatchObject({id: 8, note_id: 3, text: 'Final'})
		expect(result.has_more).toBe(true)
	})

	it('updates active caches from committed absolute stats without issuing any reads or changing article fields', async () => {
		const note = normalizeNote({id: 3, title: 'Edited title', content: 'Private article', pinned: true, revision: 7})
		const list = {items: [note], total: 1, total_pages: 1, page: 1, per_page: 20}
		client.setQueryData(noteKeys.detail(3), note)
		client.setQueryData(noteKeys.list({}, 1), list)
		client.setQueryData(noteKeys.segmentPage(3, 0), {items: [], total: 0, has_more: false, next_cursor: 0})
		const detailOptions = noteQuery(3)
		const listOptions = notesQuery({}, 1)
		const segmentOptions = noteSegmentsQuery(3, 0)
		// Core observers accept static options; Vue's enabled/ref surface is deliberately not spread here.
		const observers = [
			new QueryObserver(client, {
				queryKey: noteKeys.detail(3), queryFn: detailOptions.queryFn,
				structuralSharing: detailOptions.structuralSharing, staleTime: Infinity,
			}),
			new QueryObserver(client, {
				queryKey: noteKeys.list({}, 1), queryFn: listOptions.queryFn,
				structuralSharing: listOptions.structuralSharing, staleTime: Infinity,
			}),
			new QueryObserver(client, {
				queryKey: noteKeys.segmentPage(3, 0), queryFn: segmentOptions.queryFn,
				structuralSharing: segmentOptions.structuralSharing, staleTime: Infinity,
			}),
		]
		const unsubscribes = observers.map(observer => observer.subscribe(() => undefined))
		vi.clearAllMocks()
		const owner = captureClientRequestContext()
		receiveNoteTranscript(client, 3, receipt(1), owner)
		receiveNoteTranscript(client, 3, receipt(1), owner)
		await Promise.resolve()
		expect(client.getQueryData(noteKeys.detail(3))).toEqual({...note, segment_count: 1, transcript_bytes: 10, updated})
		expect(client.getQueryData<Paginated<NoteSummary>>(noteKeys.list({}, 1))?.items[0]).toMatchObject({title: note.title, revision: 7, segment_count: 1})
		expect(client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, 0))?.items).toHaveLength(1)
		expect(sdk.notesRead).not.toHaveBeenCalled()
		expect(sdk.notesList).not.toHaveBeenCalled()
		expect(sdk.noteSegmentsList).not.toHaveBeenCalled()
		unsubscribes.forEach(unsubscribe => unsubscribe())
	})

	it('bounds long recordings to 100 rendered records and keeps historical pages stable', () => {
		const owner = captureClientRequestContext()
		client.setQueryData(noteKeys.segmentPage(3, 0), {items: [], total: 0, has_more: false, next_cursor: 0})
		for (let id = 1; id <= 1200; id++) receiveNoteTranscript(client, 3, receipt(id), owner)
		const page = client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, 0))!
		expect(page.items).toHaveLength(100)
		expect(page.items[99].id).toBe(100)
		expect(page.next_cursor).toBe(100)
		expect(page.total).toBe(1200)
		expect(page.has_more).toBe(true)
		receiveNoteTranscript(client, 3, receipt(50), owner)
		expect(client.getQueryData(noteKeys.segmentPage(3, 0))).toEqual(page)
		expect(client.getQueryData(noteKeys.detail(3))).toBeUndefined()
	})

	it('does not append across missed finals, or import another note or authentication session', () => {
		const owner = captureClientRequestContext()
		client.setQueryData(noteKeys.segmentPage(3, 0), {items: [], total: 0, has_more: false, next_cursor: 0})
		receiveNoteTranscript(client, 3, receipt(2), owner)
		receiveNoteTranscript(client, 3, receipt(1), owner)
		expect(client.getQueryData(noteKeys.segmentPage(3, 0))).toEqual({items: [], total: 2, has_more: true, next_cursor: 0, from_end: false, incomplete: false})
		receiveNoteTranscript(client, 4, receipt(3), owner)
		expect(client.getQueryData(noteKeys.detail(4))).toBeUndefined()
		session.epoch++
		receiveNoteTranscript(client, 3, receipt(4), owner)
		expect(client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, 0))?.total).toBe(2)
	})

	it('merges overlapping finals into a first GET and bounds even a slow first transcript read', async () => {
		const detail = deferred<{data: Partial<Note>}>()
		const segments = deferred<{data: NoteSegmentPage}>()
		sdk.notesRead.mockReturnValue(detail.promise)
		sdk.noteSegmentsList.mockReturnValue(segments.promise)
		const detailRead = client.fetchQuery(noteQuery(3))
		const segmentRead = client.fetchQuery(noteSegmentsQuery(3, 0))
		const owner = captureClientRequestContext()
		for (let id = 1; id <= 120; id++) receiveNoteTranscript(client, 3, receipt(id), owner)
		detail.resolve({data: {id: 3, title: 'First read', content: 'Must survive', revision: 1}})
		segments.resolve({data: {items: [], total: 0, has_more: false, next_cursor: 0, from_end: false}})
		await Promise.all([detailRead, segmentRead])
		expect(client.getQueryData(noteKeys.detail(3))).toMatchObject({title: 'First read', content: 'Must survive', segment_count: 120, transcript_bytes: 1200})
		const page = client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, 0))!
		expect(page.items.length).toBeLessThanOrEqual(100)
		expect(page.total).toBe(120)
		expect(page.has_more).toBe(true)
	})

	it('does not let an older HTTP detail/list/page replace newer confirmed metadata or editorial revision', async () => {
		const note = normalizeNote({id: 3, title: 'New article title', content: 'New article', revision: 8, segment_count: 1, transcript_bytes: 10, updated})
		client.setQueryData(noteKeys.detail(3), note)
		client.setQueryData(noteKeys.list({}, 1), {items: [note], total: 1, total_pages: 1, page: 1, per_page: 20})
		client.setQueryData(noteKeys.segmentPage(3, 0), {items: [receipt(1).segment], total: 1, has_more: false, next_cursor: 1})
		const detail = deferred<{data: Partial<Note>}>()
		const list = deferred<{data: {items: Partial<Note>[]}}>()
		const segments = deferred<{data: {items: LiveNoteReceipt['segment'][], total: number, next_cursor: number, has_more: boolean}}>()
		sdk.notesRead.mockReturnValue(detail.promise)
		sdk.notesList.mockReturnValue(list.promise)
		sdk.noteSegmentsList.mockReturnValue(segments.promise)
		const pending = [client.fetchQuery(noteQuery(3)), client.fetchQuery(notesQuery({}, 1)), client.fetchQuery(noteSegmentsQuery(3, 0))]
		receiveNoteTranscript(client, 3, receipt(2), captureClientRequestContext())
		detail.resolve({data: {id: 3, title: 'Old title', content: 'Old article', revision: 7}})
		list.resolve({data: {items: [{id: 3, title: 'Old title', revision: 7}]}})
		segments.resolve({data: {items: [receipt(1).segment], total: 1, next_cursor: 1, has_more: false}})
		await Promise.all(pending)
		expect(client.getQueryData(noteKeys.detail(3))).toMatchObject({title: 'New article title', content: 'New article', revision: 8, segment_count: 2})
		expect(client.getQueryData<Paginated<NoteSummary>>(noteKeys.list({}, 1))?.items[0]).toMatchObject({title: 'New article title', segment_count: 2})
		expect(client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, 0))?.items.map(item => item.id)).toEqual([1, 2])
	})

	it('rejects a first HTTP response after its original identity changes, even when the SDK resolves', async () => {
		const detail = deferred<{data: Partial<Note>}>()
		sdk.notesRead.mockReturnValue(detail.promise)
		const pending = client.fetchQuery(noteQuery(3))
		session.epoch++
		detail.resolve({data: {id: 3, title: 'Old owner'}})
		await expect(pending).rejects.toSatisfy(isRequestContextAbort)
		expect(client.getQueryData(noteKeys.detail(3))).toBeUndefined()
	})

	it('reads the latest tail directly rather than walking every earlier cursor', async () => {
		sdk.noteSegmentsList.mockResolvedValue({data: {items: [receipt(10000).segment], total: 10000, has_more: false, next_cursor: 10000, from_end: true}})
		const tail = await client.fetchQuery(noteSegmentsQuery(3, -1))
		expect(sdk.noteSegmentsList).toHaveBeenCalledWith({
			path: {id: 3}, query: {after_id: 0, latest: true, per_page: 100}, signal: expect.any(AbortSignal),
		})
		expect(tail).toMatchObject({from_end: true, total: 10000, next_cursor: 10000, has_more: false, incomplete: false})
	})

	it('follows the latest 100 segments throughout a 1200-final recording without downloading history', () => {
		const owner = captureClientRequestContext()
		client.setQueryData(noteKeys.segmentPage(3, -1), {items: [], total: 0, has_more: false, next_cursor: 0, from_end: true})
		for (let id = 1; id <= 1200; id++) receiveNoteTranscript(client, 3, receipt(id), owner)
		const tail = client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, -1))!
		expect(tail.items).toHaveLength(100)
		expect(tail.items[0].id).toBe(1101)
		expect(tail.items[99].id).toBe(1200)
		expect(tail).toMatchObject({total: 1200, next_cursor: 1200, from_end: true, has_more: false, incomplete: false})
		expect(sdk.noteSegmentsList).not.toHaveBeenCalled()
	})

	it('exposes missing finals and an explicit latest read fills the gap without reverting to the first 100 rows', async () => {
		const initial = Array.from({length: 100}, (_, index) => ({...receipt(index + 1).segment, timing_estimated: false}))
		client.setQueryData(noteKeys.segmentPage(3, -1), {items: initial, total: 100, has_more: false, next_cursor: 100, from_end: true})
		const owner = captureClientRequestContext()
		receiveNoteTranscript(client, 3, receipt(102), owner)
		receiveNoteTranscript(client, 3, receipt(103), owner)
		expect(client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, -1))).toMatchObject({total: 103, incomplete: true, from_end: true, has_more: false})
		expect(sdk.noteSegmentsList).not.toHaveBeenCalled()
		const filled = Array.from({length: 100}, (_, index) => receipt(index + 4).segment)
		sdk.noteSegmentsList.mockResolvedValue({data: {items: filled, total: 103, has_more: false, next_cursor: 103, from_end: true}})
		await client.fetchQuery(noteSegmentsQuery(3, -1))
		const tail = client.getQueryData<NoteSegmentPage>(noteKeys.segmentPage(3, -1))!
		expect(tail.incomplete).toBe(false)
		expect(tail.items.map(segment => segment.id)).toEqual(Array.from({length: 100}, (_, index) => index + 4))
	})
})
