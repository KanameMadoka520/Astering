import {
	queryOptions,
	hashKey,
	replaceEqualDeep,
	useMutation,
	type MutationOptions,
	type QueryClient,
	type QueryFunctionContext,
	type QueryKey,
} from '@tanstack/vue-query'
import {
	notesCreate,
	notesDelete,
	notesList,
	notesRead,
	notesUpdate,
	noteSegmentsList,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {removeFromPages, toPaginated, type Paginated} from './pagination'
import {storageKeys} from './storage'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'
import type {LiveNoteReceipt, LiveNoteTranscriptState} from './liveNotes'

export type Note = {
	id: number
	title: string
	content: string
	pinned: boolean
	revision: number
	content_bytes: number
	transcript_bytes: number
	segment_count: number
	excerpt: string
	created?: string
	updated?: string
}

export type NoteSummary = Omit<Note, 'content'>
export type NoteText = Pick<Note, 'title' | 'content' | 'pinned'>
export type UpdateNoteInput = NoteText & {
	id: number
	expected_revision: number
}
type NoteMutationContext = {
	request: ClientRequestContext
	previous: [QueryKey, unknown][]
	optimistic: undefined
}
export type NoteSegment = {
	id: number
	note_id: number
	client_id: string
	text: string
	start_ms: number
	end_ms: number
	timing_estimated: boolean
	recording_id?: string
	recording_started_at?: string | null
	recording_offset_ms?: number
	captured_at?: string | null
	timezone?: string
	append_to_article?: boolean
	article_appended?: boolean
	created?: string
}
export type NoteSegmentPage = {
	items: NoteSegment[]
	total: number
	has_more: boolean
	next_cursor: number
	from_end: boolean
	/** A live counter advanced past an unseen final. Reload latest explicitly to fill the gap. */
	incomplete?: boolean
}
export type NoteFilters = {q?: string, pinned?: boolean}

export const noteKeys = {
	all: ['notes'] as const,
	lists: ['notes', 'list'] as const,
	list: (filters: NoteFilters, page: number) => ['notes', 'list', filters, page] as const,
	detail: (id: number) => ['notes', 'detail', id] as const,
	segments: (id: number) => ['notes', 'segments', id] as const,
	segmentPage: (id: number, afterId: number) => ['notes', 'segments', id, afterId] as const,
}

export function normalizeNote(raw: Partial<Note> | undefined): Note {
	return {
		id: raw?.id ?? 0,
		title: raw?.title ?? '',
		content: raw?.content ?? '',
		pinned: raw?.pinned ?? false,
		revision: raw?.revision ?? 0,
		content_bytes: raw?.content_bytes ?? 0,
		transcript_bytes: raw?.transcript_bytes ?? 0,
		segment_count: raw?.segment_count ?? 0,
		excerpt: raw?.excerpt ?? '',
		created: raw?.created,
		updated: raw?.updated,
	}
}

function normalizeSummary(raw: Partial<Note>): NoteSummary {
	const {content: _content, ...summary} = normalizeNote(raw)
	return summary
}

function normalizeSegment(raw: LiveNoteReceipt['segment'], noteId: number): NoteSegment {
	return {
		id: raw.id ?? 0,
		note_id: raw.note_id ?? noteId,
		client_id: raw.client_id ?? '',
		text: raw.text ?? '',
		start_ms: raw.start_ms ?? 0,
		end_ms: raw.end_ms ?? 0,
		timing_estimated: raw.timing_estimated ?? false,
		recording_id: raw.recording_id,
		recording_started_at: raw.recording_started_at,
		recording_offset_ms: raw.recording_offset_ms,
		captured_at: raw.captured_at,
		timezone: raw.timezone,
		append_to_article: raw.append_to_article,
		article_appended: raw.article_appended,
		created: raw.created,
	}
}

function transcriptMetadata<T extends Pick<Note, 'segment_count' | 'transcript_bytes' | 'updated'>>(
	current: T,
	stats: LiveNoteTranscriptState,
): T {
	if (stats.segment_count < current.segment_count || stats.transcript_bytes < current.transcript_bytes) return current
	return {
		...current,
		segment_count: stats.segment_count,
		transcript_bytes: stats.transcript_bytes,
		updated: Date.parse(stats.updated) > Date.parse(current.updated ?? '') || !current.updated ? stats.updated : current.updated,
	}
}

function segmentReceipt(page: NoteSegmentPage, afterId: number, receipt: LiveNoteReceipt): NoteSegmentPage {
	const count = receipt.stats.segment_count
	if (count < page.total) return page
	const segment = normalizeSegment(receipt.segment, receipt.segment.note_id ?? 0)
	const last = page.items.at(-1)?.id ?? afterId
	const duplicate = page.items.some(item => item.id === segment.id || item.client_id === segment.client_id)
	const latest = afterId < 0 || Boolean(page.from_end)
	const append = !duplicate && !page.incomplete && !page.has_more && (latest || page.items.length < 100) && segment.id > last
		&& count === page.total + 1
	return {
		...page,
		items: append ? [...page.items, segment].slice(latest ? -100 : 0) : page.items,
		total: count,
		next_cursor: append ? segment.id : page.next_cursor,
		has_more: latest ? false : page.has_more || (!append && count > page.total),
		from_end: latest,
		incomplete: latest ? !!page.incomplete || (!append && count > page.total) : false,
	}
}

type NoteReadKind = {type: 'detail', id: number} | {type: 'list'} | {type: 'segments', id: number, afterId: number}
type NoteSnapshot = Note | Paginated<NoteSummary> | NoteSegmentPage
type NoteRead = {
	key: QueryKey
	kind: NoteReadKind
	owner: ClientRequestContext
	receipts: Map<number, LiveNoteReceipt[]>
	closed: boolean
	close: () => void
	markStale: () => void
}
type ReadClient = QueryFunctionContext['client']
const reads = new WeakMap<ReadClient, Set<NoteRead>>()
const responses = new WeakMap<object, NoteRead>()

/** Retain only receipts overlapping this GET; never keep another recording/history store. */
async function readNoteSnapshot<T extends NoteSnapshot>(
	client: ReadClient, key: QueryKey, kind: NoteReadKind, signal: AbortSignal, read: () => Promise<T>,
): Promise<T> {
	const pending = reads.get(client) ?? new Set<NoteRead>()
	reads.set(client, pending)
	const request: NoteRead = {
		key, kind, owner: captureClientRequestContext(), receipts: new Map(), closed: false, close: () => undefined,
		markStale: () => {
			if (isClientRequestContextCurrent(request.owner)) void client.invalidateQueries({queryKey: key, exact: true, refetchType: 'none'})
		},
	}
	const unsubscribe = client.getQueryCache().subscribe(event => {
		if (event.type === 'removed' && event.query.queryHash === hashKey(key)) request.close()
	})
	request.close = () => {
		request.closed = true
		pending.delete(request)
		request.receipts.clear()
		signal.removeEventListener('abort', request.close)
		unsubscribe()
	}
	pending.add(request)
	signal.addEventListener('abort', request.close, {once: true})
	try {
		const result = await read()
		assertClientRequestContext(request.owner)
		if (request.closed || signal.aborted) throw new DOMException('Note request was superseded', 'AbortError')
		responses.set(result, request)
		return result
	} catch (cause) {
		request.close()
		throw cause
	}
}

function shareNoteSnapshot(previous: unknown, incoming: unknown): unknown {
	if (!incoming || typeof incoming !== 'object') return replaceEqualDeep(previous, incoming)
	const request = responses.get(incoming)
	let next = incoming as NoteSnapshot
	try {
		if (request) {
			assertClientRequestContext(request.owner)
			if (request.closed) throw new DOMException('Note request was superseded', 'AbortError')
		}
		if ('revision' in next) {
			const current = previous as Note | null | undefined
			if (current === null) return null
			if (current?.id === next.id) {
				next = transcriptMetadata(current.revision > next.revision ? current : next, {
					segment_count: Math.max(current.segment_count, next.segment_count),
					transcript_bytes: Math.max(current.transcript_bytes, next.transcript_bytes),
					updated: Date.parse(current.updated ?? '') > Date.parse(next.updated ?? '') ? current.updated! : next.updated ?? '',
				})
			}
		} else if ('page' in next) {
			const current = previous as Paginated<NoteSummary> | undefined
			next = {...next, items: next.items.map(item => {
				const existing = current?.items.find(row => row.id === item.id)
				return existing ? transcriptMetadata(existing.revision > item.revision ? existing : item, {
					segment_count: Math.max(existing.segment_count, item.segment_count),
					transcript_bytes: Math.max(existing.transcript_bytes, item.transcript_bytes),
					updated: Date.parse(existing.updated ?? '') > Date.parse(item.updated ?? '') ? existing.updated! : item.updated ?? '',
				}) : item
			})}
		} else if (request && previous && typeof previous === 'object' && 'next_cursor' in previous) {
			const current = previous as NoteSegmentPage
			const latest = request.kind.type === 'segments' && request.kind.afterId < 0
			const items = [...new Map([...current.items, ...next.items].map(item => [item.id, item as NoteSegment])).values()]
				.sort((a, b) => a.id - b.id)
			const bounded = latest ? items.slice(-100) : items.slice(0, 100)
			next = {
				...(current.total > next.total ? current : next), items: bounded,
				next_cursor: bounded.at(-1)?.id ?? next.next_cursor,
				from_end: latest,
				has_more: latest ? false : (current.total > next.total ? current : next).has_more,
			}
		}
		for (const receipts of request?.receipts.values() ?? []) {
			for (const receipt of receipts) {
				if ('revision' in next && next.id === receipt.segment.note_id) next = transcriptMetadata(next, receipt.stats)
				else if ('page' in next) next = {...next, items: next.items.map(item => item.id === receipt.segment.note_id ? transcriptMetadata(item, receipt.stats) : item)}
				else if ('next_cursor' in next && request?.kind.type === 'segments') next = segmentReceipt(next, request.kind.afterId, receipt)
			}
		}
		return replaceEqualDeep(previous, next)
	} finally {
		// Its order may have been sampled before the final; keep the list stale after Query's successful commit.
		if (request?.kind.type === 'list' && request.receipts.size && !request.closed) queueMicrotask(request.markStale)
		responses.delete(incoming)
		request?.close()
	}
}

export function notesQuery(filters: NoteFilters, page: number) {
	const key = noteKeys.list(filters, page)
	return queryOptions({
		queryKey: key,
		queryFn: ({client, signal}) => readNoteSnapshot(client, key, {type: 'list'}, signal, async (): Promise<Paginated<NoteSummary>> => {
			const {data} = await notesList({
				query: {
					...filters,
					pinned: filters.pinned === undefined ? undefined : filters.pinned ? 'true' : 'false',
					page,
				},
				signal,
			})
			const result = toPaginated<Partial<Note>>(data, page)
			return {...result, items: result.items.map(normalizeSummary)}
		}),
		structuralSharing: shareNoteSnapshot,
		meta: {handlesError: true},
	})
}

export function noteQuery(id: number) {
	const key = noteKeys.detail(id)
	return queryOptions({
		queryKey: key,
		queryFn: ({client, signal}) => readNoteSnapshot(client, key, {type: 'detail', id}, signal,
			async () => normalizeNote((await notesRead({path: {id}, signal})).data)),
		structuralSharing: shareNoteSnapshot,
		meta: {handlesError: true},
	})
}

export function noteSegmentsQuery(id: number, afterId: number) {
	const key = noteKeys.segmentPage(id, afterId)
	return queryOptions({
		queryKey: key,
		queryFn: ({client, signal}) => readNoteSnapshot(client, key, {type: 'segments', id, afterId}, signal, async (): Promise<NoteSegmentPage> => {
			const {data} = await noteSegmentsList({
				path: {id},
				query: {after_id: Math.max(0, afterId), per_page: 100, ...(afterId < 0 ? {latest: true} : {})},
				signal,
			})
			return {
				items: (data.items ?? []).map(segment => normalizeSegment(segment, id)),
				total: data.total ?? 0,
				has_more: data.has_more ?? false,
				next_cursor: data.next_cursor ?? 0,
				from_end: data.from_end ?? afterId < 0,
				incomplete: false,
			}
		}),
		structuralSharing: shareNoteSnapshot,
		meta: {handlesError: true},
	})
}

function invalidateNoteLists(client: QueryClient) {
	void client.invalidateQueries({queryKey: noteKeys.lists})
	void client.invalidateQueries({
		queryKey: storageKeys.summary(captureClientRequestContext()),
		exact: true,
		refetchType: 'none',
	})
}

export function createNoteMutationOptions(): MutationOptions<Note, Error, NoteText, NoteMutationContext> {
	return {
		...contextMutationOptions({
			mutationFn: async (input: NoteText) => normalizeNote((await notesCreate({body: input})).data),
			toastError: () => false,
			onSettled: async (_input, client) => { invalidateNoteLists(client) },
		}),
		networkMode: 'always' as const,
	}
}

export function updateNoteMutationOptions(): MutationOptions<Note, Error, UpdateNoteInput, NoteMutationContext> {
	return {
		...contextMutationOptions({
			mutationFn: async (input: UpdateNoteInput) => {
				const {id, ...body} = input
				return normalizeNote((await notesUpdate({path: {id}, body})).data)
			},
			toastError: () => false,
			onSuccess: (data, input, client) => {
				client.setQueryData<Note>(noteKeys.detail(input.id), current => current ? data : current)
			},
			onSettled: async (input, client) => {
				invalidateNoteLists(client)
				void client.invalidateQueries({queryKey: noteKeys.detail(input.id), exact: true})
			},
		}),
		networkMode: 'always' as const,
	}
}

export function deleteNoteMutationOptions(): MutationOptions<void, Error, number, NoteMutationContext> {
	return {
		...contextMutationOptions({
			mutationFn: async (id: number) => { await notesDelete({path: {id}}) },
			toastError: () => false,
			onSuccess: (_data, id, client) => {
				markNoteDeleted(client, id)
			},
			onSettled: async (_id, client) => { invalidateNoteLists(client) },
		}),
		networkMode: 'always' as const,
	}
}

/** A tombstone prevents an older in-flight read from reviving a deleted article. */
export function markNoteDeleted(client: QueryClient, id: number) {
	client.setQueryData<Note | null>(noteKeys.detail(id), current => current ? null : current)
	removeFromPages<NoteSummary>(client, noteKeys.lists, item => item.id === id)
	client.removeQueries({queryKey: noteKeys.segments(id)})
}

export function useCreateNote() { return useMutation(createNoteMutationOptions()) }
export function useUpdateNote() { return useMutation(updateNoteMutationOptions()) }
export function useDeleteNote() { return useMutation(deleteNoteMutationOptions()) }

/** Update only committed transcript metadata; a final never downloads or rebuilds the article. */
export function receiveNoteTranscript(client: QueryClient, id: number, receipt: LiveNoteReceipt, owner: ClientRequestContext) {
	const {stats, segment} = receipt
	if (!stats || !segment || !isClientRequestContextCurrent(owner) || segment.note_id !== id || typeof segment.id !== 'number' || !Number.isSafeInteger(segment.id) || segment.id <= 0
		|| !Number.isSafeInteger(stats.segment_count) || stats.segment_count < 1
		|| !Number.isSafeInteger(stats.transcript_bytes) || stats.transcript_bytes < 0 || !Number.isFinite(Date.parse(stats.updated))) return
	for (const request of reads.get(client) ?? []) {
		if (request.closed || !isClientRequestContextCurrent(request.owner) || (request.kind.type !== 'list' && request.kind.id !== id)) continue
		const receipts = request.receipts.get(id) ?? []
		const latest = receipts.at(-1)
		if (latest && latest.stats.segment_count >= stats.segment_count) continue
		if (request.kind.type !== 'segments') request.receipts.set(id, [receipt])
		else if (receipts.length < 100) request.receipts.set(id, [...receipts, receipt])
		else request.receipts.set(id, request.kind.afterId < 0 ? [...receipts.slice(-99), receipt] : [...receipts.slice(0, 99), receipt])
	}
	client.setQueryData<Note | null>(noteKeys.detail(id), current => current ? transcriptMetadata(current, stats) : current)
	// An auto-append changes actual article text. Never attach its new revision to
	// the old cached text: the editor's draft fence compares the fetched article.
	const article = client.getQueryData<Note | null>(noteKeys.detail(id))
	if (stats.article_revision && article && stats.article_revision > article.revision) {
		void client.invalidateQueries({queryKey: noteKeys.detail(id), exact: true})
	}
	if (!client.getQueryData(noteKeys.detail(id))) void client.invalidateQueries({queryKey: noteKeys.detail(id), exact: true, refetchType: 'none'})
	client.setQueriesData<Paginated<NoteSummary>>({queryKey: noteKeys.lists}, current => current ? {
		...current,
		items: current.items.map(item => item.id === id ? transcriptMetadata(item, stats) : item),
	} : current)
	for (const [key] of client.getQueriesData<NoteSegmentPage>({queryKey: noteKeys.segments(id)})) {
		const afterId = Number(key[3])
		client.setQueryData<NoteSegmentPage>(key, current => current ? segmentReceipt(current, afterId, receipt) : current)
	}
	// Ordering and uncached pages can be refreshed explicitly; do not schedule background scans for each sentence.
	void client.invalidateQueries({queryKey: noteKeys.lists, refetchType: 'none'})
	void client.invalidateQueries({queryKey: noteKeys.segments(id), refetchType: 'none'})
	void client.invalidateQueries({queryKey: storageKeys.summary(owner), exact: true, refetchType: 'none'})
}
