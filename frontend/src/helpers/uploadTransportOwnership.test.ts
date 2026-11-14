import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {flushPromises} from '@vue/test-utils'
import {
	clearUploads,
	imagePrompt,
	uploadAwareFetch,
	uploads,
	UPLOAD_RECORD_HEADER,
} from './uploadTransport'

const auth = vi.hoisted(() => ({
	id: 1,
	epoch: 1,
	token: 'initial',
	apiBase: '/api/v2',
}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => auth.token,
	getTokenIdentity: () => ({
		id: auth.id,
		type: 1,
	}),
	getAuthSessionEpoch: () => auth.epoch,
}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => auth.apiBase}))

const send = vi.fn()
class UploadXHR {
	static current: UploadXHR
	upload: {
		onprogress?: (event: {
			loaded: number,
			total: number,
			lengthComputable: boolean,
		}) => void,
	} = {}
	onload?: () => void
	onabort?: () => void
	status = 200
	statusText = 'OK'
	response = new TextEncoder().encode('{}').buffer
	constructor() { UploadXHR.current = this }
	open() {}
	setRequestHeader() {}
	send() { send() }
	getAllResponseHeaders() { return 'Content-Type: application/json\r\n' }
	abort() { this.onabort?.() }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {
		promise,
		resolve,
	}
}

function start(names = ['private.png'], signal?: AbortSignal, headers?: HeadersInit) {
	const body = new FormData()
	for (const name of names) body.append('files', new File(['private bytes'], name, {type: 'image/png'}))
	const request = uploadAwareFetch(new Request('http://localhost/api/v2/tasks/7/attachments', {
		method: 'POST',
		body,
		signal,
		headers,
	}))
	// A failed assertion may trigger cleanup before its rejection assertion; retain the original promise to verify it.
	void request.catch(() => {})
	return request
}

