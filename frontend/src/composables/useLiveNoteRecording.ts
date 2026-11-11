import {computed, onScopeDispose, ref, shallowRef} from 'vue'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {
	openLiveNoteSocket,
	type LiveNoteEvent,
	type LiveNoteReceipt,
	type LiveNoteServerDiagnostics,
	type LiveNoteTrace,
} from '@/client/queries/liveNotes'
import pcmWorkletURL from '@/worklets/livePcmCapture.js?url'

export type LiveRecordingState = 'idle' | 'permission' | 'connecting' | 'recording' | 'reconnecting' | 'stopping' | 'paused'

export type LiveNoteDiagnostics = {
	capturedBytes: number,
	captureFrames: number,
	uploadFrames: number,
	rms: number,
	peak: number,
	captureAgeSeconds: number | null,
	uploadAgeSeconds: number | null,
	transcriptAgeSeconds: number | null,
	warning: '' | 'capture_waiting' | 'input_quiet' | 'upload_waiting' | 'recognizer_waiting',
	microphoneName: string,
	requestID: string,
	providerCode: string,
	providerRequestID: string,
	providerTaskID: string,
	server?: LiveNoteServerDiagnostics,
}

type Session = {
	current: () => boolean,
	noteID: number,
	connectionID: string,
	stream?: MediaStream,
	context: AudioContext,
	node?: AudioWorkletNode,
	source?: MediaStreamAudioSourceNode,
	silent?: GainNode,
	socket?: WebSocket,
	wire: number,
	queue: ArrayBuffer[],
	queueBytes: number,
	ready: boolean,
	closingWire: boolean,
	ending: boolean,
	disposed: boolean,
	captureClosed: boolean,
	captured: number,
	sent: number,
	offset: number,
	rate: number,
	rotateAt: number,
	reason: string,
	timer?: ReturnType<typeof setInterval>,
	pumpTimer?: ReturnType<typeof setTimeout>,
	deadline?: ReturnType<typeof setTimeout>,
	stopDeadline?: ReturnType<typeof setTimeout>,
	flush?: () => void,
	complete?: () => void,
	lastPump: number,
	wakeLock?: WakeLockSentinel,
	wakeRequest?: boolean,
	allowBackground: boolean,
	keepAwake: boolean,
	recordingID: string,
	recordingStartedAt: string,
	timezone: string,
	appendToArticle: boolean,
	retryTimer?: ReturnType<typeof setTimeout>,
	retryCount: number,
	connectedAt: number,
	captureStartedAt?: number,
	lastCaptureAt?: number,
	lastUploadAt?: number,
	lastTranscriptAt?: number,
	lastSoundAt?: number,
	quietStartedAt?: number,
}

const MAX_BUFFER_SECONDS = 30
const MAX_RETRY_ATTEMPTS = 5

function emptyDiagnostics(): LiveNoteDiagnostics {
	return {
		capturedBytes: 0,
		captureFrames: 0,
		uploadFrames: 0,
		rms: 0,
		peak: 0,
		captureAgeSeconds: null,
		uploadAgeSeconds: null,
		transcriptAgeSeconds: null,
		warning: '',
		microphoneName: '',
		requestID: '',
		providerCode: '',
		providerRequestID: '',
		providerTaskID: '',
	}
}

