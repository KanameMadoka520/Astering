import {afterEach, describe, expect, it, vi} from 'vitest'
import {effectScope, type EffectScope} from 'vue'
import {useSpeechRecording} from './useSpeechRecording'

class Recorder {
	static instances: Recorder[] = []
	static isTypeSupported(type: string) { return type === 'audio/mp4' }
	state = 'inactive'
	mimeType = 'audio/mp4'
	ondataavailable?: (event: {data: Blob}) => void
	onstop?: () => void
	onerror?: () => void
	constructor() { Recorder.instances.push(this) }
	start() { this.state = 'recording' }
	stop() { this.state = 'inactive'; this.onstop?.() }
}
class DelayedRecorder extends Recorder {
	stopCalls = 0
	stop() {
		if (this.state === 'inactive') return
		this.state = 'inactive'
		this.stopCalls++
	}
	emit(data: string) { this.ondataavailable?.({data: new Blob([data])}) }
	finish(data = 'final audio') {
		// stop() changes state synchronously; final dataavailable and stop are later tasks.
		this.emit(data)
		this.onstop?.()
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {
		promise,
		resolve,
	}
}
const scopes: EffectScope[] = []
function setup(limits: {maxSeconds?: number, maxBytes?: number} = {}, delayed = false) {
	const stopTrack = vi.fn()
	const stream = {getTracks: () => [{stop: stopTrack}]} as unknown as MediaStream
	const permission = deferred<MediaStream>()
	const getUserMedia = vi.fn(() => permission.promise)
	vi.stubGlobal('navigator', {mediaDevices: {getUserMedia}})
	vi.stubGlobal('MediaRecorder', delayed ? DelayedRecorder : Recorder)
	Recorder.instances = []
	let owner = 'first-account'
	const onComplete = vi.fn()
	const onError = vi.fn()
	const scope = effectScope()
	scopes.push(scope)
	const microphone = scope.run(() => useSpeechRecording({
		capture: () => owner,
		isCurrent: original => owner === original,
		onComplete,
		onError,
		...limits,
	}))!
	return {
		microphone,
		scope,
		permission,
		stream,
		getUserMedia,
		stopTrack,
		onComplete,
		onError,
		changeOwner: () => { owner = 'next-account' },
	}
}

afterEach(() => {
	scopes.splice(0).forEach(scope => scope.stop())
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('speech recording ownership', () => {
	it.each([
		['NotAllowedError', 'permission'],
		['NotFoundError', 'no-device'],
		['NotReadableError', 'device'],
		['NotSupportedError', 'unsupported'],
		['Error', 'interrupted'],
	])('reports %s accurately and allows another recording attempt', async (name, expected) => {
		const h = setup()
		h.getUserMedia.mockRejectedValueOnce(new DOMException('Fixture capture failure', name))
		await h.microphone.start()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith(expected)
		expect(h.microphone.requesting.value).toBe(false)
		expect(h.microphone.recording.value).toBe(false)
		h.getUserMedia.mockResolvedValueOnce(h.stream)
		await h.microphone.start()
		expect(h.microphone.recording.value).toBe(true)
		h.microphone.cancel()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
	})

	it('releases acquired tracks when recorder initialization fails without reporting a permission denial', async () => {
		const h = setup()
		vi.spyOn(Recorder.prototype, 'start').mockImplementation(() => {
			throw new DOMException('Fixture encoder failure', 'NotSupportedError')
		})
		const pending = h.microphone.start()
		h.permission.resolve(h.stream)
		await pending
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('unsupported')
		expect(h.microphone.recording.value).toBe(false)
	})

	it('acquires the microphone once while permission is pending and stops late tracks after unmount', async () => {
		const h = setup()
		const first = h.microphone.start()
		await h.microphone.start()
		expect(h.getUserMedia).toHaveBeenCalledTimes(1)
		h.scope.stop()
		h.permission.resolve(h.stream)
		await first
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(Recorder.instances).toHaveLength(0)
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('discards permission and active recordings that belong to a previous account', async () => {
		const h = setup()
		const start = h.microphone.start()
		h.changeOwner()
		h.permission.resolve(h.stream)
		await start
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(Recorder.instances).toHaveLength(0)
		expect(h.onError).not.toHaveBeenCalled()
		h.scope.stop()
	})

	it('can cancel pending permission and start again without late permission stopping the new recorder', async () => {
		const h = setup()
		const next = deferred<MediaStream>()
		const stopNext = vi.fn()
		h.getUserMedia.mockReturnValueOnce(h.permission.promise).mockReturnValueOnce(next.promise)
		const first = h.microphone.start()
		h.microphone.cancel()
		expect(h.microphone.requesting.value).toBe(false)
		const second = h.microphone.start()
		next.resolve({getTracks: () => [{stop: stopNext}]} as unknown as MediaStream)
		await second
		h.permission.resolve(h.stream)
		await first
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(stopNext).not.toHaveBeenCalled()
		expect(h.microphone.recording.value).toBe(true)
		h.scope.stop()
		expect(stopNext).toHaveBeenCalledTimes(1)
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('returns the owned recorder MIME type and cleans up before accepting a new recording', async () => {
		const h = setup()
		const first = h.microphone.start()
		h.permission.resolve(h.stream)
		await first
		const recorder = Recorder.instances[0]
		recorder.ondataavailable?.({data: new Blob(['audio'])})
		h.microphone.stop()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onComplete).toHaveBeenCalledWith(expect.objectContaining({type: 'audio/mp4'}), 'recording.m4a', 'first-account')
		await h.microphone.start()
		expect(h.microphone.recording.value).toBe(true)
		recorder.onstop?.()
		expect(h.microphone.recording.value).toBe(true)
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		h.scope.stop()
		expect(h.stopTrack).toHaveBeenCalledTimes(2)
		expect(h.onComplete).toHaveBeenCalledTimes(1)
	})

	it('cancels an active microphone when its owner changes without transcribing into the next chat', async () => {
		vi.useFakeTimers()
		const h = setup()
		const start = h.microphone.start()
		h.permission.resolve(h.stream)
		await start
		h.changeOwner()
		vi.advanceTimersByTime(1000)
		expect(h.microphone.recording.value).toBe(false)
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onComplete).not.toHaveBeenCalled()
		h.scope.stop()
	})
})

describe('asynchronous speech recorder finalization', () => {
	async function start(limits: {maxSeconds?: number, maxBytes?: number} = {}) {
		const h = setup(limits, true)
		const pending = h.microphone.start()
		h.permission.resolve(h.stream)
		await pending
		return {
			...h,
			recorder: Recorder.instances[0] as DelayedRecorder,
		}
	}

	it('can stop pending permission without a late resolution opening the microphone', async () => {
		const h = setup({}, true)
		const pending = h.microphone.start()
		h.microphone.stop()
		expect(h.microphone.requesting.value).toBe(false)
		h.permission.resolve(h.stream)
		await pending
		expect(Recorder.instances).toHaveLength(0)
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('keeps repeated stop calls idempotent until final data and onstop arrive', async () => {
		const h = await start()
		h.recorder.emit('first ')
		h.microphone.stop()
		h.microphone.stop()
		expect(h.onComplete).not.toHaveBeenCalled()
		await h.microphone.start()
		expect(Recorder.instances).toHaveLength(1)
		expect(h.microphone.stopping.value).toBe(true)
		expect(h.recorder.stopCalls).toBe(1)
		h.recorder.finish('last')
		expect(h.microphone.stopping.value).toBe(false)
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onComplete).toHaveBeenCalledTimes(1)
		const [blob, filename, owner] = h.onComplete.mock.calls[0]
		expect(await blob.text()).toBe('first last')
		expect(blob.type).toBe('audio/mp4')
		expect(filename).toBe('recording.m4a')
		expect(owner).toBe('first-account')
	})

	it.each(['recording', 'stopping'])('releases cancelled %s tracks before final events and isolates the next session', async phase => {
		const h = await start()
		if (phase === 'stopping') h.microphone.stop()
		h.microphone.cancel()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.microphone.stopping.value).toBe(false)
		const stopNext = vi.fn()
		h.getUserMedia.mockResolvedValueOnce({getTracks: () => [{stop: stopNext}]} as unknown as MediaStream)
		await h.microphone.start()
		h.recorder.finish('discarded data')
		expect(h.microphone.recording.value).toBe(true)
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(stopNext).not.toHaveBeenCalled()
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(h.onError).not.toHaveBeenCalled()
		h.scope.stop()
		expect(stopNext).toHaveBeenCalledTimes(1)
	})

	it('measures real elapsed time after a delayed callback and stops at the duration limit', async () => {
		vi.useFakeTimers()
		const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
		const h = await start()
		now.mockReturnValue(181000)
		vi.advanceTimersByTime(1000)
		expect(h.microphone.elapsed.value).toBe(180)
		expect(h.recorder.stopCalls).toBe(1)
		expect(h.microphone.stopping.value).toBe(true)
		h.recorder.finish()
		expect(h.onComplete).toHaveBeenCalledTimes(1)
	})

	it('does not submit an empty final recording', async () => {
		const h = await start()
		h.microphone.stop()
		h.recorder.finish('')
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('empty')
	})

	it('rejects accumulated chunks over the byte budget and releases immediately', async () => {
		const h = await start({maxBytes: 8})
		h.recorder.emit('1234')
		h.recorder.emit('56789')
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.microphone.recording.value).toBe(false)
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('too-large')
		h.recorder.finish()
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(h.onError).toHaveBeenCalledTimes(1)
	})

	it('accepts the exact byte budget including the asynchronous final chunk', async () => {
		const h = await start({maxBytes: 8})
		h.recorder.emit('1234')
		h.microphone.stop()
		h.recorder.finish('5678')
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onComplete.mock.calls[0][0].size).toBe(8)
	})

	it('enforces the default budget when the final event alone exceeds 16 MiB', async () => {
		const h = await start()
		h.microphone.stop()
		h.recorder.emit('x'.repeat(16 * 1024 * 1024 + 1))
		h.recorder.onstop?.()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('too-large')
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('cleans recorder errors immediately without accepting later data', async () => {
		const h = await start()
		h.recorder.state = 'inactive'
		h.recorder.onerror?.()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('interrupted')
		h.recorder.finish()
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it.each(['cancel', 'stop'])('releases tracks if the recorder throws during %s', async method => {
		const h = await start()
		vi.spyOn(h.recorder, 'stop').mockImplementation(() => { throw new Error('recorder failure') })
		h.microphone[method as 'stop' | 'cancel']()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.microphone.recording.value).toBe(false)
		expect(h.microphone.stopping.value).toBe(false)
		if (method === 'stop') expect(h.onError).toHaveBeenCalledExactlyOnceWith('interrupted')
		else expect(h.onError).not.toHaveBeenCalled()
		h.recorder.finish()
		expect(h.onComplete).not.toHaveBeenCalled()
	})
})