beforeEach(() => {
	Object.assign(auth, {
		id: 1,
		epoch: 1,
		token: 'initial',
		apiBase: '/api/v2',
	})
	send.mockClear()
	vi.stubGlobal('XMLHttpRequest', UploadXHR)
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		callback(0)
		return 0
	})
})
afterEach(async () => {
	clearUploads()
	await flushPromises()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('multipart preparation ownership', () => {
	it.each(['account', 'session', 'server', 'clear', 'abort'] as const)('discards delayed form data after %s changes', async change => {
		const parsed = deferred<void>()
		const release = deferred<void>()
		const formData = Request.prototype.formData
		vi.spyOn(Request.prototype, 'formData').mockImplementationOnce(async function (this: Request) {
			const form = await formData.call(this)
			parsed.resolve()
			await release.promise
			return form
		})
		const controller = new AbortController()
		const request = start(undefined, controller.signal)
		await parsed.promise
		if (change === 'account') auth.id++
		if (change === 'session') auth.epoch++
		if (change === 'server') auth.apiBase = 'https://another.example/api/v2'
		if (change === 'clear') clearUploads()
		if (change === 'abort') controller.abort()
		release.resolve()
		await flushPromises()
		expect(uploads.value).toEqual([])
		expect(imagePrompt.value).toBeNull()
		expect(send).not.toHaveBeenCalled()
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
	})

	it('stops a cancelled conversion batch before decoding another file and closes the bitmap', async () => {
		const decode = deferred<ImageBitmap>()
		const close = vi.fn()
		const bitmap = {
			width: 16,
			height: 16,
			close,
		} as unknown as ImageBitmap
		const createBitmap = vi.fn().mockImplementationOnce(() => decode.promise).mockResolvedValue(bitmap)
		vi.stubGlobal('createImageBitmap', createBitmap)
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
			.mockReturnValue({drawImage: vi.fn()} as unknown as CanvasRenderingContext2D)
		vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
			.mockImplementation(callback => callback(new Blob(['webp'], {type: 'image/webp'})))
		const request = start(['first.png', 'second.png'])
		await flushPromises()
		imagePrompt.value!.resolve({
			mode: 'webp',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		expect(createBitmap).toHaveBeenCalledTimes(1)
		clearUploads()
		decode.resolve(bitmap)
		await flushPromises()
		expect(createBitmap).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
		expect(uploads.value).toEqual([])
		expect(send).not.toHaveBeenCalled()
		await expect(request).rejects.toMatchObject({name: 'AbortError'})
	})

	it('continues preparing after a normal token refresh for the same session', async () => {
		const request = start()
		await flushPromises()
		auth.token = 'refreshed'
		imagePrompt.value!.resolve({
			mode: 'original',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		expect(send).toHaveBeenCalledTimes(1)
		UploadXHR.current.onload!()
		await request
		expect(uploads.value[0].stage).toBe('done')
	})

	it('does not let queued callbacks from a cleared upload overwrite a reused progress row', async () => {
		const headers = {[UPLOAD_RECORD_HEADER]: 'same-selection-row'}
		const previous = start(['previous.png'], undefined, headers)
		const rejected = expect(previous).rejects.toMatchObject({name: 'AbortError'})
		await flushPromises()
		imagePrompt.value!.resolve({
			mode: 'original',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		const oldXHR = UploadXHR.current
		clearUploads()
		await rejected
		const current = start(['current.png'], undefined, headers)
		await flushPromises()
		oldXHR.upload.onprogress!({
			loaded: 500,
			total: 1000,
			lengthComputable: true,
		})
		oldXHR.onload!()
		expect(uploads.value).toHaveLength(1)
		expect(uploads.value[0]).toMatchObject({
			id: 'same-selection-row',
			names: 'current.png',
			stage: 'preparing',
			loaded: 0,
			total: 0,
		})
		imagePrompt.value!.resolve({
			mode: 'original',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		UploadXHR.current.onload!()
		await current
		expect(uploads.value[0].stage).toBe('done')
	})

	it('keeps a same-session retry independent from a cancelled conversion with the same record id', async () => {
		const decode = deferred<ImageBitmap>()
		const bitmap = {
			width: 16,
			height: 16,
			close: vi.fn(),
		} as unknown as ImageBitmap
		vi.stubGlobal('createImageBitmap', () => decode.promise)
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
			.mockReturnValue({drawImage: vi.fn()} as unknown as CanvasRenderingContext2D)
		vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
			.mockImplementation(callback => callback(new Blob(['webp'], {type: 'image/webp'})))
		const headers = {[UPLOAD_RECORD_HEADER]: 'retry-row'}
		const controller = new AbortController()
		const previous = start(['old.png'], controller.signal, headers)
		const rejected = expect(previous).rejects.toMatchObject({name: 'AbortError'})
		await flushPromises()
		imagePrompt.value!.resolve({
			mode: 'webp',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		controller.abort()
		const current = start(['retry.png'], undefined, headers)
		await flushPromises()
		imagePrompt.value!.resolve({
			mode: 'original',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		expect(uploads.value[0].stage).toBe('uploading')
		decode.resolve(bitmap)
		await rejected
		expect(uploads.value[0]).toMatchObject({
			names: 'retry.png',
			stage: 'uploading',
		})
		UploadXHR.current.onload!()
		await current
	})

	it('does not let older multipart parsing replace a newer operation with the same record id', async () => {
		const parsed = deferred<void>()
		const release = deferred<void>()
		const formData = Request.prototype.formData
		vi.spyOn(Request.prototype, 'formData').mockImplementationOnce(async function (this: Request) {
			const form = await formData.call(this)
			parsed.resolve()
			await release.promise
			return form
		})
		const headers = {[UPLOAD_RECORD_HEADER]: 'parse-order-row'}
		const previous = start(['old.png'], undefined, headers)
		await parsed.promise
		const current = start(['latest.png'], undefined, headers)
		await flushPromises()
		imagePrompt.value!.resolve({
			mode: 'original',
			quality: .85,
			maxSide: 2560,
		})
		await flushPromises()
		release.resolve()
		await flushPromises()
		expect(uploads.value[0]).toMatchObject({
			names: 'latest.png',
			stage: 'uploading',
		})
		expect(imagePrompt.value).toBeNull()
		await expect(previous).rejects.toMatchObject({name: 'AbortError'})
		UploadXHR.current.onload!()
		await current
	})
})
