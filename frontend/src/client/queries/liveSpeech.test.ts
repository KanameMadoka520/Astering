import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {captureClientRequestContext} from '@/client/requestContext'
import {openLiveSpeechSocket} from './liveSpeech'

const auth = vi.hoisted(() => ({
	id: 1,
	epoch: 0,
	token: 'first-token',
	expired: vi.fn(),
	refresh: vi.fn(),
}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => auth.token,
	getTokenIdentity: () => ({id: auth.id, type: 1}),
	getAuthSessionEpoch: () => auth.epoch,
	isTokenExpired: (...args: unknown[]) => auth.expired(...args),
	refreshToken: (...args: unknown[]) => auth.refresh(...args),
}))

class SocketFixture {
	static instances: SocketFixture[] = []
	onopen?: () => void
	onmessage?: (message: {data: unknown}) => void
	onclose?: () => void
	onerror?: () => void
	send = vi.fn()
	close = vi.fn()
	url: string
	constructor(url: string | URL) {
		this.url = String(url)
		SocketFixture.instances.push(this)
	}
}

function setup() {
	let current = true
	const onEvent = vi.fn()
	const onClose = vi.fn()
	const context = captureClientRequestContext()
	return {
		options: {
			context,
			connectionID: 'saved-connection',
			isCurrent: () => current,
			onEvent,
			onClose,
		},
		onEvent,
		onClose,
		cancel: () => { current = false },
	}
}

beforeEach(() => {
	SocketFixture.instances = []
	vi.stubGlobal('WebSocket', SocketFixture)
	window.API_URL = 'https://astering-speech.invalid/api/v2'
	auth.id = 1
	auth.epoch = 0
	auth.token = 'first-token'
	auth.expired.mockReset().mockReturnValue(false)
	auth.refresh.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllGlobals())

describe('authenticated short speech socket', () => {
	it('uses the captured API destination and authenticates only in the first frame', async () => {
		const h = setup()
		await openLiveSpeechSocket(h.options)
		const socket = SocketFixture.instances[0]
		expect(socket.url).toBe('wss://astering-speech.invalid/api/v2/ai/speech/live')
		expect(auth.expired).toHaveBeenCalledWith('first-token', 240)
		expect(socket.send).not.toHaveBeenCalled()
		socket.onopen?.()
		expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
			action: 'start',
			token: 'first-token',
			connection_id: 'saved-connection',
		}))
	})

	it('uses the refreshed token without changing the original owner', async () => {
		auth.expired.mockReturnValue(true)
		auth.refresh.mockImplementation(async () => { auth.token = 'fresh-token' })
		await openLiveSpeechSocket(setup().options)
		SocketFixture.instances[0].onopen?.()
		expect(auth.refresh).toHaveBeenCalledWith(true)
		expect(JSON.parse(SocketFixture.instances[0].send.mock.calls[0][0]).token).toBe('fresh-token')
	})

	it.each(['account', 'session', 'api', 'owner'])(
		'does not create a socket when %s changes while refresh is pending', async change => {
			let resolve!: () => void
			auth.expired.mockReturnValue(true)
			auth.refresh.mockReturnValue(new Promise<void>(done => { resolve = done }))
			const h = setup()
			const pending = openLiveSpeechSocket(h.options)
			const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'})
			if (change === 'account') auth.id = 2
			else if (change === 'session') auth.epoch++
			else if (change === 'api') window.API_URL = 'https://different.invalid'
			else h.cancel()
			resolve()
			await rejected
			expect(SocketFixture.instances).toHaveLength(0)
		},
	)

	it.each(['account', 'session', 'api', 'owner'])(
		'cannot send credentials after %s changes before socket open', async change => {
			const h = setup()
			await openLiveSpeechSocket(h.options)
			const socket = SocketFixture.instances[0]
			if (change === 'account') auth.id = 2
			else if (change === 'session') auth.epoch++
			else if (change === 'api') window.API_URL = 'https://different.invalid'
			else h.cancel()
			socket.onopen?.()
			expect(socket.send).not.toHaveBeenCalled()
			expect(socket.close).toHaveBeenCalledTimes(1)
		},
	)

	it('drops a transcript after an authentication session change', async () => {
		const h = setup()
		await openLiveSpeechSocket(h.options)
		auth.epoch++
		SocketFixture.instances[0].onmessage?.({data: JSON.stringify({
			type: 'transcript',
			id: 'one',
			text: 'Private prior-session text',
			final: true,
		})})
		expect(h.onEvent).not.toHaveBeenCalled()
		expect(SocketFixture.instances[0].close).toHaveBeenCalledTimes(1)
	})

	it.each(['not JSON', '{"type":"unknown"}', 'x'.repeat(256 * 1024 + 1), new ArrayBuffer(4)])(
		'reports a bounded protocol error for an invalid event', async data => {
			const h = setup()
			await openLiveSpeechSocket(h.options)
			SocketFixture.instances[0].onmessage?.({data})
			expect(h.onEvent).toHaveBeenCalledExactlyOnceWith({type: 'error', code: 'protocol'})
		},
	)
})
