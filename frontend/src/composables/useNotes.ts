import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {ApiError} from '@/client/problem'
import {
	noteQuery,
	notesQuery,
	noteSegmentsQuery,
	receiveNoteTranscript,
	type NoteFilters,
} from '@/client/queries/notes'
import {captureClientRequestContext} from '@/client/requestContext'
import type {LiveNoteReceipt} from '@/client/queries/liveNotes'

export function notesAccessDenied(cause: unknown): boolean {
	return cause instanceof ApiError && [401, 403, 404].includes(cause.status)
}

export function useNotes(filters: MaybeRefOrGetter<NoteFilters>, page: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => notesQuery(toValue(filters), toValue(page))))
	return {
		...query,
		notes: computed(() => notesAccessDenied(query.error.value) ? [] : query.data.value?.items ?? []),
	}
}

export function useNote(id: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({...noteQuery(toValue(id)), enabled: toValue(id) > 0})))
	return {
		...query,
		note: computed(() => notesAccessDenied(query.error.value) ? undefined : query.data.value),
	}
}

export function useNoteSegments(id: MaybeRefOrGetter<number>, afterId: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...noteSegmentsQuery(toValue(id), toValue(afterId)),
		enabled: toValue(id) > 0,
	})))
	return {
		...query,
		segments: computed(() => notesAccessDenied(query.error.value) ? [] : query.data.value?.items ?? []),
	}
}

export function useReceiveNoteTranscript() {
	const client = useQueryClient()
	const owner = captureClientRequestContext()
	return (id: number, receipt: LiveNoteReceipt) => receiveNoteTranscript(client, id, receipt, owner)
}
