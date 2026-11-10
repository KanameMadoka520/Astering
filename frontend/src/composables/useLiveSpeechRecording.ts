import {computed, onScopeDispose, ref, shallowRef} from 'vue'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'
import {
	openLiveSpeechSocket,
	type LiveSpeechEvent,
	type LiveSpeechStats,
} from '@/client/queries/liveSpeech'
import pcmWorkletURL from '@/worklets/livePcmCapture.js?url'

export type {LiveSpeechStats} from '@/client/queries/liveSpeech'
export type LiveSpeechStage = 'idle' | 'permission' | 'connecting' | 'recording' | 'flushing' | 'draining' | 'finishing'

const SAMPLE_RATE = 16000
const MAX_SECONDS = 180
const MAX_BYTES = 16 * 1024 * 1024
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 6
const MAX_TEXT_BYTES = 64 * 1024

export function supportsLiveSpeechRecording(protocol: string | undefined): boolean {
	return ['dashscope-asr', 'qwen-asr-realtime'].includes(protocol ?? '') &&
		typeof window !== 'undefined' && window.isSecureContext === true &&
		typeof window.AudioContext === 'function' && typeof window.AudioWorkletNode === 'function' &&
		typeof window.WebSocket === 'function' && Boolean(navigator.mediaDevices?.getUserMedia)
}

type Session<Owner> = {
	owner: Owner,
	request: ClientRequestContext,
	connectionID: string,
	current: () => boolean,
	context: AudioContext,
	stream?: MediaStream,
	node?: AudioWorkletNode,
	source?: MediaStreamAudioSourceNode,
	silent?: GainNode,
	socket?: WebSocket,
	queue: ArrayBuffer[],
	queueBytes: number,
	capturedBytes: number,
	nextSendAt: number,
	startedAt: number,
	ready: boolean,
	ending: boolean,
	stopSent: boolean,
	closed: boolean,
	captureClosed: boolean,
	segments: Map<string, {text: string, final: boolean}>,
	completion: Promise<void>,
	complete: () => void,
	flushed?: () => void,
	timer?: ReturnType<typeof setInterval>,
	pumpTimer?: ReturnType<typeof setTimeout>,
	readyDeadline?: ReturnType<typeof setTimeout>,
	flushDeadline?: ReturnType<typeof setTimeout>,
	finishDeadline?: ReturnType<typeof setTimeout>,
	requestID: string,
	model: string,
	endpoint: string,
}

function captureError(cause: unknown): string {
	const name = cause instanceof Error ? cause.name : ''
	if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name)) return 'permission'
	if (['NotFoundError', 'DevicesNotFoundError'].includes(name)) return 'no-device'
	if (['NotReadableError', 'TrackStartError', 'OverconstrainedError'].includes(name)) return 'device'
	if (name === 'NotSupportedError') return 'unsupported'
	return 'interrupted'
}

