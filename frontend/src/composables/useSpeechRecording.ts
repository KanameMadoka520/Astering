import {onScopeDispose, ref} from 'vue'

type RecordingError = 'unsupported' | 'permission' | 'no-device' | 'device' | 'interrupted' | 'empty' | 'too-large'

function captureError(cause: unknown): RecordingError {
	const name = cause instanceof Error ? cause.name : ''
	if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'permission'
	if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-device'
	if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'OverconstrainedError') return 'device'
	if (name === 'NotSupportedError') return 'unsupported'
	return 'interrupted'
}

/** Each gesture owns its recorder and tracks, including a permission request that resolves late. */
export function useSpeechRecording<Owner>(options: {
	capture: () => Owner,
	isCurrent: (owner: Owner) => boolean,
	onComplete: (blob: Blob, filename: string, owner: Owner) => void,
	onError: (error: RecordingError) => void,
	maxSeconds?: number,
	maxBytes?: number,
}) {
	const recording = ref(false)
	const requesting = ref(false)
	const stopping = ref(false)
	const elapsed = ref(0)
	let disposed = false
	let generation = 0
	let session: {stop: (discard?: boolean) => void} | undefined

	async function start() {
		if (disposed || requesting.value || recording.value || stopping.value) return
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			options.onError('unsupported')
			return
		}
		const owner = options.capture()
		const attempt = ++generation
		requesting.value = true
		let stream: MediaStream | undefined
		try {
			stream = await navigator.mediaDevices.getUserMedia({audio: true})
			if (disposed || attempt !== generation || !options.isCurrent(owner)) {
				stream.getTracks().forEach(track => track.stop())
				return
			}
			const ownedStream = stream
			const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
				.find(type => MediaRecorder.isTypeSupported(type))
			const recorder = new MediaRecorder(ownedStream, mimeType ? {mimeType} : undefined)
			const chunks: Blob[] = []
			let discarded = false
			let finished = false
			let released = false
			let stopRequested = false
			let bytes = 0
			let timer: ReturnType<typeof setInterval> | undefined
			const clearTimer = () => {
				if (timer === undefined) return
				clearInterval(timer)
				timer = undefined
			}
			const release = () => {
				if (released) return
				released = true
				clearTimer()
				ownedStream.getTracks().forEach(track => track.stop())
				if (attempt === generation) {
					recording.value = false
					stopping.value = false
					session = undefined
				}
			}
			const stop = (discard = false) => {
				if (finished) return
				discarded ||= discard
				if (discarded) chunks.length = 0
				clearTimer()
				if (!stopRequested) {
					stopRequested = true
					if (attempt === generation) {
						recording.value = false
						stopping.value = !discarded
					}
					try {
						if (recorder.state !== 'inactive') recorder.stop()
					} catch {
						if (discarded) release()
						else fail('interrupted')
						return
					}
				}
				// Cancellation releases the microphone now, even if final events are delayed or never arrive.
				if (discarded) release()
			}
			const fail = (error: RecordingError) => {
				if (finished || discarded) return
				stop(true)
				finished = true
				if (!disposed && attempt === generation && options.isCurrent(owner)) options.onError(error)
			}
			session = {stop}
			recorder.ondataavailable = event => {
				if (finished || discarded || !event.data.size) return
				if (event.data.size > (options.maxBytes ?? 16 * 1024 * 1024) - bytes) {
					fail('too-large')
					return
				}
				bytes += event.data.size
				chunks.push(event.data)
			}
			recorder.onstop = () => {
				if (finished) return
				finished = true
				release()
				if (disposed || discarded || attempt !== generation || !options.isCurrent(owner)) {
					chunks.length = 0
					return
				}
				if (!bytes) {
					options.onError('empty')
					return
				}
				const mime = recorder.mimeType || mimeType || 'audio/webm'
				const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
				const blob = new Blob(chunks, {type: mime})
				chunks.length = 0
				options.onComplete(blob, `recording.${extension}`, owner)
			}
			recorder.onerror = () => fail('interrupted')
			recorder.start(1000)
			recording.value = true
			elapsed.value = 0
			const startedAt = performance.now()
			timer = setInterval(() => {
				if (!options.isCurrent(owner)) {
					stop(true)
					return
				}
				elapsed.value = Math.max(0, Math.floor((performance.now() - startedAt) / 1000))
				if (elapsed.value >= (options.maxSeconds ?? 180)) stop()
			}, 1000)
		} catch (cause) {
			stream?.getTracks().forEach(track => track.stop())
			if (attempt === generation) {
				session = undefined
				recording.value = false
				stopping.value = false
			}
			if (!disposed && attempt === generation && options.isCurrent(owner)) {
				options.onError(captureError(cause))
			}
		} finally {
			if (attempt === generation) requesting.value = false
		}
	}

	function cancel() {
		const active = session
		generation++
		session = undefined
		requesting.value = false
		recording.value = false
		stopping.value = false
		active?.stop(true)
	}

	function stop() {
		if (requesting.value) {
			cancel()
			return
		}
		session?.stop()
	}

	onScopeDispose(() => {
		disposed = true
		cancel()
	})
	return {
		recording,
		requesting,
		stopping,
		elapsed,
		start,
		stop,
		cancel,
	}
}
