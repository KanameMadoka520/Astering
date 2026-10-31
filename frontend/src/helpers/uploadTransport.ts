import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {ref, shallowRef} from 'vue'
import {i18n} from '@/i18n'

export type UploadRecord = {id: string; names: string; stage: 'preparing' | 'converting' | 'uploading' | 'processing' | 'done' | 'error' | 'cancelled'; loaded: number; total: number; error?: string; originalBytes: number; sentBytes: number; targetPath: string; bytesPerSecond: number; averageBytesPerSecond: number; elapsedMs: number; scoped?: boolean}
export type ImageChoice = {mode: 'original' | 'webp'; quality: number; maxSide: number}
export const uploads = shallowRef<UploadRecord[]>([])
export const imagePrompt = shallowRef<{files: File[]; resolve: (choice: ImageChoice | null) => void} | null>(null)
export const uploadsExpanded = ref(true)
// Client-only headers: the generated client rebuilds the Request (new File objects, a follower signal),
// but passes headers through unchanged. The transport strips both before anything is sent.
export const UPLOAD_CHOICE_HEADER = 'X-Tcy-Upload-Choice'
export const UPLOAD_RECORD_HEADER = 'X-Tcy-Upload-Record'
const clientHeaders = [UPLOAD_CHOICE_HEADER.toLowerCase(), UPLOAD_RECORD_HEADER.toLowerCase()]
export type ImageBatch = {choice: ImageChoice | null; headers(recordId?: string): Record<string, string>; release(): void}
const activeRequests = new Set<() => void>()
const presets = new Map<string, ImageChoice>()
let uploadEpoch = 0
// The shared panel keeps its latest 12 rows; rows with a caller-chosen id belong to that caller's own list
// (a chat selection of up to 16 files), which removes them itself.
function capped(rows: UploadRecord[]) {
	let shared = 0
	return rows.filter(row => row.scoped || shared++ < 12)
}
export function clearUploads() { uploadEpoch++; presets.clear(); imagePrompt.value?.resolve(null); for (const cancel of activeRequests) cancel(); uploads.value=[] }
let queue = Promise.resolve()
const {t} = i18n.global

export function chooseImageUpload(files: File[], signal: AbortSignal): Promise<ImageChoice | null> {
	const epoch = uploadEpoch
	const ready = queue.then(() => {
		if (signal.aborted || epoch !== uploadEpoch) return null
		return new Promise<ImageChoice | null>(resolve => {
			let settled = false
			const finish = (choice: ImageChoice | null) => {
				if (settled) return
				settled = true
				signal.removeEventListener('abort', abort)
				imagePrompt.value = null
				resolve(choice)
			}
			const abort = () => finish(null)
			signal.addEventListener('abort', abort, {once: true})
			imagePrompt.value = {files, resolve: finish}
		})
	})
	queue = ready.then(() => undefined)
	return ready
}

/** Asks once for a whole selection; requests carrying `headers()` reuse the answer until `release()`. Cancelled → null. */
export async function chooseImageBatch(files: File[], signal: AbortSignal): Promise<ImageBatch | null> {
	const epoch = uploadEpoch
	const images = files.filter(file => file.type.startsWith('image/'))
	const choice = images.length ? await chooseImageUpload(images, signal) : null
	if ((images.length && !choice) || signal.aborted || epoch !== uploadEpoch) return null
	const token = crypto.randomUUID()
	if (choice) presets.set(token, choice)
	return {
		choice,
		headers: recordId => ({...(choice ? {[UPLOAD_CHOICE_HEADER]: token} : {}), ...(recordId ? {[UPLOAD_RECORD_HEADER]: recordId} : {})}),
		release: () => { presets.delete(token) },
	}
}

export async function convertImage(file: File, choice: ImageChoice): Promise<File> {
	if (choice.mode === 'original' || !/^image\/(png|jpe?g|webp|bmp)$/i.test(file.type)) return file
	const source = await createImageBitmap(file)
	try {
		const scale = choice.maxSide ? Math.min(1, choice.maxSide / Math.max(source.width, source.height)) : 1
		const canvas = document.createElement('canvas')
		canvas.width = Math.max(1, Math.round(source.width * scale))
		canvas.height = Math.max(1, Math.round(source.height * scale))
		const context = canvas.getContext('2d')
		if (!context) throw new Error(t('flow.imageFailed'))
		context.drawImage(source, 0, 0, canvas.width, canvas.height)
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', choice.quality))
		if (!blob || blob.type !== 'image/webp') throw new Error(t('flow.imageFailed'))
		return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.webp', {type: blob.type})
	} finally { source.close() }
}

function update(id: string, patch: Partial<UploadRecord>) {
	uploads.value = uploads.value.map(row => row.id === id ? {...row, ...patch} : row)
}

function withoutClientHeaders(request: Request) {
	const headers = new Headers(request.headers)
	for (const name of clientHeaders) headers.delete(name)
	return new Request(request, {headers})
}

