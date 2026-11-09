type NativeBridge = {
	postMessage: (message: string) => void,
	onmessage?: (event: {data: string}) => void,
}

export type NativeRecordingSnapshot = {
	user_id: number,
	sid: string,
	note_id: number,
	sequence: number,
	allow_background: boolean,
	state: string,
	partial?: string,
	elapsed?: number,
	sent_bytes?: number,
	bytes_per_second?: number,
	buffered_seconds?: number,
	saved_segments?: number,
	model?: string,
	endpoint?: string,
	error?: string,
	detail?: string,
	screen_awake?: boolean,
	segment?: unknown,
	stats?: unknown,
	engine?: 'online' | 'local',
	local_text?: string,
	local_client_id?: string,
	pending_sync?: number,
	inference_ms?: number,
	incomplete_audio?: boolean,
	interrupted_partial?: string,
	retry_attempt?: number,
	retry_in_seconds?: number,
}

export type NativeOfflineStatus = {
	available: boolean,
	ready: boolean,
	engine: 'local',
	model_id: string,
	model: string,
	bytes: number,
	sample_rate: number,
	pending_count: number,
	pending_bytes: number,
	max_pending_count: number,
	max_pending_bytes: number,
	audio_persisted: boolean,
	sync_error?: string,
	user_id: number,
}

export type NativeAndroidEvent =
	| {event: 'token', token: string}
	| {event: 'recording', snapshot: NativeRecordingSnapshot}
	| {event: 'openNote', note_id: number, user_id: number, sid: string}
	| {event: 'offline', user_id: number, status: NativeOfflineStatus, receipt?: {segment: unknown, stats: unknown}}

declare global {
	interface Window {
		AsteringNative?: NativeBridge,
	}
}

const APP_ORIGIN = 'https://task.tcymc.space'
const listeners = new Set<(event: NativeAndroidEvent) => void>()
const pending = new Map<string, {
	resolve: (value: unknown) => void,
	reject: (reason: Error) => void,
	timer: ReturnType<typeof setTimeout>,
}>()
let attached: NativeBridge | undefined

export function isNativeAndroid(): boolean {
	return window.location.origin === APP_ORIGIN && typeof window.AsteringNative?.postMessage === 'function'
}

function bridge(): NativeBridge {
	if (!isNativeAndroid()) throw new Error('native_unavailable')
	const target = window.AsteringNative!
	if (attached !== target) {
		attached = target
		target.onmessage = ({data}) => {
			if (typeof data !== 'string' || data.length > 256 * 1024) return
			let message: Record<string, unknown>
			try {
				message = JSON.parse(data)
			} catch {
				return
			}
			if (!message || typeof message !== 'object') return
			if (typeof message.id === 'string') {
				const request = pending.get(message.id)
				if (!request) return
				pending.delete(message.id)
				clearTimeout(request.timer)
				if (message.ok === true) request.resolve(message.result)
				else request.reject(new Error(typeof message.error === 'string' ? message.error : 'native_error'))
				return
			}
			if (!['recording', 'token', 'openNote', 'offline'].includes(String(message.event))) return
			for (const listener of listeners) {
				try {
					listener(message as NativeAndroidEvent)
				} catch {
					// One detached observer must not prevent authentication or another observer receiving the event.
				}
			}
		}
	}
	return target
}

export function onNativeAndroidEvent(listener: (event: NativeAndroidEvent) => void): () => void {
	listeners.add(listener)
	if (isNativeAndroid()) bridge()
	return () => { listeners.delete(listener) }
}

export function requestNativeAndroid<T>(
	action: string,
	data: Record<string, unknown> = {},
	timeoutMS = 20_000,
): Promise<T> {
	if (pending.size >= 32) return Promise.reject(new Error('native_busy'))
	return new Promise<T>((resolve, reject) => {
		const id = crypto.randomUUID()
		const timer = setTimeout(() => {
			pending.delete(id)
			reject(new Error('native_timeout'))
		}, timeoutMS)
		pending.set(id, {
			resolve: value => resolve(value as T),
			reject,
			timer,
		})
		try {
			bridge().postMessage(JSON.stringify({...data, id, action}))
		} catch (cause) {
			clearTimeout(timer)
			pending.delete(id)
			reject(cause)
		}
	})
}

export function nativeAndroidSession(token: string | null): void {
	if (!isNativeAndroid()) return
	void requestNativeAndroid(token ? 'session' : 'clearSession', token ? {token} : {}).catch(() => {})
}
