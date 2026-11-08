import {hashKey, type QueryClient, type QueryKey} from '@tanstack/vue-query'
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {markNoteDeleted, noteKeys, type Note} from './notes'
import {storageKeys} from './storage'

export type NoteReceiptChange = {id: number, revision: number, deleted: boolean}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function count(value: unknown) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Metadata is a receipt, never a complete article or an instruction to replace a draft. */
export function parseNoteReceipt(tool: string, args: Record<string, unknown>, result: unknown): NoteReceiptChange | undefined {
	if (!record(result) || result.success !== true || !positive(result.note_id)) return
	const id = result.note_id
	if (tool === 'delete_note') {
		if (args.id === id && positive(args.expected_revision) && result.revision === args.expected_revision && result.deleted === true) {
			return {id, revision: result.revision, deleted: true}
		}
		return
	}
	if (tool !== 'create_note' && tool !== 'update_note') return
	const note = result.note
	if (!record(note) || note.id !== id || !positive(note.revision)
		|| typeof note.title !== 'string' || !note.title.trim() || typeof note.pinned !== 'boolean'
		|| !count(note.content_bytes) || !count(note.transcript_bytes) || !count(note.segment_count)
		|| typeof note.excerpt !== 'string') return
	if (tool === 'update_note' && (args.id !== id || !positive(args.expected_revision) || note.revision < args.expected_revision)) return
	return {id, revision: note.revision, deleted: false}
}

export async function refreshNoteReceipts(client: QueryClient, changes: readonly NoteReceiptChange[]) {
	if (!changes.length) return
	const owner = captureClientRequestContext()
	const last = new Map<number, NoteReceiptChange>()
	for (const change of changes) {
		const current = client.getQueryData<Note | null>(noteKeys.detail(change.id))
		const previous = last.get(change.id)
		if ((current && current.revision > change.revision) || (previous && previous.revision > change.revision)) continue
		last.set(change.id, change)
	}
	if (!last.size) return
	const keys = new Map<string, QueryKey>()
	const add = (key: QueryKey) => keys.set(hashKey(key), key)
	add(noteKeys.lists)
	for (const change of last.values()) {
		add(noteKeys.detail(change.id))
		if (change.deleted) add(noteKeys.segments(change.id))
	}
	await Promise.all([...keys.values()].map(queryKey => client.cancelQueries({queryKey})))
	assertClientRequestContext(owner)
	for (const change of last.values()) {
		if (change.deleted) markNoteDeleted(client, change.id)
	}
	// Full detail reads reconcile CAS revisions in the editor; raw transcripts are unchanged by article writes.
	await Promise.all([
		client.invalidateQueries({queryKey: noteKeys.lists}),
		...Array.from(last.values()).filter(change => !change.deleted)
			.map(change => client.invalidateQueries({queryKey: noteKeys.detail(change.id), exact: true})),
		client.invalidateQueries({queryKey: storageKeys.summary(owner), exact: true, refetchType: 'none'}),
	])
	assertClientRequestContext(owner)
}