/** One short dictation owns one bounded PCM stream; disconnects never replay unknown audio. */
export function useLiveSpeechRecording<Owner>(options: {
	capture: () => Owner,
	isCurrent: (owner: Owner) => boolean,
	connectionID: (owner: Owner) => string,
	onComplete: (text: string, stats: LiveSpeechStats, owner: Owner) => void,
	onError: (kind: string, message?: string, owner?: Owner) => void,
	onTranscript?: (text: string, owner: Owner) => void,
}) {
	const recording = ref(false)
	const requesting = ref(false)
	const stopping = ref(false)
	const elapsed = ref(0)
	const stage = ref<LiveSpeechStage>('idle')
	const liveText = ref('')
	const partial = ref('')
	const stats = shallowRef<LiveSpeechStats>()
	const model = ref('')
	const endpoint = ref('')
	const bufferedSeconds = ref(0)
	const active = computed(() => recording.value || requesting.value || stopping.value)
	let generation = 0
	let disposed = false
	let session: Session<Owner> | undefined

	function closeCapture(s: Session<Owner>) {
		if (s.captureClosed) return
		s.captureClosed = true
		s.context.onstatechange = null
		for (const track of s.stream?.getTracks() ?? []) {
			track.onended = null
			track.onmute = null
			track.stop()
		}
		s.node?.disconnect()
		s.source?.disconnect()
		s.silent?.disconnect()
		void s.context.close().catch(() => {})
	}

	function cleanup(s: Session<Owner>) {
		if (s.closed) return
		s.closed = true
		clearInterval(s.timer)
		clearTimeout(s.pumpTimer)
		clearTimeout(s.readyDeadline)
		clearTimeout(s.flushDeadline)
		clearTimeout(s.finishDeadline)
		s.flushed?.()
		s.flushed = undefined
		closeCapture(s)
		s.socket?.close()
		s.queue.length = 0
		s.queueBytes = 0
		s.segments.clear()
		s.complete()
		if (session === s) {
			if (!s.current()) {
				liveText.value = ''
				partial.value = ''
				stats.value = undefined
				model.value = ''
				endpoint.value = ''
			}
			session = undefined
			recording.value = false
			requesting.value = false
			stopping.value = false
			stage.value = 'idle'
			bufferedSeconds.value = 0
		}
	}

	function fail(s: Session<Owner>, code: string, message = '') {
		const report = s.current() && !s.closed
		cleanup(s)
		// liveText includes unconfirmed partials; only done can call onComplete.
		if (report) options.onError(code, message, s.owner)
	}

	function pump(s: Session<Owner>) {
		clearTimeout(s.pumpTimer)
		s.pumpTimer = undefined
		if (!s.current() || s.closed) return cleanup(s)
		if (!s.ready || s.stopSent || s.socket?.readyState !== WebSocket.OPEN) return
		if (s.queueBytes + s.socket.bufferedAmount > MAX_QUEUE_BYTES) return fail(s, 'buffer_full')
		if (s.queue.length) {
			const wait = Math.max(0, s.nextSendAt - performance.now())
			if (wait > 0 || s.socket.bufferedAmount > SAMPLE_RATE * 2 * 2) {
				s.pumpTimer = setTimeout(() => pump(s), Math.max(wait, 50))
				return
			}
			const frame = s.queue.shift()!
			s.queueBytes -= frame.byteLength
			try {
				s.socket.send(frame)
			} catch {
				return fail(s, 'network')
			}
			s.nextSendAt = performance.now() + frame.byteLength / (SAMPLE_RATE * 2) * 500
			bufferedSeconds.value = (s.queueBytes + s.socket.bufferedAmount) / (SAMPLE_RATE * 2)
			if (s.queue.length) {
				s.pumpTimer = setTimeout(() => pump(s), Math.max(1, s.nextSendAt - performance.now()))
				return
			}
		}
		if (!s.ending || !s.captureClosed || s.queue.length) return
		if (!s.capturedBytes) return fail(s, 'empty')
		try {
			s.stopSent = true
			stage.value = 'finishing'
			s.socket.send(JSON.stringify({action: 'stop'}))
		} catch {
			fail(s, 'network')
		}
	}

	function receive(s: Session<Owner>, event: LiveSpeechEvent) {
		if (!s.current() || s.closed) return cleanup(s)
		if (event.type === 'error') {
			return fail(s, typeof event.code === 'string' && event.code.length <= 100 ? event.code : 'protocol',
				typeof event.message === 'string' ? event.message.slice(0, 2000) : '')
		}
		if (event.type === 'ready') {
			if (s.ready || event.sample_rate !== SAMPLE_RATE || event.max_seconds !== MAX_SECONDS ||
				typeof event.model !== 'string' || typeof event.endpoint !== 'string' ||
				typeof event.request_id !== 'string' || !event.request_id || event.request_id.length > 128) {
				return fail(s, 'protocol')
			}
			clearTimeout(s.readyDeadline)
			s.ready = true
			s.requestID = event.request_id
			s.model = event.model
			s.endpoint = event.endpoint
			model.value = event.model
			endpoint.value = event.endpoint
			if (!s.ending && s.node) stage.value = 'recording'
			pump(s)
			return
		}
		if (!s.ready) return fail(s, 'protocol')
		if (event.type === 'transcript') {
			if (typeof event.id !== 'string' || !event.id || event.id.length > 128 ||
				typeof event.text !== 'string' || typeof event.final !== 'boolean' ||
				(!s.segments.has(event.id) && s.segments.size >= 2048)) return fail(s, 'protocol')
			if (s.segments.get(event.id)?.final && !event.final) return
			s.segments.set(event.id, {text: event.text, final: event.final})
			const segments = Array.from(s.segments.values())
			const text = segments.map(segment => segment.text).filter(Boolean).join('\n')
			if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) return fail(s, 'protocol')
			liveText.value = text
			partial.value = segments.filter(segment => !segment.final).map(segment => segment.text).filter(Boolean).join('\n')
			options.onTranscript?.(text, s.owner)
			return
		}
		if (!s.stopSent || event.request_id !== s.requestID || typeof event.text !== 'string' ||
			new TextEncoder().encode(event.text).byteLength > MAX_TEXT_BYTES ||
			![event.elapsed_ms, event.first_text_ms, event.audio_duration_ms, event.finish_ms]
				.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return fail(s, 'protocol')
		if (!event.text.trim()) return fail(s, 'empty')
		const result: LiveSpeechStats = {
			elapsed_ms: event.elapsed_ms,
			first_text_ms: event.first_text_ms,
			audio_duration_ms: event.audio_duration_ms,
			finish_ms: event.finish_ms,
			request_id: event.request_id,
			model: s.model,
			endpoint: s.endpoint,
		}
		liveText.value = event.text
		partial.value = ''
		stats.value = result
		cleanup(s)
		options.onComplete(event.text, result, s.owner)
	}

	async function beginCapture(s: Session<Owner>) {
		try {
			await s.context.audioWorklet.addModule(pcmWorkletURL)
			if (!s.current() || s.closed || s.ending) return cleanup(s)
			const node = new AudioWorkletNode(s.context, 'astering-live-pcm', {processorOptions: {rate: SAMPLE_RATE}})
			s.node = node
			node.port.onmessage = event => {
				if (!s.current() || s.closed) return cleanup(s)
				if (s.captureClosed) return
				if (event.data === 'flushed') return s.flushed?.()
				if (event.data === 'overflow') return fail(s, 'buffer_full')
				if (!(event.data instanceof ArrayBuffer) || !event.data.byteLength || event.data.byteLength % 2 ||
					event.data.byteLength > SAMPLE_RATE * 2 / 10) return fail(s, 'protocol')
				node.port.postMessage('ack')
				const remaining = Math.min(MAX_BYTES, SAMPLE_RATE * 2 * MAX_SECONDS) - s.capturedBytes
				const frame = event.data.byteLength > remaining ? event.data.slice(0, remaining) : event.data
				if (s.queueBytes + frame.byteLength + (s.socket?.bufferedAmount ?? 0) > MAX_QUEUE_BYTES) {
					return fail(s, 'buffer_full')
				}
				if (frame.byteLength) {
					s.capturedBytes += frame.byteLength
					s.queueBytes += frame.byteLength
					s.queue.push(frame)
					bufferedSeconds.value = (s.queueBytes + (s.socket?.bufferedAmount ?? 0)) / (SAMPLE_RATE * 2)
					pump(s)
				}
				if (!s.ending && s.capturedBytes >= SAMPLE_RATE * 2 * MAX_SECONDS) void stop()
			}
			s.source = s.context.createMediaStreamSource(s.stream!)
			s.silent = s.context.createGain()
			s.silent.gain.value = 0
			s.source.connect(node).connect(s.silent).connect(s.context.destination)
			s.startedAt = performance.now()
			requesting.value = false
			recording.value = true
			stage.value = s.ready ? 'recording' : 'connecting'
			for (const track of s.stream!.getTracks()) {
				track.onended = () => { if (!s.ending) fail(s, 'interrupted') }
				track.onmute = () => { if (!s.ending) fail(s, 'interrupted') }
			}
			s.context.onstatechange = () => {
				if (!s.ending && !s.closed && s.context.state !== 'running') fail(s, 'interrupted')
			}
		} catch {
			if (s.current() && !s.closed) fail(s, 'unsupported')
			else cleanup(s)
		}
	}

	async function connect(s: Session<Owner>) {
		s.readyDeadline = setTimeout(() => fail(s, 'network'), 10_000)
		try {
			const socket = await openLiveSpeechSocket({
				context: s.request,
				connectionID: s.connectionID,
				isCurrent: () => s.current() && !s.closed,
				onEvent: event => receive(s, event),
				onClose: () => {
					if (!s.closed) fail(s, 'network')
				},
			})
			if (!s.current() || s.closed) socket.close()
			else s.socket = socket
		} catch (cause) {
			if (s.current() && !s.closed) {
				const rejected = (cause as {failure?: {kind?: string}})?.failure?.kind === 'rejected'
				fail(s, rejected ? 'authentication' : 'network')
			} else cleanup(s)
		}
	}

	async function start() {
		if (disposed || active.value) return
		const owner = options.capture()
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
			!window.AudioContext || !window.AudioWorkletNode || !window.WebSocket) {
			options.onError('unsupported', '', owner)
			return
		}
		const request = captureClientRequestContext()
		const connectionID = options.connectionID(owner)
		if (!connectionID || !options.isCurrent(owner)) return
		let context: AudioContext
		try {
			context = new AudioContext({latencyHint: 'interactive'})
		} catch {
			options.onError('unsupported', '', owner)
			return
		}
		const attempt = ++generation
		let complete!: () => void
		const completion = new Promise<void>(resolve => { complete = resolve })
		const s: Session<Owner> = {
			owner,
			request,
			connectionID,
			current: () => !disposed && attempt === generation && options.isCurrent(owner) && isClientRequestContextCurrent(request),
			context,
			queue: [],
			queueBytes: 0,
			capturedBytes: 0,
			nextSendAt: 0,
			startedAt: 0,
			ready: false,
			ending: false,
			stopSent: false,
			closed: false,
			captureClosed: false,
			segments: new Map(),
			completion,
			complete,
			requestID: '',
			model: '',
			endpoint: '',
		}
		session = s
		requesting.value = true
		stage.value = 'permission'
		elapsed.value = 0
		liveText.value = ''
		partial.value = ''
		stats.value = undefined
		model.value = ''
		endpoint.value = ''
		s.timer = setInterval(() => {
			if (!s.current()) return cleanup(s)
			if (!s.node || s.ending) return
			elapsed.value = Math.min(MAX_SECONDS, Math.max(0, (performance.now() - s.startedAt) / 1000))
			if (elapsed.value >= MAX_SECONDS) void stop()
		}, 250)
		try {
			// Resume in the user gesture; audio capture and authentication then prepare concurrently.
			const resumed = context.resume().then(() => true, () => {
				if (s.current() && !s.closed) fail(s, 'interrupted')
				else cleanup(s)
				return false
			})
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true},
			})
			if (!s.current() || s.closed) {
				stream.getTracks().forEach(track => track.stop())
				return cleanup(s)
			}
			s.stream = stream
			if (!await resumed) return
			if (!s.current() || s.closed) return cleanup(s)
			if (context.state !== 'running') return fail(s, 'interrupted')
			if (!context.audioWorklet || context.sampleRate < SAMPLE_RATE) return fail(s, 'unsupported')
			stage.value = 'connecting'
			await Promise.all([beginCapture(s), connect(s)])
		} catch (cause) {
			if (s.current() && !s.closed) fail(s, captureError(cause))
			else cleanup(s)
		}
	}

	function cancel() {
		generation++
		if (session) cleanup(session)
		liveText.value = ''
		partial.value = ''
		stats.value = undefined
	}

	async function stop() {
		const s = session
		if (!s || s.closed) return
		if (s.ending) return s.completion
		if (!s.node) return cancel()
		if (!s.current()) return cleanup(s)
		s.ending = true
		recording.value = false
		stopping.value = true
		stage.value = 'flushing'
		s.finishDeadline = setTimeout(() => fail(s, 'finalize_timeout'), 30_000)
		await new Promise<void>(resolve => {
			s.flushed = resolve
			s.flushDeadline = setTimeout(() => fail(s, 'finalize_timeout'), 1500)
			try {
				s.node!.port.postMessage('flush')
			} catch {
				fail(s, 'interrupted')
			}
		})
		clearTimeout(s.flushDeadline)
		s.flushed = undefined
		if (!s.current() || s.closed) return cleanup(s)
		closeCapture(s)
		stage.value = 'draining'
		pump(s)
		return s.completion
	}

	const onHidden = () => { if (document.hidden) cancel() }
	const onLeave = () => cancel()
	document.addEventListener('visibilitychange', onHidden)
	document.addEventListener('freeze', onLeave)
	window.addEventListener('pagehide', onLeave)
	onScopeDispose(() => {
		disposed = true
		document.removeEventListener('visibilitychange', onHidden)
		document.removeEventListener('freeze', onLeave)
		window.removeEventListener('pagehide', onLeave)
		cancel()
	})
	return {
		recording,
		requesting,
		stopping,
		elapsed,
		stage,
		liveText,
		partial,
		stats,
		model,
		endpoint,
		bufferedSeconds,
		start,
		stop,
		cancel,
	}
}
