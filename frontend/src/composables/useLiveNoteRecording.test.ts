import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {effectScope, type EffectScope} from 'vue'
import {useLiveNoteRecording} from './useLiveNoteRecording'

const auth = vi.hoisted(() => ({id: 1, type: 1, epoch: 0, token: 'first-token', expired: false, refresh: vi.fn()}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => auth.token,
	getTokenIdentity: () => ({id: auth.id, type: auth.type}),
	getAuthSessionEpoch: () => auth.epoch,
	isTokenExpired: () => auth.expired,
	refreshToken: () => auth.refresh(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

class AudioNodeFixture {
	disconnect = vi.fn()
	connect(node: unknown) { return node as AudioNodeFixture }
}
class AudioContextFixture {
	static instances: AudioContextFixture[] = []
	state = 'running'
	sampleRate = 48000
	audioWorklet = {addModule: vi.fn(async () => {})}
	destination = new AudioNodeFixture()
	resume = vi.fn(async () => {})
	close = vi.fn(async () => { this.state = 'closed' })
	createMediaStreamSource = vi.fn(() => new AudioNodeFixture())
	createGain = vi.fn(() => Object.assign(new AudioNodeFixture(), {gain: {value: 1}}))
	constructor() { AudioContextFixture.instances.push(this) }
}
class WorkletFixture extends AudioNodeFixture {
	static instances: WorkletFixture[] = []
	flushFrames: ArrayBuffer[] = []
	autoFlush = true
	port = {
		onmessage: null as ((event: {data: ArrayBuffer | string}) => void) | null,
		postMessage: vi.fn((message: string) => {
			if (message !== 'flush' || !this.autoFlush) return
			this.flushFrames.forEach(frame => this.frame(frame))
			this.port.onmessage?.({data: 'flushed'})
		}),
	}
	constructor() { super(); WorkletFixture.instances.push(this) }
	frame(data = new ArrayBuffer(3200)) { this.port.onmessage?.({data}) }
}
class SocketFixture {
	static OPEN = 1
	static CONNECTING = 0
	static instances: SocketFixture[] = []
	readyState = 0
	bufferedAmount = 0
	onopen: (() => void) | null = null
	onmessage: ((event: MessageEvent) => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null
	send = vi.fn<(data: string | ArrayBuffer) => void>()
	close = vi.fn(() => { this.readyState = 3; this.onclose?.() })
	constructor(public url: URL) { SocketFixture.instances.push(this) }
	open() { this.readyState = SocketFixture.OPEN; this.onopen?.() }
	event(data: object) { this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(data)})) }
	ready(offset = 0, seconds = 420) {
		this.event({type: 'ready', sample_rate: 16000, offset_ms: offset, rotate_seconds: seconds, model: 'speech-model', endpoint: 'wss://speech.example/api'})
	}
	commands() { return this.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null).filter(Boolean) }
	frames() { return this.send.mock.calls.map(([data]) => data).filter(data => data instanceof ArrayBuffer) }
}

const scopes: EffectScope[] = []
async function microtasks() {
	for (let index = 0; index < 12; index++) await Promise.resolve()
}
type RecordingPreferences = {
	allowBackground?: () => boolean,
	keepAwake?: () => boolean,
	wakeLock?: {
		request: (type: 'screen') => Promise<WakeLockSentinel>,
	},
}

class WakeLockFixture extends EventTarget {
	readonly type = 'screen'
	released = false
	release = vi.fn(async () => {
		this.released = true
		this.dispatchEvent(new Event('release'))
	})

	sentinel() {
		return this as unknown as WakeLockSentinel
	}
}

