import {computed, onScopeDispose, ref} from 'vue'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {openLiveNoteSocket, type LiveNoteEvent, type LiveNoteReceipt} from '@/client/queries/liveNotes'
import pcmWorkletURL from '@/worklets/livePcmCapture.js?url'

export type LiveRecordingState = 'idle' | 'permission' | 'connecting' | 'recording' | 'reconnecting' | 'stopping' | 'paused'

type Session = {
	current: () => boolean,
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
	flush?: () => void,
	complete?: () => void,
	lastPump: number,
	wakeLock?: WakeLockSentinel,
	wakeRequest?: boolean,
	allowBackground: boolean,
	keepAwake: boolean,
}

/** A bounded microphone stream. Audio is never written to browser storage or uploaded as an attachment. */
export function useLiveNoteRecording(options: {
	noteID: () => number,
	connectionID: () => string,
	sampleRate: () => number,
	language: () => string,
	allowBackground?: () => boolean,
	keepAwake?: () => boolean,
	onSegment: (receipt: LiveNoteReceipt) => void,
}) {
	const state = ref<LiveRecordingState>('idle')
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
	const active = computed(() => !['idle', 'paused'].includes(state.value))
	let generation = 0
	let session: Session | undefined
	let disposed = false

	function closeCapture(s: Session) {
		if (s.captureClosed) return
		s.captureClosed = true
		s.node?.disconnect()
		s.source?.disconnect()
		s.silent?.disconnect()
		s.stream?.getTracks().forEach(track => track.stop())
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
		s.socket?.close()
		s.queue.length = 0
		s.queueBytes = 0
		s.complete?.()
		if (session === s) {
			session = undefined
			state.value = s.reason ? 'paused' : 'idle'
			bufferedSeconds.value = 0
		}
	}

	function fail(s: Session, code: string, message = '') {
		if (!s.current() || s.disposed) return
		error.value = code
		detail.value = message
		s.reason = code
		cleanup(s)
	}

	function pump(s: Session) {
		clearTimeout(s.pumpTimer)
		if (!s.current() || !s.ready || s.closingWire || s.socket?.readyState !== WebSocket.OPEN) return
		if (s.socket.bufferedAmount > s.rate * 2 * 4) {
			fail(s, 'network')
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
				fail(s, 'network')
				return
			}
			s.sent += frame.byteLength / 2
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
			fail(s, 'network')
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
		s.deadline = setTimeout(() => fail(s, 'network'), 15_000)
		const owner = captureClientRequestContext()
		const socket = await openLiveNoteSocket({
			context: owner,
			noteID,
			connectionID,
			offsetMS: s.offset,
			language: options.language(),
			isCurrent: wireCurrent,
			onEvent: event => {
				if (wireCurrent()) receive(s, event, noteID, connectionID)
			},
			onClose: () => {
				if (wireCurrent() && s.socket === socket) fail(s, 'interrupted')
			},
		})
		if (!wireCurrent()) socket.close()
		else s.socket = socket
	}

	function receive(s: Session, event: LiveNoteEvent, noteID: number, connectionID: string) {
		if (!s.current() || s.disposed) return
		if (event.type === 'error') {
			if (typeof event.text === 'string' && new TextEncoder().encode(event.text).byteLength <= 64 * 1024) partial.value = event.text
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
			s.offset = event.offset_ms
			s.rotateAt = event.rotate_seconds
			s.ready = true
			model.value = event.model
			endpoint.value = event.endpoint
			state.value = s.ending ? 'stopping' : 'recording'
			if (!s.node && !s.ending) void beginCapture(s).catch(() => fail(s, 'unsupported'))
			pump(s)
		} else if (event.type === 'partial') {
			partial.value = event.text
		} else if (event.type === 'segment') {
			partial.value = ''
			savedSegments.value++
			options.onSegment({segment: event.segment, stats: event.stats})
		} else if (event.type === 'done') {
			if (!s.closingWire) {
				fail(s, 'protocol')
				return
			}
			clearTimeout(s.deadline)
			s.wire++
			const previous = s.socket
			s.socket = undefined
			previous?.close()
			s.offset += Math.round(s.sent / s.rate * 1000)
			if (s.ending && !s.queue.length) cleanup(s)
			else void connect(s, noteID, connectionID).catch(() => fail(s, 'network'))
		}
	}

	async function beginCapture(s: Session) {
		await s.context.audioWorklet.addModule(pcmWorkletURL)
		if (!s.current() || s.disposed || s.ending || !s.stream) return
		const node = new AudioWorkletNode(s.context, 'astering-live-pcm', {processorOptions: {rate: s.rate}})
		s.node = node
		node.port.onmessage = event => {
			if (event.data === 'overflow') {
				fail(s, 'buffer_full')
				return
			}
			if (event.data === 'flushed') {
				s.flush?.()
				return
			}
			if (!s.current() || s.disposed || !(event.data instanceof ArrayBuffer)) return
			const frame = event.data as ArrayBuffer
			node.port.postMessage('ack')
			if (s.queueBytes + frame.byteLength > s.rate * 2 * 5) {
				fail(s, 'buffer_full')
				return
			}
			s.captured += frame.byteLength / 2
			s.queue.push(frame)
			s.queueBytes += frame.byteLength
			elapsed.value = s.captured / s.rate
			bufferedSeconds.value = s.queueBytes / 2 / s.rate
			pump(s)
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
		try {
			// Create/resume the audio context within the initial user gesture on mobile Safari.
			void context.resume().catch(() => {})
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true},
			})
			if (!s.current() || s.disposed || s.ending) {
				stream.getTracks().forEach(track => track.stop())
				cleanup(s)
				return
			}
			s.stream = stream
			if (!context.audioWorklet || context.sampleRate < s.rate) {
				fail(s, 'unsupported')
				return
			}
			state.value = 'connecting'
			let previousBytes = 0
			s.timer = setInterval(() => {
				if (!s.current()) {
					cleanup(s)
					return
				}
				bytesPerSecond.value = sentBytes.value - previousBytes
				previousBytes = sentBytes.value
				if (!s.ending && context.state !== 'running') void stop('microphone')
			}, 1000)
			await connect(s, noteID, connectionID)
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
				const timeout = setTimeout(resolve, 500)
				s.flush = () => { clearTimeout(timeout); resolve() }
				s.node!.port.postMessage('flush')
			})
		}
		closeCapture(s)
		if (s.disposed) return
		const done = new Promise<void>(resolve => { s.complete = resolve })
		pump(s)
		clearTimeout(s.deadline)
		s.deadline = setTimeout(() => fail(s, 'finalize_timeout'), 40_000)
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
	const onOffline = () => { void stop('network') }
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
		start,
		stop,
	}
}
