import {
	assertClientRequestContext,
	canonicalApiBaseUrl,
	type ClientRequestContext,
} from '@/client/requestContext'
import {getToken, isTokenExpired, refreshToken} from '@/helpers/auth'

export type LiveSpeechStats = {
	elapsed_ms: number,
	first_text_ms: number,
	audio_duration_ms: number,
	finish_ms: number,
	request_id: string,
	model: string,
	endpoint: string,
}

export type LiveSpeechEvent =
	| {
		type: 'ready',
		sample_rate: number,
		model: string,
		endpoint: string,
		max_seconds: number,
		request_id: string,
	}
	| {type: 'transcript', id: string, text: string, final: boolean}
	| ({type: 'done', text: string} & Omit<LiveSpeechStats, 'model' | 'endpoint'>)
	| {type: 'error', code: string, message?: string}

const MAX_EVENT_BYTES = 256 * 1024

/** Credentials belong in the first authenticated frame, never in the WebSocket URL. */
export async function openLiveSpeechSocket(options: {
	context: ClientRequestContext,
	connectionID: string,
	isCurrent: () => boolean,
	onEvent: (event: LiveSpeechEvent) => void,
	onClose: () => void,
}): Promise<WebSocket> {
	assertClientRequestContext(options.context)
	if (isTokenExpired(getToken(), 4 * 60)) await refreshToken(true)
	assertClientRequestContext(options.context)
	if (!options.isCurrent()) throw new DOMException('Recording cancelled', 'AbortError')
	const url = new URL(`${canonicalApiBaseUrl(options.context.apiBaseUrl)}/ai/speech/live`)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	const socket = new WebSocket(url)
	socket.onopen = () => {
		try {
			assertClientRequestContext(options.context)
			if (!options.isCurrent()) return socket.close()
			socket.send(JSON.stringify({
				action: 'start',
				token: getToken(),
				connection_id: options.connectionID,
			}))
		} catch {
			socket.close()
		}
	}
	socket.onmessage = message => {
		try {
			assertClientRequestContext(options.context)
			if (!options.isCurrent()) return socket.close()
		} catch {
			socket.close()
			return
		}
		let event: LiveSpeechEvent
		try {
			if (typeof message.data !== 'string' || new TextEncoder().encode(message.data).byteLength > MAX_EVENT_BYTES) {
				throw new Error('Invalid speech frame')
			}
			event = JSON.parse(message.data) as LiveSpeechEvent
			if (!event || !['ready', 'transcript', 'done', 'error'].includes(event.type)) {
				throw new Error('Invalid speech event')
			}
		} catch {
			options.onEvent({type: 'error', code: 'protocol'})
			return
		}
		options.onEvent(event)
	}
	socket.onclose = options.onClose
	socket.onerror = () => {
		try {
			assertClientRequestContext(options.context)
			if (options.isCurrent()) return options.onEvent({type: 'error', code: 'network'})
		} catch { /* An old identity cannot receive recording callbacks. */ }
		socket.close()
	}
	return socket
}