/** A bounded microphone stream. Audio is never written to browser storage or uploaded as an attachment. */
export function useLiveNoteRecording(options: {
	noteID: () => number,
	connectionID: () => string,
	sampleRate: () => number,
	language: () => string,
	allowBackground?: () => boolean,
	keepAwake?: () => boolean,
	engine?: () => 'online' | 'local',
	timezone?: () => string,
	appendToArticle?: () => boolean,
	onSegment: (receipt: LiveNoteReceipt) => void,
}) {
	const state = ref<LiveRecordingState>('idle')
	const actualEngine = computed(() => 'online' as const)
	const error = ref('')
	const detail = ref('')
	const partial = ref('')
	const elapsed = ref(0)
	const sentBytes = ref(0)
	const bytesPerSecond = ref(0)
	const bufferedSeconds = ref(0)
	const savedSegments = ref(0)
	const model = ref('')
	const endpoint = ref('')
	const screenAwake = ref(false)
	const retryAttempt = ref(0)
	const retryInSeconds = ref(0)
	const recoveryWarning = ref(false)
	const localText = ref('')
	const inferenceMS = ref(0)
	const diagnostics = shallowRef<LiveNoteDiagnostics>(emptyDiagnostics())
	const active = computed(() => !['idle', 'paused'].includes(state.value))
	let generation = 0
	let session: Session | undefined
	let disposed = false

	function closeCapture(s: Session) {
		if (s.captureClosed) return
		s.captureClosed = true
		s.context.onstatechange = null
		s.node?.disconnect()
		s.source?.disconnect()
		s.silent?.disconnect()
		s.stream?.getTracks().forEach(track => {
			track.onended = null
			track.onmute = null
			track.stop()
		})
		void s.context.close().catch(() => {})
		void s.wakeLock?.release().catch(() => {})
		s.wakeLock = undefined
		screenAwake.value = false
	}

	function cleanup(s: Session) {
		if (s.disposed) return
		s.disposed = true
		s.wire++
		closeCapture(s)
		clearInterval(s.timer)
		clearTimeout(s.pumpTimer)
		clearTimeout(s.deadline)
		clearTimeout(s.stopDeadline)
		clearTimeout(s.retryTimer)
		s.flush?.()
		s.flush = undefined
		s.socket?.close()
		s.queue.length = 0
		s.queueBytes = 0
		s.complete?.()
		if (session === s) {
			session = undefined
			state.value = s.reason ? 'paused' : 'idle'
			bufferedSeconds.value = 0
			bytesPerSecond.value = 0
			retryInSeconds.value = 0
			diagnostics.value = s.current() ? {...diagnostics.value, rms: 0, peak: 0, warning: ''} : emptyDiagnostics()
		}
	}

	function updateDiagnostics(s: Session) {
		if (!s.current() || s.disposed || s.captureStartedAt === undefined) return
		const now = performance.now()
		const age = (timestamp: number | undefined) => timestamp === undefined
			? null : Math.max(0, (now - timestamp) / 1000)
		const captureAgeSeconds = age(s.lastCaptureAt)
		const uploadAgeSeconds = age(s.lastUploadAt)
		const transcriptAgeSeconds = age(s.lastTranscriptAt)
		let warning: LiveNoteDiagnostics['warning'] = ''
		if (!s.ending) {
			if (now - (s.lastCaptureAt ?? s.captureStartedAt) >= 3000) warning = 'capture_waiting'
			else if (s.quietStartedAt !== undefined && now - s.quietStartedAt >= 8000) warning = 'input_quiet'
			else if (s.queueBytes > s.rate * 2 * 3 && (uploadAgeSeconds === null || uploadAgeSeconds >= 3)) {
				warning = 'upload_waiting'
			} else if (s.ready && s.lastSoundAt !== undefined && s.lastSoundAt > (s.lastTranscriptAt ?? -1) &&
				uploadAgeSeconds !== null && uploadAgeSeconds < 3 &&
				now - Math.max(s.lastTranscriptAt ?? s.connectedAt, s.connectedAt) >= 12000) {
				warning = 'recognizer_waiting'
			}
		}
		diagnostics.value = {
			...diagnostics.value,
			captureAgeSeconds,
			uploadAgeSeconds,
			transcriptAgeSeconds,
			warning,
			...(captureAgeSeconds !== null && captureAgeSeconds >= 1 ? {rms: 0, peak: 0} : {}),
		}
	}

	function measureFrame(s: Session, frame: ArrayBuffer) {
		const samples = new DataView(frame)
		let squareSum = 0
		let peak = 0
		for (let index = 0; index < samples.byteLength; index += 2) {
			const value = samples.getInt16(index, true) / 32768
			squareSum += value * value
			peak = Math.max(peak, Math.abs(value))
		}
		const rms = Math.sqrt(squareSum / (samples.byteLength / 2))
		const now = performance.now()
		s.lastCaptureAt = now
		// This threshold only explains the input meter; every PCM sample is still uploaded unchanged.
		if (rms > 0.001) {
			s.lastSoundAt = now
			s.quietStartedAt = undefined
		} else s.quietStartedAt ??= now
		diagnostics.value = {
			...diagnostics.value,
			capturedBytes: diagnostics.value.capturedBytes + frame.byteLength,
			captureFrames: diagnostics.value.captureFrames + 1,
			rms,
			peak,
		}
	}

	function receiveTrace(event: LiveNoteTrace, ready = false) {
		const identifier = (value: unknown) => typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value) ? value : ''
		const snapshot = ready ? undefined : event.diagnostics
		const valid = snapshot && [
			snapshot.elapsed_ms,
			snapshot.received_bytes,
			snapshot.audio_duration_ms,
			snapshot.last_audio_ms,
			snapshot.partial_updates,
			snapshot.saved_segments,
			snapshot.first_text_ms,
			snapshot.last_text_ms,
		].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
		diagnostics.value = {
			...diagnostics.value,
			requestID: identifier(event.request_id) || (ready ? '' : diagnostics.value.requestID),
			providerCode: identifier(event.provider_code),
			providerRequestID: identifier(event.provider_request_id),
			providerTaskID: identifier(event.provider_task_id),
			server: valid ? {
				elapsed_ms: snapshot.elapsed_ms,
				received_bytes: snapshot.received_bytes,
				audio_duration_ms: snapshot.audio_duration_ms,
				last_audio_ms: snapshot.last_audio_ms,
				partial_updates: snapshot.partial_updates,
				saved_segments: snapshot.saved_segments,
				first_text_ms: snapshot.first_text_ms,
				last_text_ms: snapshot.last_text_ms,
			} : undefined,
		}
	}

	function fail(s: Session, code: string, message = '') {
		if (!s.current() || s.disposed) return
		error.value = code
		detail.value = message
		s.reason = code
		cleanup(s)
	}

	function retry(s: Session, noteID: number, connectionID: string) {
		if (s.disposed) return
		if (!s.current()) return cleanup(s)
		if (s.sent > 0) recoveryWarning.value = true
		// Never replay bytes handed to a failed wire: its last final may have committed without a receipt.
		s.offset += Math.round(s.sent / s.rate * 1000)
		s.sent = 0
		s.ready = false
		s.closingWire = false
		s.wire++
		const previous = s.socket
		s.socket = undefined
		previous?.close()
		clearTimeout(s.deadline)
		clearTimeout(s.pumpTimer)
		clearTimeout(s.retryTimer)
		if (++s.retryCount > MAX_RETRY_ATTEMPTS) {
			fail(s, 'retry_exhausted')
			return
		}
		retryAttempt.value = s.retryCount
		state.value = s.ending ? 'stopping' : 'reconnecting'
		const delay = Math.min(8_000, 500 * 2 ** (s.retryCount - 1))
		retryInSeconds.value = delay / 1000
		s.retryTimer = setTimeout(() => {
			s.retryTimer = undefined
			retryInSeconds.value = 0
			if (!s.current() || s.disposed) return cleanup(s)
			void connect(s, noteID, connectionID).catch(cause => connectionFailed(s, cause))
		}, delay)
	}

	function connectionFailed(s: Session, cause: unknown) {
		if (!s.current()) return cleanup(s)
		if (cause && typeof cause === 'object' && 'failure' in cause &&
			typeof cause.failure === 'object' && cause.failure && 'kind' in cause.failure &&
			cause.failure.kind === 'rejected') {
			fail(s, 'authentication')
			return
		}
		retry(s, s.noteID, s.connectionID)
	}

	function pump(s: Session) {
		clearTimeout(s.pumpTimer)
		if (!s.current() || !s.ready || s.closingWire || s.socket?.readyState !== WebSocket.OPEN) return
		if (s.socket.bufferedAmount > s.rate * 2 * 4) {
			retry(s, s.noteID, s.connectionID)
			return
		}
		if (s.queue.length) {
			// At most 2x real time catches up after an upstream rotation, without an upload burst.
			const wait = Math.max(0, 50 - (performance.now() - s.lastPump))
			if (wait > 0) {
				s.pumpTimer = setTimeout(() => pump(s), wait)
				return
			}
			const frame = s.queue.shift()!
			s.queueBytes -= frame.byteLength
			try {
				s.socket.send(frame)
			} catch {
				// A thrown send never handed this frame to the transport.
				s.queue.unshift(frame)
				s.queueBytes += frame.byteLength
				retry(s, s.noteID, s.connectionID)
				return
			}
			s.sent += frame.byteLength / 2
			s.lastUploadAt = performance.now()
			diagnostics.value = {...diagnostics.value, uploadFrames: diagnostics.value.uploadFrames + 1}
			s.lastPump = performance.now()
			sentBytes.value += frame.byteLength
			bufferedSeconds.value = s.queueBytes / 2 / s.rate
			if (s.queue.length) s.pumpTimer = setTimeout(() => pump(s), 50)
		}
		if (s.ending && !s.queue.length) finishWire(s)
		else if (!s.ending && s.sent / s.rate >= s.rotateAt) {
			state.value = 'reconnecting'
			finishWire(s)
		}
	}

	function finishWire(s: Session) {
		if (!s.ready || s.closingWire || s.socket?.readyState !== WebSocket.OPEN) return
		s.closingWire = true
		try {
			s.socket.send(JSON.stringify({action: 'stop'}))
		} catch {
			retry(s, s.noteID, s.connectionID)
			return
		}
		clearTimeout(s.deadline)
		s.deadline = setTimeout(() => fail(s, 'finalize_timeout'), 40_000)
	}

	async function connect(s: Session, noteID: number, connectionID: string) {
		const wire = ++s.wire
		const wireCurrent = () => s.current() && !s.disposed && s.wire === wire
		s.ready = false
		s.closingWire = false
		s.sent = 0
		clearTimeout(s.deadline)
		s.deadline = setTimeout(() => retry(s, noteID, connectionID), 10_000)
		const owner = captureClientRequestContext()
		const socket = await openLiveNoteSocket({
			context: owner,
			noteID,
			connectionID,
			offsetMS: s.offset,
			language: options.language(),
			recordingID: s.recordingID,
			recordingStartedAt: s.recordingStartedAt,
			recordingOffsetMS: Math.round((s.captured - s.queueBytes / 2) / s.rate * 1000),
			timezone: s.timezone,
			appendToArticle: s.appendToArticle,
			isCurrent: wireCurrent,
			onEvent: event => {
				if (wireCurrent()) receive(s, event, noteID, connectionID)
			},
			onClose: () => {
				if (wireCurrent() && s.socket === socket) retry(s, noteID, connectionID)
			},
		})
		if (!wireCurrent()) socket.close()
		else s.socket = socket
	}

	function receive(s: Session, event: LiveNoteEvent, noteID: number, connectionID: string) {
		if (!s.current() || s.disposed) return
		if (event.type === 'error') {
			receiveTrace(event)
			if (typeof event.text === 'string' && new TextEncoder().encode(event.text).byteLength <= 64 * 1024) partial.value = event.text
			if (['network', 'interrupted', 'already_recording'].includes(event.code)) {
				retry(s, noteID, connectionID)
				return
			}
			fail(s, event.code, event.message)
			return
		}
		if (event.type === 'ready') {
			if (s.ready || event.sample_rate !== s.rate || !Number.isFinite(event.offset_ms) || event.offset_ms < s.offset ||
				!Number.isFinite(event.rotate_seconds) || event.rotate_seconds < 30 || event.rotate_seconds > 480) {
				fail(s, 'protocol')
				return
			}
			clearTimeout(s.deadline)
			receiveTrace(event, true)
			s.offset = event.offset_ms
			s.rotateAt = event.rotate_seconds
			s.ready = true
			s.connectedAt = performance.now()
			retryInSeconds.value = 0
			model.value = event.model
			endpoint.value = event.endpoint
			state.value = s.ending ? 'stopping' : 'recording'
			pump(s)
		} else if (event.type === 'partial') {
			if (event.text.trim()) s.lastTranscriptAt = performance.now()
			partial.value = event.text
		} else if (event.type === 'segment') {
			s.lastTranscriptAt = performance.now()
			partial.value = ''
			savedSegments.value++
			options.onSegment({segment: event.segment, stats: event.stats})
		} else if (event.type === 'done') {
			if (!s.closingWire) {
				fail(s, 'protocol')
				return
			}
			clearTimeout(s.deadline)
			receiveTrace(event)
			s.wire++
			const previous = s.socket
			s.socket = undefined
			previous?.close()
			s.offset += Math.round(s.sent / s.rate * 1000)
			if (s.ending && !s.queue.length) cleanup(s)
			else void connect(s, noteID, connectionID).catch(cause => connectionFailed(s, cause))
		}
	}

	async function beginCapture(s: Session) {
		await s.context.audioWorklet.addModule(pcmWorkletURL)
		if (!s.current() || s.disposed || s.ending || !s.stream) return
		const node = new AudioWorkletNode(s.context, 'astering-live-pcm', {processorOptions: {rate: s.rate}})
		s.node = node
		node.port.onmessage = event => {
			if (!s.current()) return cleanup(s)
			if (s.disposed || s.captureClosed) return
			if (event.data === 'overflow') {
				fail(s, 'buffer_full')
				return
			}
			if (event.data === 'flushed') {
				s.flush?.()
				return
			}
			if (!(event.data instanceof ArrayBuffer)) return
			const frame = event.data as ArrayBuffer
			if (!frame.byteLength || frame.byteLength % 2 || frame.byteLength > s.rate * 2 / 10) {
				fail(s, 'protocol')
				return
			}
			node.port.postMessage('ack')
			if (s.queueBytes + frame.byteLength > s.rate * 2 * MAX_BUFFER_SECONDS) {
				fail(s, 'buffer_full')
				return
			}
			s.captured += frame.byteLength / 2
			s.queue.push(frame)
			s.queueBytes += frame.byteLength
			measureFrame(s, frame)
			elapsed.value = s.captured / s.rate
			bufferedSeconds.value = s.queueBytes / 2 / s.rate
			pump(s)
		}
		s.recordingStartedAt = new Date().toISOString()
		s.captureStartedAt = performance.now()
		diagnostics.value = {
			...diagnostics.value,
			microphoneName: s.stream.getAudioTracks()[0]?.label?.slice(0, 512) ?? '',
		}
		s.source = s.context.createMediaStreamSource(s.stream)
		s.silent = s.context.createGain()
		s.silent.gain.value = 0
		s.source.connect(node).connect(s.silent).connect(s.context.destination)
		for (const track of s.stream.getAudioTracks()) {
			track.onended = () => { if (!s.ending) void stop('microphone') }
			track.onmute = () => { if (!s.ending) void stop('microphone') }
		}
		s.context.onstatechange = () => {
			if (!s.ending && !s.disposed && s.context.state !== 'running') void stop('microphone')
		}
		void requestWakeLock(s)
	}

	async function requestWakeLock(s: Session) {
		if (!s.keepAwake || !navigator.wakeLock || document.hidden || s.wakeLock || s.wakeRequest || s.ending) return
		s.wakeRequest = true
		try {
			const lock = await navigator.wakeLock.request('screen')
			if (!s.current() || s.disposed || s.ending || document.hidden || lock.released) {
				await lock.release()
				return
			}
			s.wakeLock = lock
			screenAwake.value = true
			lock.addEventListener('release', () => {
				if (s.wakeLock !== lock) return
				s.wakeLock = undefined
				screenAwake.value = false
			})
		} catch {
			if (s.current() && !s.disposed && !s.ending) screenAwake.value = false
		} finally {
			s.wakeRequest = false
		}
	}

	async function start() {
		if (disposed || active.value || !options.noteID() || !options.connectionID()) return
		error.value = ''
		detail.value = ''
		partial.value = ''
		if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
			error.value = 'unsupported'
			return
		}
		const owner = captureClientRequestContext()
		const attempt = ++generation
		const noteID = options.noteID()
		const connectionID = options.connectionID()
		let context: AudioContext
		try {
			context = new AudioContext()
		} catch {
			error.value = 'unsupported'
			return
		}
		const s: Session = {
			current: () => attempt === generation && isClientRequestContextCurrent(owner),
			noteID,
			connectionID,
			context,
			wire: 0,
			queue: [],
			queueBytes: 0,
			ready: false,
			closingWire: false,
			ending: false,
			disposed: false,
			captureClosed: false,
			captured: 0,
			sent: 0,
			offset: 0,
			rate: options.sampleRate(),
			rotateAt: 420,
			reason: '',
			lastPump: 0,
			// Account preferences may refresh while recording; an active capture keeps its starting choices.
			allowBackground: options.allowBackground?.() === true,
			keepAwake: options.keepAwake?.() === true,
			recordingID: crypto.randomUUID(),
			recordingStartedAt: '',
			timezone: options.timezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
			appendToArticle: options.appendToArticle?.() === true,
			retryCount: 0,
			connectedAt: 0,
		}
		session = s
		state.value = 'permission'
		elapsed.value = 0
		sentBytes.value = 0
		bytesPerSecond.value = 0
		bufferedSeconds.value = 0
		savedSegments.value = 0
		model.value = ''
		endpoint.value = ''
		retryAttempt.value = 0
		retryInSeconds.value = 0
		recoveryWarning.value = false
		diagnostics.value = emptyDiagnostics()
		try {
			// Create/resume the audio context within the initial user gesture on mobile Safari.
			const resumed = context.resume().then(() => true, () => {
				if (s.current() && !s.disposed) fail(s, 'microphone')
				else cleanup(s)
				return false
			})
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true},
			})
			if (!s.current() || s.disposed || s.ending) {
				stream.getTracks().forEach(track => track.stop())
				cleanup(s)
				return
			}
			s.stream = stream
			if (!await resumed) return
			if (!s.current() || s.disposed || s.ending) return cleanup(s)
			if (context.state !== 'running') return fail(s, 'microphone')
			if (!context.audioWorklet || context.sampleRate < s.rate) {
				fail(s, 'unsupported')
				return
			}
			state.value = 'connecting'
			await beginCapture(s)
			if (!s.current() || s.disposed || s.ending) return cleanup(s)
			let previousBytes = 0
			let previousSampleAt = performance.now()
			s.timer = setInterval(() => {
				if (!s.current()) {
					cleanup(s)
					return
				}
				const sampledAt = performance.now()
				const interval = sampledAt - previousSampleAt
				bytesPerSecond.value = interval > 0 ? (sentBytes.value - previousBytes) * 1000 / interval : 0
				previousBytes = sentBytes.value
				previousSampleAt = sampledAt
				updateDiagnostics(s)
				if (!s.ending && s.captureStartedAt !== undefined && s.captured === 0 &&
					performance.now() - s.captureStartedAt >= 10000) {
					fail(s, 'capture_empty')
					return
				}
				if (s.ready && performance.now() - s.connectedAt >= 30_000) {
					s.retryCount = 0
					retryAttempt.value = 0
				}
				if (!s.ending && context.state !== 'running') void stop('microphone')
			}, 1000)
			await connect(s, noteID, connectionID).catch(cause => connectionFailed(s, cause))
		} catch (cause) {
			if (s.current() && !s.disposed) fail(s, (cause as DOMException)?.name === 'NotAllowedError' ? 'permission' : 'network')
			else cleanup(s)
		}
	}

	async function stop(reason = '') {
		const s = session
		if (!s || s.disposed || s.ending) return
		s.ending = true
		s.reason = reason
		if (reason) error.value = reason
		state.value = 'stopping'
		if (!s.stream) {
			generation++
			cleanup(s)
			return
		}
		if (s.node) {
			await new Promise<void>(resolve => {
				const timeout = setTimeout(() => fail(s, 'finalize_timeout'), 1500)
				s.flush = () => { clearTimeout(timeout); resolve() }
				try {
					s.node!.port.postMessage('flush')
				} catch {
					fail(s, 'microphone')
				}
			})
			s.flush = undefined
		}
		if (s.disposed) return
		closeCapture(s)
		if (s.disposed) return
		const done = new Promise<void>(resolve => { s.complete = resolve })
		pump(s)
		s.stopDeadline = setTimeout(() => fail(s, 'finalize_timeout'), 40_000)
		await done
	}

	const onHidden = () => {
		if (document.hidden && session && !session.allowBackground) void stop('background')
		else if (!document.hidden && session) {
			if (session.context.state !== 'running') void stop('microphone')
			else void requestWakeLock(session)
		}
	}
	const onPageHide = () => { void stop('background') }
	const onOffline = () => {
		if (session && !session.retryTimer && !session.disposed) retry(session, session.noteID, session.connectionID)
	}
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!active.value) return
		event.preventDefault()
		event.returnValue = ''
	}
	document.addEventListener('visibilitychange', onHidden)
	document.addEventListener('freeze', onPageHide)
	window.addEventListener('pagehide', onPageHide)
	window.addEventListener('offline', onOffline)
	window.addEventListener('beforeunload', beforeUnload)
	onScopeDispose(() => {
		disposed = true
		document.removeEventListener('visibilitychange', onHidden)
		document.removeEventListener('freeze', onPageHide)
		window.removeEventListener('pagehide', onPageHide)
		window.removeEventListener('offline', onOffline)
		window.removeEventListener('beforeunload', beforeUnload)
		void stop()
	})
	return {
		state,
		actualEngine,
		active,
		error,
		detail,
		partial,
		elapsed,
		sentBytes,
		bytesPerSecond,
		bufferedSeconds,
		savedSegments,
		model,
		endpoint,
		screenAwake,
		retryAttempt,
		retryInSeconds,
		recoveryWarning,
		localText,
		inferenceMS,
		diagnostics,
		start,
		stop,
	}
}
