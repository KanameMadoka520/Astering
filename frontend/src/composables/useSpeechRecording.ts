import {onScopeDispose, ref} from 'vue'

type RecordingError = 'unsupported' | 'permission' | 'interrupted'

/** Each gesture owns its recorder and tracks, including a permission request that resolves late. */
export function useSpeechRecording<Owner>(options: {
	capture: () => Owner,
	isCurrent: (owner: Owner) => boolean,
	onComplete: (blob: Blob, filename: string, owner: Owner) => void,
	onError: (error: RecordingError) => void,
	maxSeconds?: number,
}) {
	const recording = ref(false)
	const requesting = ref(false)
	const elapsed = ref(0)
	let disposed = false
	let generation = 0
	let session: {stop: (discard?: boolean) => void} | undefined

	async function start() {
		if (disposed || requesting.value || recording.value) return
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
			let timer: ReturnType<typeof setInterval> | undefined
			const release = () => {
				if (released) return
				released = true
				if (timer) {
					clearInterval(timer)
					timer = undefined
				}
				ownedStream.getTracks().forEach(track => track.stop())
				if (attempt === generation) {
					recording.value = false
					session = undefined
				}
			}
			const stop = (discard = false) => {
				discarded ||= discard
				if (recorder.state !== 'inactive') recorder.stop()
				else release()
			}
			session = {stop}
			recorder.ondataavailable = event => {
				if (!discarded && event.data.size) chunks.push(event.data)
			}
			recorder.onstop = () => {
				if (finished) return
				finished = true
				release()
				if (disposed || discarded || attempt !== generation || !options.isCurrent(owner)) return
				const mime = recorder.mimeType || mimeType || 'audio/webm'
				const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
				options.onComplete(new Blob(chunks, {type: mime}), `recording.${extension}`, owner)
			}
			recorder.onerror = () => {
				if (finished) return
				discarded = true
				finished = true
				stop(true)
				release()
				if (!disposed && attempt === generation && options.isCurrent(owner)) {
					options.onError('interrupted')
				}
			}
			recorder.start(1000)
			recording.value = true
			elapsed.value = 0
			timer = setInterval(() => {
				if (!options.isCurrent(owner)) {
					stop(true)
					return
				}
				elapsed.value++
				if (elapsed.value >= (options.maxSeconds ?? 180)) stop()
			}, 1000)
		} catch {
			stream?.getTracks().forEach(track => track.stop())
			if (!disposed && attempt === generation && options.isCurrent(owner)) {
				options.onError('permission')
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
		active?.stop(true)
	}

	onScopeDispose(() => {
		disposed = true
		cancel()
	})
	return {
		recording,
		requesting,
		elapsed,
		start,
		stop: () => session?.stop(),
		cancel,
	}
}
