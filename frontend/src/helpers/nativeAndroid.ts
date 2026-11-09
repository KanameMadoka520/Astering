import {getApiBaseUrl} from '@/helpers/apiUrl'

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

const listeners = new Set<(event: NativeAndroidEvent) => void>()
const pending = new Map<string, {
	resolve: (value: unknown) => void,
	reject: (reason: Error) => void,
	timer: ReturnType<typeof setTimeout>,
	origin: string,
	apiBaseUrl: string | null,
}>()
let attached: NativeBridge | undefined

function hasNativeBridge(): boolean {
	try {
		const page = new URL(window.location.href)
		return page.protocol === 'https:' && page.origin === window.location.origin &&
			!page.username && !page.password && typeof window.AsteringNative?.postMessage === 'function'
	} catch {
		return false
	}
}

function nativeApiBaseUrl(): string | null {
	if (!hasNativeBridge()) return null
	try {
		const configured = getApiBaseUrl()
		const rootRelative = configured.startsWith('/') && !configured.startsWith('//')
		if (!rootRelative && !/^https:\/\//i.test(configured)) return null
		const api = new URL(configured, window.location.origin).href
		return api === `${window.location.origin}/api/v2` ? api : null
	} catch {
		return null
	}
}

export function isNativeAndroid(): boolean {
	// Android injects this bridge only into the explicitly selected HTTPS origin.
	// A page configured to use another API cannot give that API's tokens to native.
	return nativeApiBaseUrl() !== null
}

function bridge(clearSession = false): NativeBridge {
	if (!hasNativeBridge() || (!clearSession && !isNativeAndroid())) throw new Error('native_unavailable')
	const target = window.AsteringNative!
	if (attached !== target) {
		attached = target
		const origin = window.location.origin
		target.onmessage = ({data}) => {
			if (window.AsteringNative !== target || window.location.origin !== origin ||
				typeof data !== 'string' || data.length > 256 * 1024) return
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
				if (window.location.origin !== request.origin ||
					(request.apiBaseUrl !== null && nativeApiBaseUrl() !== request.apiBaseUrl)) {
					request.reject(new Error('native_context_changed'))
					return
				}
				if (message.ok === true) request.resolve(message.result)
				else request.reject(new Error(typeof message.error === 'string' ? message.error : 'native_error'))
				return
			}
			if (!isNativeAndroid()) return
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
	const apiBaseUrl = nativeApiBaseUrl()
	const clearSession = action === 'clearSession'
	if (!hasNativeBridge() || (!clearSession && apiBaseUrl === null)) {
		return Promise.reject(new Error('native_unavailable'))
	}
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
			origin: window.location.origin,
			apiBaseUrl: clearSession ? null : apiBaseUrl,
		})
		try {
			bridge(clearSession).postMessage(JSON.stringify(clearSession ? {id, action} : {...data, id, action}))
		} catch (cause) {
			clearTimeout(timer)
			pending.delete(id)
			reject(cause)
		}
	})
}

export function nativeAndroidSession(token: string | null): void {
	// Revocation must still stop the old recorder after the configured API changed.
	if (!hasNativeBridge() || (token !== null && !isNativeAndroid())) return
	void requestNativeAndroid(token ? 'session' : 'clearSession', token ? {token} : {}).catch(() => {})
}