function setup(preferences: RecordingPreferences = {}) {
	const stopTrack = vi.fn()
	const track = {stop: stopTrack, onended: null, onmute: null}
	const stream = {getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream
	const permission = deferred<MediaStream>()
	const getUserMedia = vi.fn(() => permission.promise)
	vi.stubGlobal('navigator', {
		mediaDevices: {getUserMedia},
		wakeLock: preferences.wakeLock,
	})
	const onSegment = vi.fn()
	const scope = effectScope()
	scopes.push(scope)
	const recorder = scope.run(() => useLiveNoteRecording({
		noteID: () => 4,
		connectionID: () => 'speech-connection',
		sampleRate: () => 16000,
		language: () => 'zh-CN',
		allowBackground: preferences.allowBackground,
		keepAwake: preferences.keepAwake,
		onSegment,
	}))!
	return {recorder, scope, permission, stream, stopTrack, getUserMedia, onSegment}
}
async function recording(seconds = 420, preferences: RecordingPreferences = {}) {
	const h = setup(preferences)
	const start = h.recorder.start()
	h.permission.resolve(h.stream)
	await start
	const socket = SocketFixture.instances[0]
	socket.open()
	socket.ready(0, seconds)
	await microtasks()
	return {...h, socket, node: WorkletFixture.instances[0]}
}
function frame(node: WorkletFixture, milliseconds = 100) {
	vi.advanceTimersByTime(milliseconds)
	node.frame()
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
	vi.stubGlobal('AudioContext', AudioContextFixture)
	vi.stubGlobal('AudioWorkletNode', WorkletFixture)
	vi.stubGlobal('WebSocket', SocketFixture)
	AudioContextFixture.instances = []
	WorkletFixture.instances = []
	SocketFixture.instances = []
	auth.id = 1
	auth.type = 1
	auth.epoch = 0
	auth.token = 'first-token'
	auth.expired = false
	auth.refresh.mockReset().mockResolvedValue(undefined)
	window.API_URL = 'https://notes.example'
})
afterEach(async () => {
	scopes.splice(0).forEach(scope => scope.stop())
	// Teardown must not leave an outstanding finalization timer or microphone behind.
	await microtasks()
	vi.advanceTimersByTime(41_000)
	await microtasks()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('live note microphone ownership', () => {
	it('stops late permission after explicit cancellation and never opens a socket', async () => {
		const h = setup()
		const first = h.recorder.start()
		await h.recorder.start()
		expect(h.getUserMedia).toHaveBeenCalledTimes(1)
		await h.recorder.stop()
		expect(h.recorder.state.value).toBe('idle')
		h.permission.resolve(h.stream)
		await first
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(SocketFixture.instances).toHaveLength(0)
		expect(h.onSegment).not.toHaveBeenCalled()
	})

	it.each(['unmount', 'account', 'session', 'api'])('discards late permission after %s changes', async change => {
		const h = setup()
		const pending = h.recorder.start()
		if (change === 'unmount') h.scope.stop()
		else if (change === 'account') auth.id = 2
		else if (change === 'session') auth.epoch++
		else window.API_URL = 'https://other.example'
		h.permission.resolve(h.stream)
		await pending
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(SocketFixture.instances).toHaveLength(0)
		expect(h.onSegment).not.toHaveBeenCalled()
	})

	it('reports unsupported capture when AudioContext construction throws', async () => {
		const h = setup()
		vi.stubGlobal('AudioContext', class { constructor() { throw new Error('audio unavailable') } })
		await expect(h.recorder.start()).resolves.toBeUndefined()
		expect(h.recorder.error.value).toBe('unsupported')
		expect(h.recorder.active.value).toBe(false)
		expect(h.getUserMedia).not.toHaveBeenCalled()
	})

	it.each(['account', 'session', 'api'])('cancels active audio after %s changes without adopting a new credential', async change => {
		const h = await recording()
		frame(h.node)
		if (change === 'account') auth.id = 2
		else if (change === 'session') auth.epoch++
		else window.API_URL = 'https://other.example'
		auth.token = 'new-account-token'
		h.socket.event({type: 'segment', id: 'stale', segment: {id: 1, note_id: 4, text: 'old account'}})
		h.socket.onerror?.()
		vi.advanceTimersByTime(1000)
		expect(h.recorder.active.value).toBe(false)
		expect(h.stopTrack).toHaveBeenCalled()
		expect(h.onSegment).not.toHaveBeenCalled()
		expect(SocketFixture.instances).toHaveLength(1)
		expect(h.socket.commands().map(command => command.token).filter(Boolean)).toEqual(['first-token'])
	})

	it('does not send an original request using a token refreshed into another account', async () => {
		const refreshing = deferred<void>()
		auth.expired = true
		auth.refresh.mockReturnValue(refreshing.promise)
		const h = setup()
		const pending = h.recorder.start()
		h.permission.resolve(h.stream)
		await microtasks()
		expect(auth.refresh).toHaveBeenCalledTimes(1)
		auth.id = 2
		auth.token = 'other-account-token'
		refreshing.resolve()
		await pending
		expect(SocketFixture.instances).toHaveLength(0)
		expect(h.stopTrack).toHaveBeenCalled()
	})
})

describe('live PCM finalization and rotation', () => {
	it('sends PCM before stopping, flushes the last frame, and waits for committed segments plus done', async () => {
		const h = await recording()
		expect(h.socket.url.toString()).toBe('wss://notes.example/api/v2/notes/live')
		expect(h.socket.url.search).toBe('')
		expect(h.socket.commands()).toEqual([{action: 'start', token: 'first-token', note_id: 4, connection_id: 'speech-connection', offset_ms: 0, language: 'zh-CN'}])
		frame(h.node)
		expect(h.socket.frames()).toHaveLength(1)
		expect(h.socket.commands()).toHaveLength(1)
		h.socket.event({type: 'partial', id: 'utterance', text: 'temporary'})
		expect(h.recorder.partial.value).toBe('temporary')
		h.node.flushFrames.push(new ArrayBuffer(1600))
		const stopping = h.recorder.stop()
		await microtasks()
		vi.advanceTimersByTime(100)
		expect(h.socket.frames().map(data => (data as ArrayBuffer).byteLength)).toEqual([3200, 1600])
		expect(h.socket.commands().at(-1)).toEqual({action: 'stop'})
		expect(h.recorder.state.value).toBe('stopping')
		expect(h.onSegment).not.toHaveBeenCalled()
		const segment = {id: 9, note_id: 4, text: 'durable final', start_ms: 0, end_ms: 150}
		const stats = {segment_count: 1, transcript_bytes: 13, updated: '2026-11-08T12:00:00Z'}
		h.socket.event({type: 'segment', id: 'utterance', segment, stats})
		expect(h.onSegment).toHaveBeenCalledExactlyOnceWith({segment, stats})
		expect(h.recorder.partial.value).toBe('')
		expect(h.recorder.active.value).toBe(true)
		h.socket.event({type: 'done'})
		await stopping
		expect(h.recorder.state.value).toBe('idle')
		expect(h.recorder.savedSegments.value).toBe(1)
		expect(h.recorder.sentBytes.value).toBe(4800)
		expect(h.stopTrack).toHaveBeenCalled()
		expect(AudioContextFixture.instances[0].close).toHaveBeenCalled()
	})

	it('keeps recording through two actual seven-minute provider rotations and ignores the previous wire', async () => {
		const h = await recording()
		let socket = h.socket
		for (let cycle = 0; cycle < 2; cycle++) {
			const pendingFrames = cycle === 0 ? 0 : 1
			for (let index = pendingFrames; index < 4200; index++) frame(h.node)
			expect(h.recorder.state.value).toBe('reconnecting')
			expect(socket.frames()).toHaveLength(4200)
			expect(socket.commands().at(-1)).toEqual({action: 'stop'})
			// The microphone remains live while the old provider flushes its last utterance.
			frame(h.node)
			expect(h.recorder.bufferedSeconds.value).toBeCloseTo(0.1)
			expect(h.stopTrack).not.toHaveBeenCalled()
			auth.token = `refreshed-same-session-${cycle}`
			socket.event({type: 'segment', id: `cycle-${cycle}`, segment: {id: cycle + 1, note_id: 4, text: 'persisted'}})
			socket.event({type: 'done'})
			await microtasks()
			const previous = socket
			socket = SocketFixture.instances[cycle + 1]
			socket.open()
			expect(socket.commands()[0]).toMatchObject({token: auth.token, note_id: 4, offset_ms: (cycle + 1) * 420_000})
			socket.ready((cycle + 1) * 420_000)
			await microtasks()
			previous.onerror?.()
			previous.event({type: 'error', code: 'provider', message: 'late old socket failure'})
			previous.event({type: 'partial', id: 'old', text: 'stale'})
			previous.event({type: 'done'})
			expect(h.recorder.error.value).toBe('')
			expect(h.recorder.state.value).toBe('recording')
			expect(SocketFixture.instances).toHaveLength(cycle + 2)
			expect(h.recorder.partial.value).toBe('')
		}
		expect(h.recorder.elapsed.value).toBeCloseTo(840.1)
		expect(WorkletFixture.instances).toHaveLength(1)
		expect(h.onSegment).toHaveBeenCalledTimes(2)
		const stopping = h.recorder.stop()
		await microtasks()
		vi.advanceTimersByTime(100)
		socket.event({type: 'done'})
		await stopping
		expect(h.recorder.state.value).toBe('idle')
	})

	it('flushes the original note on unmount and never reconnects after done', async () => {
		const h = await recording()
		frame(h.node)
		h.node.flushFrames.push(new ArrayBuffer(800))
		h.scope.stop()
		await microtasks()
		vi.advanceTimersByTime(100)
		expect(h.socket.frames()).toHaveLength(2)
		expect(h.socket.commands().at(-1)).toEqual({action: 'stop'})
		h.socket.event({type: 'segment', id: 'last', segment: {id: 8, note_id: 4, text: 'saved after leaving'}})
		h.socket.event({type: 'done'})
		await microtasks()
		expect(SocketFixture.instances).toHaveLength(1)
		expect(h.recorder.active.value).toBe(false)
		expect(h.stopTrack).toHaveBeenCalled()
	})

	it('finishes an empty recording stopped while the upstream handshake is still pending', async () => {
		const h = setup()
		const starting = h.recorder.start()
		h.permission.resolve(h.stream)
		await starting
		const socket = SocketFixture.instances[0]
		socket.open()
		const stopping = h.recorder.stop()
		await microtasks()
		expect(h.recorder.state.value).toBe('stopping')
		expect(h.stopTrack).toHaveBeenCalled()
		socket.ready()
		expect(socket.commands().at(-1)).toEqual({action: 'stop'})
		expect(WorkletFixture.instances).toHaveLength(0)
		socket.event({type: 'done'})
		await stopping
		expect(h.recorder.state.value).toBe('idle')
		expect(h.onSegment).not.toHaveBeenCalled()
	})

	it('releases the microphone when a disconnect makes a PCM send throw', async () => {
		const h = await recording()
		h.socket.send.mockImplementationOnce(() => { throw new DOMException('socket is closing', 'InvalidStateError') })
		frame(h.node)
		expect(h.recorder.error.value).toBe('network')
		expect(h.recorder.state.value).toBe('paused')
		expect(h.recorder.active.value).toBe(false)
		expect(h.stopTrack).toHaveBeenCalled()
	})

	it('stops rather than accumulating more than five seconds of audio during an upstream stall', async () => {
		const h = await recording(30)
		for (let index = 0; index < 300; index++) frame(h.node)
		expect(h.recorder.state.value).toBe('reconnecting')
		for (let index = 0; index < 50; index++) frame(h.node)
		expect(h.recorder.bufferedSeconds.value).toBe(5)
		frame(h.node)
		expect(h.recorder.state.value).toBe('paused')
		expect(h.recorder.error.value).toBe('buffer_full')
		expect(h.recorder.bufferedSeconds.value).toBe(0)
		expect(h.socket.frames()).toHaveLength(300)
		expect(h.stopTrack).toHaveBeenCalled()
	})

	it('times out an unacknowledged stop and preserves a failed-save final for recovery', async () => {
		const h = await recording()
		h.socket.event({type: 'partial', id: 'one', text: 'outdated partial'})
		h.socket.event({type: 'error', code: 'save_failed', text: 'exact final not saved'})
		expect(h.recorder.partial.value).toBe('exact final not saved')
		expect(h.recorder.error.value).toBe('save_failed')
		expect(h.recorder.state.value).toBe('paused')
		expect(h.onSegment).not.toHaveBeenCalled()
		await h.recorder.start()
		const socket = SocketFixture.instances[1]
		socket.open()
		socket.ready()
		await microtasks()
		const stopping = h.recorder.stop()
		await microtasks()
		vi.advanceTimersByTime(40_000)
		await stopping
		expect(h.recorder.error.value).toBe('finalize_timeout')
		expect(h.recorder.active.value).toBe(false)
	})

	it('rejects premature done and malformed rotation metadata instead of restarting capture', async () => {
		const h = await recording()
		h.socket.event({type: 'done'})
		await microtasks()
		expect(h.recorder.error.value).toBe('protocol')
		expect(SocketFixture.instances).toHaveLength(1)
		await h.recorder.start()
		const socket = SocketFixture.instances[1]
		socket.open()
		socket.event({type: 'ready', sample_rate: 16000, offset_ms: 0, model: 'model', endpoint: 'endpoint'})
		expect(h.recorder.error.value).toBe('protocol')
		expect(h.recorder.active.value).toBe(false)
	})
})


describe('long recording background and screen ownership', () => {
	it('acknowledges accepted PCM once and never acknowledges stale or non-audio messages', async () => {
		const h = await recording()
		frame(h.node)
		frame(h.node)
		expect(h.node.port.postMessage.mock.calls.filter(([message]) => message === 'ack')).toHaveLength(2)
		h.node.port.onmessage?.({data: 'unexpected-control-message'})
		expect(h.node.port.postMessage.mock.calls.filter(([message]) => message === 'ack')).toHaveLength(2)
		auth.epoch++
		frame(h.node)
		expect(h.node.port.postMessage.mock.calls.filter(([message]) => message === 'ack')).toHaveLength(2)
		expect(h.socket.frames()).toHaveLength(2)
	})

	it('pauses hidden documents by default and does not automatically restart when visible', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const h = await recording()
		frame(h.node)
		hidden.mockReturnValue(true)
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(h.recorder.state.value).toBe('stopping')
		expect(h.recorder.error.value).toBe('background')
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.socket.commands().at(-1)).toEqual({action: 'stop'})
		h.socket.event({type: 'done'})
		await microtasks()
		expect(h.recorder.state.value).toBe('paused')
		hidden.mockReturnValue(false)
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(SocketFixture.instances).toHaveLength(1)
		expect(h.recorder.active.value).toBe(false)
	})

	it('continues capturing and uploading while hidden only after explicit opt-in', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const h = await recording(420, {allowBackground: () => true})
		frame(h.node)
		hidden.mockReturnValue(true)
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		frame(h.node)
		frame(h.node)
		expect(h.recorder.state.value).toBe('recording')
		expect(h.recorder.error.value).toBe('')
		expect(h.stopTrack).not.toHaveBeenCalled()
		expect(h.socket.frames()).toHaveLength(3)
		expect(h.socket.commands()).toHaveLength(1)
		expect(h.recorder.elapsed.value).toBeCloseTo(0.3)
		hidden.mockReturnValue(false)
		document.dispatchEvent(new Event('visibilitychange'))
		const stopping = h.recorder.stop()
		await microtasks()
		h.socket.event({type: 'done'})
		await stopping
		expect(h.recorder.state.value).toBe('idle')
	})

	it.each(['freeze', 'pagehide'])('still stops for %s even when background capture was allowed', async event => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const h = await recording(420, {allowBackground: () => true})
		frame(h.node)
		const target = event === 'freeze' ? document : window
		target.dispatchEvent(new Event(event))
		await microtasks()
		expect(h.stopTrack).toHaveBeenCalledTimes(1)
		expect(h.socket.commands().at(-1)).toEqual({action: 'stop'})
		expect(h.recorder.error.value).toBe('background')
		h.socket.event({type: 'done'})
		await microtasks()
		expect(h.recorder.state.value).toBe('paused')
		expect(SocketFixture.instances).toHaveLength(1)
	})

	it('does not request a screen lock unless the user opts in', async () => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const request = vi.fn(async () => new WakeLockFixture().sentinel())
		const h = await recording(420, {wakeLock: {request}})
		expect(request).not.toHaveBeenCalled()
		expect(h.recorder.screenAwake.value).toBe(false)
		expect(h.recorder.state.value).toBe('recording')
	})

	it('adopts an active screen lock, observes browser release, and reacquires only when visible', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const first = new WakeLockFixture()
		const second = new WakeLockFixture()
		const request = vi.fn()
			.mockResolvedValueOnce(first.sentinel())
			.mockResolvedValueOnce(second.sentinel())
		const h = await recording(420, {
			allowBackground: () => true,
			keepAwake: () => true,
			wakeLock: {request},
		})
		expect(request).toHaveBeenCalledExactlyOnceWith('screen')
		expect(h.recorder.screenAwake.value).toBe(true)
		hidden.mockReturnValue(true)
		document.dispatchEvent(new Event('visibilitychange'))
		await first.release()
		expect(h.recorder.screenAwake.value).toBe(false)
		expect(request).toHaveBeenCalledTimes(1)
		hidden.mockReturnValue(false)
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(request).toHaveBeenCalledTimes(2)
		expect(h.recorder.screenAwake.value).toBe(true)
		const stopping = h.recorder.stop()
		await microtasks()
		expect(second.release).toHaveBeenCalledTimes(1)
		expect(h.recorder.screenAwake.value).toBe(false)
		h.socket.event({type: 'done'})
		await stopping
	})

	it('does not enqueue duplicate screen-lock requests while a grant is pending', async () => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const grant = deferred<WakeLockSentinel>()
		const request = vi.fn(() => grant.promise)
		const h = await recording(420, {
			keepAwake: () => true,
			wakeLock: {request},
		})
		for (let index = 0; index < 3; index++) document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(request).toHaveBeenCalledTimes(1)
		const lock = new WakeLockFixture()
		grant.resolve(lock.sentinel())
		await microtasks()
		expect(h.recorder.screenAwake.value).toBe(true)
	})

	it('snapshots background and screen preferences until the next manual recording', async () => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		let allowed = true
		const grant = deferred<WakeLockSentinel>()
		const request = vi.fn(() => grant.promise)
		const h = await recording(420, {
			allowBackground: () => allowed,
			keepAwake: () => allowed,
			wakeLock: {request},
		})
		// A background account refresh must not change an already started capture.
		allowed = false
		const lock = new WakeLockFixture()
		grant.resolve(lock.sentinel())
		await microtasks()
		expect(h.recorder.screenAwake.value).toBe(true)
		hidden.mockReturnValue(true)
		document.dispatchEvent(new Event('visibilitychange'))
		expect(h.recorder.state.value).toBe('recording')
		hidden.mockReturnValue(false)
		const stopping = h.recorder.stop()
		await microtasks()
		h.socket.event({type: 'done'})
		await stopping
		await h.recorder.start()
		const second = SocketFixture.instances[1]
		second.open()
		second.ready()
		await microtasks()
		expect(request).toHaveBeenCalledTimes(1)
		hidden.mockReturnValue(true)
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(h.recorder.state.value).toBe('stopping')
		expect(h.recorder.error.value).toBe('background')
		second.event({type: 'done'})
		await microtasks()
	})

	it.each(['hidden', 'released', 'account', 'session', 'api'])('does not adopt a late screen-lock grant after %s changes', async change => {
		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const grant = deferred<WakeLockSentinel>()
		const request = vi.fn(() => grant.promise)
		const h = await recording(420, {
			allowBackground: () => true,
			keepAwake: () => true,
			wakeLock: {request},
		})
		expect(request).toHaveBeenCalledTimes(1)
		const lock = new WakeLockFixture()
		if (change === 'hidden') {
			hidden.mockReturnValue(true)
			document.dispatchEvent(new Event('visibilitychange'))
		} else if (change === 'released') lock.released = true
		else if (change === 'account') auth.id = 2
		else if (change === 'session') auth.epoch++
		else window.API_URL = 'https://another-notes.example'
		grant.resolve(lock.sentinel())
		await microtasks()
		expect(h.recorder.screenAwake.value).toBe(false)
		if (change !== 'released') expect(lock.release).toHaveBeenCalledTimes(1)
		if (change === 'hidden' || change === 'released') {
			expect(h.recorder.state.value).toBe('recording')
			expect(h.stopTrack).not.toHaveBeenCalled()
		}
	})

	it('releases an old late grant without replacing the screen lock of the next recording', async () => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const grant = deferred<WakeLockSentinel>()
		const first = new WakeLockFixture()
		const second = new WakeLockFixture()
		const request = vi.fn()
			.mockReturnValueOnce(grant.promise)
			.mockResolvedValueOnce(second.sentinel())
		const h = await recording(420, {
			keepAwake: () => true,
			wakeLock: {request},
		})
		const stopping = h.recorder.stop()
		await microtasks()
		h.socket.event({type: 'done'})
		await stopping
		await h.recorder.start()
		const socket = SocketFixture.instances[1]
		socket.open()
		socket.ready()
		await microtasks()
		expect(h.recorder.screenAwake.value).toBe(true)
		expect(request).toHaveBeenCalledTimes(2)
		grant.resolve(first.sentinel())
		await microtasks()
		expect(first.release).toHaveBeenCalledTimes(1)
		expect(second.release).not.toHaveBeenCalled()
		expect(h.recorder.screenAwake.value).toBe(true)
		expect(h.recorder.state.value).toBe('recording')
	})

	it('keeps recording after a denied screen lock and allows a later visible retry', async () => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
		const lock = new WakeLockFixture()
		const request = vi.fn()
			.mockRejectedValueOnce(new DOMException('Screen lock denied', 'NotAllowedError'))
			.mockResolvedValueOnce(lock.sentinel())
		const h = await recording(420, {
			keepAwake: () => true,
			wakeLock: {request},
		})
		expect(h.recorder.screenAwake.value).toBe(false)
		expect(h.recorder.state.value).toBe('recording')
		expect(h.recorder.error.value).toBe('')
		document.dispatchEvent(new Event('visibilitychange'))
		await microtasks()
		expect(request).toHaveBeenCalledTimes(2)
		expect(h.recorder.screenAwake.value).toBe(true)
	})
})