/** SDK transport: auth, context fences and normalized API errors remain in the generated client's interceptors. */
export const uploadAwareFetch: typeof fetch = async (input, init) => {
	const request = input instanceof Request && !init ? input : new Request(input, init)
	if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
		return globalThis.fetch(clientHeaders.some(name => request.headers.has(name)) ? withoutClientHeaders(request) : request)
	}
	const preset = presets.get(request.headers.get(UPLOAD_CHOICE_HEADER) ?? '')
	const recordId = request.headers.get(UPLOAD_RECORD_HEADER) || undefined
	const context = captureClientRequestContext()
	const form = await request.clone().formData()
	const files = Array.from(form.values()).filter((item): item is File => item instanceof File)
	const images = files.filter(file => file.type.startsWith('image/'))
	// A caller-chosen id lets a retry replace its earlier row instead of stacking another one.
	const id = recordId ?? crypto.randomUUID()
	uploads.value = capped([{id, names: files.map(file => file.name).join(', '), stage: 'preparing' as const, loaded: 0, total: 0, originalBytes: files.reduce((sum, f) => sum + f.size, 0), sentBytes: 0, targetPath: new URL(request.url).pathname, bytesPerSecond: 0, averageBytesPerSecond: 0, elapsedMs: 0, scoped: Boolean(recordId)}, ...uploads.value.filter(row => row.id !== id)])
	let mode: ImageChoice['mode'] | undefined
	try {
		let body = form
		if (images.length) {
			// An unknown token (released, or cleared with the account) falls back to asking.
			const choice = preset ?? await chooseImageUpload(images, request.signal)
			if (!choice) throw new DOMException('Upload cancelled', 'AbortError')
			mode = choice.mode
			update(id, {stage: choice.mode === 'webp' ? 'converting' : 'preparing'})
			body = new FormData()
			for (const [key, value] of form) {
				if (request.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
				body.append(key, value instanceof File ? await convertImage(value, choice) : value)
				// Let the preparing indicator paint between files.
				await new Promise(resolve => requestAnimationFrame(resolve))
			}
		}
		assertClientRequestContext(context)
		const sentBytes = Array.from(body.values()).reduce((sum, value) => sum + (value instanceof File ? value.size : 0), 0)
		update(id, {stage: 'uploading', sentBytes})
		const response = await new Promise<Response>((resolve, reject) => {
			const xhr = new XMLHttpRequest()
			xhr.open(request.method, request.url)
			xhr.withCredentials = request.credentials === 'include'
			xhr.responseType = 'arraybuffer'
			for (const [key, value] of request.headers) if (key.toLowerCase() !== 'content-type' && !clientHeaders.includes(key.toLowerCase())) xhr.setRequestHeader(key, value)
			if (mode) xhr.setRequestHeader('X-Vikunja-Image-Mode', mode)
			const abort = () => xhr.abort()
			request.signal.addEventListener('abort', abort, {once: true})
			activeRequests.add(abort)
			const started = performance.now()
			let loaded = 0
			let total = 0
			let sampleAt = started
			let sampleBytes = 0
			let transferring = true
			const tick = () => {
				const now = performance.now()
				const elapsedMs = Math.max(0, now - started)
				const patch: Partial<UploadRecord> = {elapsedMs}
				if (transferring) patch.averageBytesPerSecond = loaded * 1000 / Math.max(1, elapsedMs)
				if (transferring && now > sampleAt) {
					patch.bytesPerSecond = Math.max(0, loaded - sampleBytes) * 1000 / (now - sampleAt)
					sampleAt = now
					sampleBytes = loaded
				}
				update(id, patch)
			}
			const timer = setInterval(tick, 500)
			const cleanup = () => { tick(); clearInterval(timer); request.signal.removeEventListener('abort', abort); activeRequests.delete(abort) }
			xhr.upload.onprogress = event => {
				loaded = event.loaded
				total = event.lengthComputable ? event.total : 0
				update(id, {loaded, total})
			}
			xhr.upload.onload = () => {
				tick()
				transferring = false
				update(id, {stage: 'processing', bytesPerSecond: 0})
			}
			xhr.onerror = () => { cleanup(); reject(new TypeError(t('flow.networkError'))) }
			xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')) }
			xhr.onload = () => {
				cleanup()
				const headers = new Headers()
				for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
					const index = line.indexOf(':')
					if (index > 0) headers.append(line.slice(0, index), line.slice(index + 1).trim())
				}
				let failed = xhr.status < 200 || xhr.status >= 300
				let failure = failed ? t('flow.httpError', {status: xhr.status}) : undefined
				// Attachment uploads may report individual failures in a successful HTTP response.
				if (!failed && headers.get('content-type')?.includes('json')) {
					try {
						const result = JSON.parse(new TextDecoder().decode(xhr.response))
						if (Array.isArray(result.errors) && result.errors.length) {failed = true; failure = t('flow.filesFailed')}
					} catch { /* The SDK reports malformed responses. */ }
				}
				update(id, {stage: failed ? 'error' : 'done', error: failure, bytesPerSecond: 0})
				resolve(new Response(xhr.status === 204 ? null : xhr.response, {status: xhr.status, statusText: xhr.statusText, headers}))
			}
			if (request.signal.aborted) { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')); return }
			try { xhr.send(body) } catch (cause) { cleanup(); reject(cause) }
		})
		return response
	} catch (error) {
		update(id, {stage: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error)})
		throw error
	}
}
