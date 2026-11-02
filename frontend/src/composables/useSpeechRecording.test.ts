import {afterEach, describe, expect, it, vi} from 'vitest'
import {effectScope} from 'vue'
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
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}
function setup() {
	const stopTrack = vi.fn()
	const stream = {getTracks: () => [{stop: stopTrack}]} as unknown as MediaStream
	const permission = deferred<MediaStream>()
	const getUserMedia = vi.fn(() => permission.promise)
	vi.stubGlobal('navigator', {mediaDevices: {getUserMedia}})
	vi.stubGlobal('MediaRecorder', Recorder)
	Recorder.instances = []
	let owner = 'first-account'
	const onComplete = vi.fn()
	const onError = vi.fn()
	const scope = effectScope()
	const microphone = scope.run(() => useSpeechRecording({
		capture: () => owner,
		isCurrent: original => owner === original,
		onComplete, onError,
	}))!
	return {microphone, scope, permission, stream, getUserMedia, stopTrack, onComplete, onError,
		changeOwner: () => { owner = 'next-account' }}
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('speech recording ownership', () => {
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
