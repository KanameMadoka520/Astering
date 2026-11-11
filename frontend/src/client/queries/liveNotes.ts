import {queryOptions} from '@tanstack/vue-query'
import {notesLiveConnections, type AsterNoteSegment} from '@/client/generated'
import {
	assertClientRequestContext,
	canonicalApiBaseUrl,
	type ClientRequestContext,
} from '@/client/requestContext'
import {getToken, isTokenExpired, refreshToken} from '@/helpers/auth'

export function liveNoteConnectionsQuery() {
	return queryOptions({
		queryKey: ['notes', 'live-connections'],
		queryFn: async ({signal}) => (await notesLiveConnections({signal})).data,
		staleTime: 30_000,
		meta: {handlesError: true},
	})
}

export type LiveNoteTranscriptState = {
	segment_count: number,
	transcript_bytes: number,
	updated: string,
	article_revision?: number,
}

export type LiveNoteReceipt = {segment: AsterNoteSegment, stats: LiveNoteTranscriptState}

export type LiveNoteServerDiagnostics = {
	elapsed_ms: number,
	received_bytes: number,
	audio_duration_ms: number,
	last_audio_ms: number,
	partial_updates: number,
	saved_segments: number,
	first_text_ms: number,
	last_text_ms: number,
}

export type LiveNoteTrace = {
	request_id?: string,
	provider_code?: string,
	provider_request_id?: string,
	provider_task_id?: string,
	diagnostics?: LiveNoteServerDiagnostics,
}

export type LiveNoteEvent =
	| ({type: 'ready', sample_rate: number, offset_ms: number, rotate_seconds: number, model: string, endpoint: string} & LiveNoteTrace)
	| {type: 'partial', id: string, text: string}
	| ({type: 'segment', id: string} & LiveNoteReceipt)
	| ({type: 'done'} & LiveNoteTrace)
	| ({type: 'error', code: string, message?: string, text?: string} & LiveNoteTrace)

// Browser WebSockets cannot set an Authorization header; authenticate in the first frame, never in a URL.
export async function openLiveNoteSocket(options: {
	context: ClientRequestContext,
	noteID: number,
	connectionID: string,
	offsetMS: number,
	language: string,
	recordingID?: string,
	recordingStartedAt?: string,
	recordingOffsetMS?: number,
	timezone?: string,
	appendToArticle?: boolean,
	isCurrent: () => boolean,
	onEvent: (event: LiveNoteEvent) => void,
	onClose: () => void,
}) {
	assertClientRequestContext(options.context)
	if (isTokenExpired(getToken(), 9 * 60)) await refreshToken(true)
	assertClientRequestContext(options.context)
	if (!options.isCurrent()) throw new DOMException('Recording cancelled', 'AbortError')
	const url = new URL(`${canonicalApiBaseUrl(options.context.apiBaseUrl)}/notes/live`)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	const socket = new WebSocket(url)
	socket.onopen = () => {
		try {
			assertClientRequestContext(options.context)
			if (!options.isCurrent()) return socket.close()
			socket.send(JSON.stringify({
				action: 'start',
				token: getToken(),
				note_id: options.noteID,
				connection_id: options.connectionID,
				offset_ms: options.offsetMS,
				language: options.language,
				recording_id: options.recordingID,
				recording_started_at: options.recordingStartedAt,
				recording_offset_ms: options.recordingOffsetMS,
				timezone: options.timezone,
				append_to_article: options.appendToArticle,
			}))
		} catch {
			socket.close()
		}
	}
	socket.onmessage = message => {
		if (!options.isCurrent()) {
			socket.close()
			return
		}
		try {
			const event = JSON.parse(message.data) as LiveNoteEvent
			if (!event || typeof event.type !== 'string') throw new Error('Invalid live event')
			options.onEvent(event)
		} catch {
			options.onEvent({type: 'error', code: 'protocol'})
		}
	}
	socket.onclose = options.onClose
	socket.onerror = () => {
		if (options.isCurrent()) options.onEvent({type: 'error', code: 'network'})
		else socket.close()
	}
	return socket
}
