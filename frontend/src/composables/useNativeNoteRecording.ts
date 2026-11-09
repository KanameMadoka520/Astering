import {computed, onScopeDispose, ref} from 'vue'
import {useQueryClient} from '@tanstack/vue-query'
import type {LiveNoteReceipt} from '@/client/queries/liveNotes'
import {noteKeys} from '@/client/queries/notes'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {getToken, getTokenIdentity, getTokenSessionID} from '@/helpers/auth'
import {
	onNativeAndroidEvent,
	requestNativeAndroid,
	type NativeRecordingSnapshot,
} from '@/helpers/nativeAndroid'
import type {useLiveNoteRecording, LiveRecordingState} from './useLiveNoteRecording'

type Options = Parameters<typeof useLiveNoteRecording>[0]
const STATES: LiveRecordingState[] = [
	'idle', 'permission', 'connecting', 'recording', 'reconnecting', 'stopping', 'paused',
]

/** Native owns the microphone, bounded audio queue and connection while the WebView is suspended. */
export function useNativeNoteRecording(options: Options) {
	const client = useQueryClient()
	const owner = captureClientRequestContext()
	const identity = getTokenIdentity(getToken())
	const sid = getTokenSessionID(getToken())
	const state = ref<LiveRecordingState>('idle')
	const actualEngine = ref<'online' | 'local'>('online')
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
	const pendingSync = ref(0)
	const inferenceMS = ref(0)
	const active = computed(() => !['idle', 'paused'].includes(state.value))
	const receipts: number[] = []
	let allowBackground = false
	let disposed = false
	let generation = 0
	let stopping: Promise<void> | undefined
	let recordingNoteID = 0
	let lastSequence = -1

	function current() {
		return !disposed && isClientRequestContextCurrent(owner) && sid === getTokenSessionID(getToken())
	}

	function receive(snapshot: NativeRecordingSnapshot) {
		if (!snapshot || !current() || snapshot.user_id !== identity?.id || snapshot.sid !== sid ||
			snapshot.note_id !== options.noteID() || !STATES.includes(snapshot.state as LiveRecordingState) ||
			!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence <= lastSequence) return
		lastSequence = snapshot.sequence
		actualEngine.value = snapshot.engine === 'local' ? 'local' : 'online'
		allowBackground = snapshot.allow_background === true
		recordingNoteID = snapshot.note_id
		retryAttempt.value = snapshot.retry_attempt ?? 0
		retryInSeconds.value = snapshot.retry_in_seconds ?? 0
		recoveryWarning.value = snapshot.incomplete_audio === true
		state.value = snapshot.state as LiveRecordingState
		error.value = snapshot.error ?? ''
		detail.value = snapshot.detail ?? ''
		partial.value = snapshot.partial || snapshot.interrupted_partial || ''
		for (const [target, value] of [
			[elapsed, snapshot.elapsed],
			[sentBytes, snapshot.sent_bytes],
			[bytesPerSecond, snapshot.bytes_per_second],
			[bufferedSeconds, snapshot.buffered_seconds],
			[savedSegments, snapshot.saved_segments],
		] as const) {
			if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target.value = value
		}
		model.value = snapshot.model ?? ''
		endpoint.value = snapshot.endpoint ?? ''
		screenAwake.value = snapshot.screen_awake === true
		localText.value = snapshot.local_text ?? ''
		pendingSync.value = snapshot.pending_sync ?? 0
		inferenceMS.value = snapshot.inference_ms ?? 0
		const segment = snapshot.segment as LiveNoteReceipt['segment'] | undefined
		const stats = snapshot.stats as LiveNoteReceipt['stats'] | undefined
		if (segment?.note_id === options.noteID() && typeof segment.id === 'number' &&
			Number.isSafeInteger(segment.id) && segment.id > 0 &&
			stats && typeof stats.updated === 'string' && Number.isSafeInteger(stats.segment_count) &&
			Number.isSafeInteger(stats.transcript_bytes) && !receipts.includes(segment.id)) {
			receipts.push(segment.id)
			if (receipts.length > 128) receipts.shift()
			options.onSegment({segment, stats})
		}
	}

	const unsubscribe = onNativeAndroidEvent(event => {
		if (event.event === 'recording') receive(event.snapshot)
	})

	async function status() {
		const run = generation
		try {
			await requestNativeAndroid('session', {token: getToken()})
			if (!current() || run !== generation) return
			const snapshot = await requestNativeAndroid<NativeRecordingSnapshot>('recordingStatus')
			if (!current() || run !== generation) return
			receive(snapshot)
			// Segments committed while the view was detached are read from the server, not a native history copy.
			void client.invalidateQueries({queryKey: noteKeys.segments(options.noteID())})
			void client.invalidateQueries({queryKey: noteKeys.detail(options.noteID()), exact: true})
		} catch {
			// The normal start action reports a connection failure; mounting must not pop microphone prompts.
		}
	}
	void status()

	async function start() {
		if (!current() || active.value) return
		const run = ++generation
		const noteID = options.noteID()
		recordingNoteID = noteID
		allowBackground = options.allowBackground?.() === true
		const engine = options.engine?.() ?? 'online'
		const startOptions = {
			note_id: noteID,
			connection_id: options.connectionID(),
			sample_rate: options.sampleRate(),
			language: engine === 'local' ? 'auto' : options.language(),
			allow_background: allowBackground,
			keep_awake: options.keepAwake?.() === true,
			engine,
			timezone: options.timezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
			append_to_article: options.appendToArticle?.() === true,
		}
		actualEngine.value = startOptions.engine
		state.value = 'permission'
		error.value = ''
		detail.value = ''
		try {
			await requestNativeAndroid('session', {token: getToken()})
			if (!current() || run !== generation) return
			const snapshot = await requestNativeAndroid<NativeRecordingSnapshot>('startRecording', {
				...startOptions,
				token: getToken(),
			}, 120_000)
			if (current() && run === generation && noteID === options.noteID()) receive(snapshot)
		} catch (cause) {
			if (!current() || run !== generation) return
			const code = cause instanceof Error ? cause.message : 'network'
			if (code === 'cancelled') {
				state.value = 'idle'
				return
			}
			error.value = ({
				session_changed: 'authentication',
				backpressure: 'buffer_full',
				connection_timeout: 'network',
			} as Record<string, string>)[code] ?? code
			if (error.value === 'native_timeout') {
				void requestNativeAndroid('stopRecording', {note_id: noteID, sid}, 45_000).catch(() => {})
			}
			state.value = 'paused'
		}
	}

	async function stop() {
		if (stopping) return stopping
		if (!isClientRequestContextCurrent(owner) || sid !== getTokenSessionID(getToken())) return
		generation++
		if (active.value) state.value = 'stopping'
		stopping = (async () => {
			try {
				const snapshot = await requestNativeAndroid<NativeRecordingSnapshot>('stopRecording', {
					note_id: recordingNoteID || options.noteID(),
					sid,
				}, 45_000)
				if (current()) receive(snapshot)
			} catch {
				if (current()) {
					error.value = 'finalize_timeout'
					state.value = 'paused'
				}
			} finally {
				stopping = undefined
			}
		})()
		return stopping
	}

	const onVisible = () => {
		if (!document.hidden && current()) void status()
	}
	document.addEventListener('visibilitychange', onVisible)
	onScopeDispose(() => {
		unsubscribe()
		document.removeEventListener('visibilitychange', onVisible)
		if (active.value && (!allowBackground || state.value === 'permission')) void stop()
		disposed = true
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
		pendingSync,
		inferenceMS,
		start,
		stop,
	}
}
