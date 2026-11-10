import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {effectScope, type EffectScope} from 'vue'
import {supportsLiveSpeechRecording, useLiveSpeechRecording} from './useLiveSpeechRecording'

const auth = vi.hoisted(() => ({id: 1, epoch: 0, token: 'first-token', expired: false, refresh: vi.fn()}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => auth.token,
	getTokenIdentity: () => ({id: auth.id, type: 1}),
	getAuthSessionEpoch: () => auth.epoch,
	isTokenExpired: () => auth.expired,
	refreshToken: () => auth.refresh(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
	return {promise, resolve, reject}
}

class NodeFixture {
	disconnect = vi.fn()
	connect(node: NodeFixture) { return node }
}

class ContextFixture {
	static instances: ContextFixture[] = []
	static resumeResult?: () => Promise<void>
	state = 'running'
	sampleRate = 48000
	onstatechange?: () => void
	audioWorklet = {addModule: vi.fn(async () => {})}
	destination = new NodeFixture()
	resume = vi.fn(() => ContextFixture.resumeResult?.() ?? Promise.resolve())
	close = vi.fn(async () => { this.state = 'closed' })
	constructor() { ContextFixture.instances.push(this) }
	createMediaStreamSource() { return new NodeFixture() }
	createGain() { return Object.assign(new NodeFixture(), {gain: {value: 1}}) }
}

class WorkletFixture extends NodeFixture {
	static instances: WorkletFixture[] = []
	port = {
		onmessage: undefined as undefined | ((event: {data: unknown}) => void),
		postMessage: vi.fn(),
	}
	constructor(public context: unknown, public name: string, public options: unknown) {
		super()
		WorkletFixture.instances.push(this)
	}
	emit(data: unknown) { this.port.onmessage?.({data}) }
	frame(bytes = 3200) { this.emit(new ArrayBuffer(bytes)) }
}

class SocketFixture {
	static OPEN = 1
	static instances: SocketFixture[] = []
	readyState = 0
	bufferedAmount = 0
	onopen?: () => void
	onmessage?: (event: {data: string}) => void
	onclose?: () => void
	onerror?: () => void
	sent: (string | ArrayBuffer)[] = []
	close = vi.fn(() => {
		this.readyState = 3
		this.onclose?.()
	})
	send = vi.fn((data: string | ArrayBuffer) => {
		if (this.readyState !== 1) throw new Error('Socket is closed')
		this.sent.push(data)
	})
	url: string
	constructor(url: string | URL) {
		this.url = String(url)
		SocketFixture.instances.push(this)
	}
	open() { this.readyState = 1; this.onopen?.() }
	event(event: unknown) { this.onmessage?.({data: JSON.stringify(event)}) }
	ready(overrides = {}) {
		this.event({
			type: 'ready',
			sample_rate: 16000,
			model: 'speech-fixture',
			endpoint: 'wss://speech.invalid/api-ws',
			max_seconds: 180,
			request_id: 'request-fixture',
			...overrides,
		})
	}
	done(text = 'Final confirmed text', overrides = {}) {
		this.event({
			type: 'done',
			text,
			elapsed_ms: 1000,
			first_text_ms: 50,
			audio_duration_ms: 100,
			finish_ms: 15,
			request_id: 'request-fixture',
			...overrides,
		})
	}
	commands() { return this.sent.filter((frame): frame is string => typeof frame === 'string').map(frame => JSON.parse(frame)) }
	audio() { return this.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer) }
}

const scopes: EffectScope[] = []

function setup() {
	let owner = 'first-chat'
	const permission = deferred<MediaStream>()
	const track = {stop: vi.fn(), onended: null, onmute: null}
	const stream = {getTracks: () => [track]} as unknown as MediaStream
	const getUserMedia = vi.fn(() => permission.promise)
	vi.stubGlobal('navigator', {mediaDevices: {getUserMedia}})
	const scope = effectScope()
	scopes.push(scope)
	const onComplete = vi.fn()
	const onError = vi.fn()
	const onTranscript = vi.fn()
	const recorder = scope.run(() => useLiveSpeechRecording({
		capture: () => owner,
		isCurrent: previous => previous === owner,
		connectionID: () => 'saved-speech-connection',
		onComplete,
		onError,
		onTranscript,
	}))!
	return {
		recorder,
		permission,
		track,
		stream,
		getUserMedia,
		scope,
		onComplete,
		onError,
		onTranscript,
		changeOwner: () => { owner = 'second-chat' },
	}
}

async function microtasks() {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function recording(ready = true) {
	const h = setup()
	const starting = h.recorder.start()
	h.permission.resolve(h.stream)
	await starting
	const socket = SocketFixture.instances[0]
	const node = WorkletFixture.instances[0]
	socket.open()
	if (ready) socket.ready()
	return {...h, socket, node}
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
	vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
	vi.stubGlobal('isSecureContext', true)
	vi.stubGlobal('AudioContext', ContextFixture)
	vi.stubGlobal('AudioWorkletNode', WorkletFixture)
	vi.stubGlobal('WebSocket', SocketFixture)
	ContextFixture.instances = []
	ContextFixture.resumeResult = undefined
	WorkletFixture.instances = []
	SocketFixture.instances = []
	auth.id = 1
	auth.epoch = 0
	auth.token = 'first-token'
	auth.expired = false
	auth.refresh.mockReset()
	window.API_URL = ''
})

afterEach(() => {
	scopes.splice(0).forEach(scope => scope.stop())
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('short live speech capture', () => {
	it('only selects implemented realtime protocols in a secure capable browser', () => {
		setup()
		expect(supportsLiveSpeechRecording('dashscope-asr')).toBe(true)
		expect(supportsLiveSpeechRecording('qwen-asr-realtime')).toBe(true)
		expect(supportsLiveSpeechRecording('openai-realtime')).toBe(false)
		expect(supportsLiveSpeechRecording('openai-transcription')).toBe(false)
		vi.stubGlobal('isSecureContext', false)
		expect(supportsLiveSpeechRecording('dashscope-asr')).toBe(false)
	})

	it('captures before upstream ready, then sends raw PCM at no more than 2x real time', async () => {
		const h = await recording(false)
		expect(h.recorder.recording.value).toBe(true)
		expect(h.recorder.stage.value).toBe('connecting')
		h.node.frame()
		h.node.frame()
		h.node.frame()
		expect(h.socket.audio()).toHaveLength(0)
		expect(h.recorder.bufferedSeconds.value).toBeCloseTo(.3)
		h.socket.ready()
		expect(h.socket.audio()).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(49)
		expect(h.socket.audio()).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(h.socket.audio()).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(50)
		expect(h.socket.audio()).toHaveLength(3)
		expect(h.socket.audio().map(frame => frame.byteLength)).toEqual([3200, 3200, 3200])
		expect(h.socket.commands()).toEqual([{
			action: 'start',
			token: 'first-token',
			connection_id: 'saved-speech-connection',
		}])
		expect(h.socket.url).toMatch(/\/api\/v2\/ai\/speech\/live$/)
		expect(h.socket.url).not.toContain('token')
	})

	it('starts PCM capture while a required token refresh is still pending', async () => {
		auth.expired = true
		const refresh = deferred<void>()
		auth.refresh.mockReturnValue(refresh.promise)
		const h = setup()
		const starting = h.recorder.start()
		h.permission.resolve(h.stream)
		await microtasks()
		expect(h.recorder.recording.value).toBe(true)
		expect(WorkletFixture.instances).toHaveLength(1)
		expect(SocketFixture.instances).toHaveLength(0)
		WorkletFixture.instances[0].frame()
		refresh.resolve()
		await starting
		const socket = SocketFixture.instances[0]
		socket.open()
		socket.ready()
		expect(socket.audio()).toHaveLength(1)
	})

	it('reports a rejected audio resume promptly and releases a late microphone grant', async () => {
		const resume = deferred<void>()
		ContextFixture.resumeResult = () => resume.promise
		const h = setup()
		const starting = h.recorder.start()
		resume.reject(new DOMException('Audio could not resume', 'InvalidStateError'))
		await microtasks()
		expect(h.recorder.requesting.value).toBe(false)
		expect(h.recorder.recording.value).toBe(false)
		expect(h.onError).toHaveBeenCalledWith('interrupted', '', 'first-chat')
		expect(ContextFixture.instances[0].close).toHaveBeenCalledTimes(1)
		h.permission.resolve(h.stream)
		await starting
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(WorkletFixture.instances).toHaveLength(0)
		expect(SocketFixture.instances).toHaveLength(0)
	})

	it('does not expose a cancelled resume failure to a later recording owner', async () => {
		const resume = deferred<void>()
		ContextFixture.resumeResult = () => resume.promise
		const h = setup()
		const starting = h.recorder.start()
		h.recorder.cancel()
		h.changeOwner()
		resume.reject(new DOMException('Old audio resume rejected', 'InvalidStateError'))
		h.permission.resolve(h.stream)
		await starting
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.onError).not.toHaveBeenCalled()
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(SocketFixture.instances).toHaveLength(0)
	})

	it('does not mark a suspended audio context as recording after resume resolves', async () => {
		ContextFixture.resumeResult = async () => { ContextFixture.instances[0].state = 'suspended' }
		const h = setup()
		const starting = h.recorder.start()
		h.permission.resolve(h.stream)
		await starting
		expect(h.recorder.recording.value).toBe(false)
		expect(h.onError).toHaveBeenCalledWith('interrupted', '', 'first-chat')
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(SocketFixture.instances).toHaveLength(0)
	})

	it('does not revive capture when a worklet module finishes loading after cancellation', async () => {
		const module = deferred<void>()
		const h = setup()
		const starting = h.recorder.start()
		ContextFixture.instances[0].audioWorklet.addModule.mockReturnValue(module.promise)
		h.permission.resolve(h.stream)
		await microtasks()
		h.recorder.cancel()
		module.resolve()
		await starting
		expect(WorkletFixture.instances).toHaveLength(0)
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(h.onError).not.toHaveBeenCalled()
	})

	it('reports denied permission accurately and allows a new explicit recording attempt', async () => {
		const h = setup()
		h.getUserMedia.mockRejectedValueOnce(new DOMException('Fixture permission denied', 'NotAllowedError'))
		await h.recorder.start()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('permission', '', 'first-chat')
		expect(ContextFixture.instances[0].close).toHaveBeenCalledTimes(1)
		h.getUserMedia.mockResolvedValueOnce(h.stream)
		await h.recorder.start()
		expect(h.recorder.recording.value).toBe(true)
		expect(WorkletFixture.instances).toHaveLength(1)
	})

	it('flushes the tail, releases the microphone, drains audio, sends stop once, and waits for done', async () => {
		const h = await recording()
		h.node.frame()
		h.node.frame()
		const stopped = h.recorder.stop()
		void h.recorder.stop()
		expect(h.recorder.stopping.value).toBe(true)
		expect(h.track.stop).not.toHaveBeenCalled()
		expect(h.node.port.postMessage.mock.calls.filter(([value]) => value === 'flush')).toHaveLength(1)
		expect(h.socket.commands()).toHaveLength(1)
		h.node.frame(800)
		h.node.emit('flushed')
		await microtasks()
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.recorder.stage.value).toBe('draining')
		expect(h.socket.close).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(100)
		expect(h.socket.audio().map(frame => frame.byteLength)).toEqual([3200, 3200, 800])
		expect(h.socket.commands()).toEqual([expect.objectContaining({action: 'start'}), {action: 'stop'}])
		expect(h.recorder.stage.value).toBe('finishing')
		expect(h.onComplete).not.toHaveBeenCalled()
		h.socket.done()
		await stopped
		expect(h.onComplete).toHaveBeenCalledExactlyOnceWith('Final confirmed text', {
			elapsed_ms: 1000,
			first_text_ms: 50,
			audio_duration_ms: 100,
			finish_ms: 15,
			request_id: 'request-fixture',
			model: 'speech-fixture',
			endpoint: 'wss://speech.invalid/api-ws',
		}, 'first-chat')
		expect(h.recorder.stopping.value).toBe(false)
		expect(h.socket.close).toHaveBeenCalledTimes(1)
	})

	it('finishes a short recording stopped before upstream ready without dropping its head or tail', async () => {
		const h = await recording(false)
		h.node.frame()
		const stopped = h.recorder.stop()
		h.node.frame(1600)
		h.node.emit('flushed')
		await microtasks()
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.socket.audio()).toHaveLength(0)
		h.socket.ready()
		await vi.advanceTimersByTimeAsync(100)
		expect(h.socket.audio().map(frame => frame.byteLength)).toEqual([3200, 1600])
		const commands = h.socket.commands()
		expect(commands[commands.length - 1]).toEqual({action: 'stop'})
		h.socket.done()
		await stopped
	})

	it('updates segments by ID, preserves committed segments, and never treats partial text as completion', async () => {
		const h = await recording()
		h.socket.event({type: 'transcript', id: 'one', text: 'First guess', final: false})
		h.socket.event({type: 'transcript', id: 'one', text: 'First sentence.', final: true})
		h.socket.event({type: 'transcript', id: 'one', text: 'Stale partial', final: false})
		h.socket.event({type: 'transcript', id: 'two', text: 'Unconfirmed continuation', final: false})
		expect(h.recorder.liveText.value).toBe('First sentence.\nUnconfirmed continuation')
		expect(h.recorder.partial.value).toBe('Unconfirmed continuation')
		expect(h.onComplete).not.toHaveBeenCalled()
		h.socket.close()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('network', '', 'first-chat')
		expect(h.recorder.liveText.value).toBe('First sentence.\nUnconfirmed continuation')
		expect(h.recorder.partial.value).toBe('Unconfirmed continuation')
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(20_000)
		expect(SocketFixture.instances).toHaveLength(1)
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('stops at a six-second pre-ready queue bound instead of accumulating the whole recording', async () => {
		const h = await recording(false)
		for (let i = 0; i < 60; i++) h.node.frame()
		expect(h.recorder.bufferedSeconds.value).toBe(6)
		expect(h.onError).not.toHaveBeenCalled()
		h.node.frame()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('buffer_full', '', 'first-chat')
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.recorder.recording.value).toBe(false)
		expect(h.socket.audio()).toHaveLength(0)
	})

	it('bounds the browser transport backlog together with the local queue', async () => {
		const h = await recording()
		h.socket.bufferedAmount = 16000 * 2 * 6
		h.node.frame()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('buffer_full', '', 'first-chat')
		expect(h.socket.audio()).toHaveLength(0)
	})

	it('fails rather than silently dropping a missing final worklet flush', async () => {
		const h = await recording()
		h.node.frame()
		const stopped = h.recorder.stop()
		await vi.advanceTimersByTimeAsync(1500)
		await stopped
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('finalize_timeout', '', 'first-chat')
		expect(h.track.stop).toHaveBeenCalledTimes(1)
		expect(h.socket.commands()).toHaveLength(1)
		expect(h.onComplete).not.toHaveBeenCalled()
	})

	it('times out a missing done without replaying or accepting an unconfirmed result', async () => {
		const h = await recording()
		h.node.frame()
		const stopped = h.recorder.stop()
		h.node.emit('flushed')
		await microtasks()
		await vi.advanceTimersByTimeAsync(30_000)
		await stopped
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('finalize_timeout', '', 'first-chat')
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(SocketFixture.instances).toHaveLength(1)
	})

	it('does not report empty authoritative completion as a successful dictation', async () => {
		const h = await recording()
		h.node.frame()
		const stopped = h.recorder.stop()
		h.node.emit('flushed')
		await microtasks()
		h.socket.done('  ')
		await stopped
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(h.onError).toHaveBeenCalledExactlyOnceWith('empty', '', 'first-chat')
	})

	it('clears private live text when the owner changes before the next callback', async () => {
		const h = await recording()
		h.socket.event({type: 'transcript', id: 'one', text: 'Private partial', final: false})
		expect(h.recorder.liveText.value).toBe('Private partial')
		h.changeOwner()
		await vi.advanceTimersByTimeAsync(250)
		expect(h.recorder.liveText.value).toBe('')
		expect(h.recorder.partial.value).toBe('')
		expect(h.onError).not.toHaveBeenCalled()
	})

	it.each(['sample-rate', 'request-id', 'unprompted-done', 'malformed-frame'])(
		'rejects a %s protocol violation and releases the microphone', async violation => {
			const h = await recording(false)
			if (violation === 'sample-rate') h.socket.ready({sample_rate: 24000})
			else {
				h.socket.ready()
				if (violation === 'request-id') {
					h.node.frame()
					void h.recorder.stop()
					h.node.emit('flushed')
					await microtasks()
					h.socket.done('Wrong request', {request_id: 'other-request'})
				} else if (violation === 'unprompted-done') h.socket.done()
				else h.socket.onmessage?.({data: 'not JSON'})
			}
			expect(h.onError).toHaveBeenCalledExactlyOnceWith('protocol', '', 'first-chat')
			expect(h.track.stop).toHaveBeenCalledTimes(1)
			expect(h.onComplete).not.toHaveBeenCalled()
		},
	)

	it('automatically finalizes at the real 180-second capture duration', async () => {
		const h = await recording()
		h.node.frame()
		await vi.advanceTimersByTimeAsync(180_000)
		expect(h.recorder.elapsed.value).toBe(180)
		expect(h.recorder.stopping.value).toBe(true)
		expect(h.node.port.postMessage).toHaveBeenCalledWith('flush')
		h.node.emit('flushed')
		await microtasks()
		h.socket.done()
		expect(h.onComplete).toHaveBeenCalledTimes(1)
	})

	it.each(['cancel', 'stop', 'unmount', 'owner', 'account', 'session', 'api'])(
		'discards late microphone permission after %s without starting capture', async change => {
			const h = setup()
			const starting = h.recorder.start()
			if (change === 'cancel') h.recorder.cancel()
			else if (change === 'stop') await h.recorder.stop()
			else if (change === 'unmount') h.scope.stop()
			else if (change === 'owner') h.changeOwner()
			else if (change === 'account') auth.id = 2
			else if (change === 'session') auth.epoch++
			else window.API_URL = 'https://other.invalid'
			h.permission.resolve(h.stream)
			await starting
			expect(h.track.stop).toHaveBeenCalledTimes(1)
			expect(WorkletFixture.instances).toHaveLength(0)
			expect(SocketFixture.instances).toHaveLength(0)
			expect(h.onComplete).not.toHaveBeenCalled()
			expect(h.onError).not.toHaveBeenCalled()
		},
	)

	it.each(['hidden', 'freeze', 'pagehide', 'owner', 'account', 'session', 'api'])(
		'cancels active capture on %s and ignores old transcripts', async change => {
			const h = await recording()
			if (change === 'hidden') {
				vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
				document.dispatchEvent(new Event('visibilitychange'))
			} else if (change === 'freeze') document.dispatchEvent(new Event('freeze'))
			else if (change === 'pagehide') window.dispatchEvent(new Event('pagehide'))
			else if (change === 'owner') h.changeOwner()
			else if (change === 'account') auth.id = 2
			else if (change === 'session') auth.epoch++
			else window.API_URL = 'https://other.invalid'
			h.socket.event({type: 'transcript', id: 'late', text: 'Never apply this', final: true})
			await vi.advanceTimersByTimeAsync(250)
			expect(h.track.stop).toHaveBeenCalledTimes(1)
			expect(h.recorder.recording.value).toBe(false)
			expect(h.onTranscript).not.toHaveBeenCalled()
			expect(h.onComplete).not.toHaveBeenCalled()
			expect(h.onError).not.toHaveBeenCalled()
		},
	)

	it('cancels pending finalization immediately and isolates a later recording from old worklet events', async () => {
		const h = await recording()
		h.node.frame()
		const stopped = h.recorder.stop()
		h.recorder.cancel()
		await stopped
		h.getUserMedia.mockResolvedValue(h.stream)
		await h.recorder.start()
		const socket = SocketFixture.instances[1]
		socket.open()
		socket.ready()
		h.node.frame()
		h.node.emit('flushed')
		h.socket.done('Old completion')
		expect(h.recorder.recording.value).toBe(true)
		expect(h.onComplete).not.toHaveBeenCalled()
		expect(socket.commands()).toHaveLength(1)
	})
})
