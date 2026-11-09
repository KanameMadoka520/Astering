import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const {webRefresh} = vi.hoisted(() => ({webRefresh: vi.fn()}))

vi.mock('@/client/generated', () => ({authRefreshToken: webRefresh}))
vi.mock('@/helpers/desktopAuth', () => ({
	isDesktopApp: () => false,
	refreshDesktopToken: vi.fn(),
}))

type Command = {
	id: string,
	action: string,
	token?: string,
}
type Port = {
	postMessage: (encoded: string) => void,
	onmessage?: (event: {data: string}) => void,
}

const ORIGIN = 'https://task.tcymc.space'
const SID = 'd1912caa-e164-420e-ad2c-bfecc7061d21'
const OTHER_SID = '33ac7250-daa4-4865-b48b-e4c2d6e94a21'

function token({
	id = 2,
	sid = SID,
	type = 1,
	expiresIn = 3600,
}: {
	id?: number,
	sid?: string,
	type?: number,
	expiresIn?: number,
} = {}) {
	const issued = Math.floor(Date.now() / 1000)
	const payload = btoa(JSON.stringify({
		id,
		sid,
		type,
		iat: issued,
		exp: issued + expiresIn,
	}))
	return `header.${payload}.signature`
}

describe('Android authentication through the real message bridge', () => {
	const originalLocation = window.location
	const originalLocks = navigator.locks
	let auth: typeof import('./auth')
	let commands: Command[]
	let port: Port

	function emit(message: Record<string, unknown>) {
		expect(port.onmessage).toBeTypeOf('function')
		port.onmessage?.({data: JSON.stringify(message)})
	}

	function respond(command: Command, result: Record<string, unknown>) {
		emit({
			id: command.id,
			ok: true,
			result,
		})
	}

	function refreshCommand() {
		const refresh = commands.filter(command => command.action === 'refresh')
		expect(refresh).toHaveLength(1)
		return refresh[0]
	}

	beforeEach(async () => {
		vi.resetModules()
		localStorage.clear()
		commands = []
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL(ORIGIN),
		})
		Object.defineProperty(navigator, 'locks', {
			configurable: true,
			value: undefined,
		})
		window.API_URL = ORIGIN
		port = {
			postMessage: vi.fn(encoded => {
				const command = JSON.parse(encoded) as Command
				commands.push(command)
				if (command.action !== 'refresh') respond(command, {})
			}),
		}
		window.AsteringNative = port
		webRefresh.mockReset()
		auth = await import('./auth')
	})

	afterEach(() => {
		delete window.AsteringNative
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
		Object.defineProperty(navigator, 'locks', {
			configurable: true,
			value: originalLocks,
		})
		window.API_URL = ''
		vi.restoreAllMocks()
	})

	it('coalesces webpage refreshes through native and adopts the renewed in-memory token', async () => {
		const initial = token({expiresIn: 60})
		const renewed = token()
		auth.saveToken(initial, true)

		const first = auth.refreshToken(true)
		const second = auth.refreshToken(true)
		const command = refreshCommand()
		expect(command.token).toBe(initial)
		respond(command, {token: renewed})
		await Promise.all([first, second])

		expect(auth.getToken()).toBe(renewed)
		expect(localStorage.getItem('token')).toBe(renewed)
		expect(webRefresh).not.toHaveBeenCalled()
		expect(commands.filter(command => command.action === 'session').pop()?.token).toBe(renewed)
	})

	it.each(['https://notes.example', 'https://notes.example:8443'])('coordinates refresh and background token events on selected server %s', async origin => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL(origin),
		})
		window.API_URL = origin
		port = {postMessage: port.postMessage}
		window.AsteringNative = port
		const initial = token({expiresIn: 60})
		const renewed = token()
		auth.saveToken(initial, true)
		const refresh = auth.refreshToken(true)
		respond(refreshCommand(), {token: renewed})
		await refresh
		expect(auth.getToken()).toBe(renewed)
		const background = token({expiresIn: 7200})
		emit({event: 'token', token: background})
		expect(auth.getToken()).toBe(background)
		expect(localStorage.getItem('token')).toBe(background)
		expect(webRefresh).not.toHaveBeenCalled()
	})

	it('adopts a native background renewal in memory and notifies existing page observers', () => {
		const renewed = token()
		auth.saveToken(token({expiresIn: 60}), true)
		const observed: (string | null)[] = []
		const unsubscribe = auth.onTokenRefreshed(() => observed.push(auth.getToken()))

		emit({event: 'token', token: renewed})

		expect(auth.getToken()).toBe(renewed)
		expect(localStorage.getItem('token')).toBe(renewed)
		expect(observed).toEqual([renewed])
		unsubscribe()
	})

	it.each([
		['another user', {id: 3}],
		['another login session', {sid: OTHER_SID}],
		['a share principal', {type: 2}],
		['an older token', {expiresIn: 60}],
	] as const)('ignores a native token event for %s', (_label, changes) => {
		const current = token()
		auth.saveToken(current, true)
		const observer = vi.fn()
		const unsubscribe = auth.onTokenRefreshed(observer)

		emit({event: 'token', token: token(changes)})

		expect(auth.getToken()).toBe(current)
		expect(localStorage.getItem('token')).toBe(current)
		expect(observer).not.toHaveBeenCalled()
		unsubscribe()
	})

	it('does not resurrect a signed-out session from either a delayed response or event', async () => {
		const renewed = token()
		auth.saveToken(token({expiresIn: 60}), true)
		const refresh = auth.refreshToken(true)
		const command = refreshCommand()

		auth.removeToken()
		respond(command, {token: renewed})
		emit({event: 'token', token: renewed})
		await refresh

		expect(commands.some(command => command.action === 'clearSession')).toBe(true)
		expect(auth.getToken()).toBeNull()
		expect(localStorage.getItem('token')).toBeNull()
	})

	it.each([
		['another account', 3],
		['a new session for the same account', 2],
	] as const)('keeps %s after an old native refresh settles', async (_label, id) => {
		auth.saveToken(token({expiresIn: 60}), true)
		const refresh = auth.refreshToken(true)
		const command = refreshCommand()
		auth.removeToken()
		const replacement = token({id, sid: OTHER_SID})
		auth.saveToken(replacement, true)

		respond(command, {token: token()})
		emit({event: 'token', token: token()})
		await refresh

		expect(auth.getToken()).toBe(replacement)
		expect(localStorage.getItem('token')).toBe(replacement)
	})

	it('drops native refresh results and events after the configured API changes', async () => {
		const initial = token({expiresIn: 60})
		auth.saveToken(initial, true)
		const refresh = auth.refreshToken(true)
		const command = refreshCommand()
		window.API_URL = 'https://other.example'

		respond(command, {token: token()})
		emit({event: 'token', token: token()})
		await refresh

		expect(auth.getToken()).toBe(initial)
		expect(localStorage.getItem('token')).toBe(initial)
		auth.removeToken()
		expect(commands.at(-1)?.action).toBe('clearSession')
	})

	it('retains a newer native broadcast when an older same-session request response arrives afterwards', async () => {
		auth.saveToken(token({expiresIn: 60}), true)
		const refresh = auth.refreshToken(true)
		const command = refreshCommand()
		const newest = token({expiresIn: 7200})
		emit({event: 'token', token: newest})
		respond(command, {token: token({expiresIn: 3600})})
		await refresh

		expect(auth.getToken()).toBe(newest)
		expect(localStorage.getItem('token')).toBe(newest)
	})

	it('rejects a successful native response belonging to another login session', async () => {
		const current = token({expiresIn: 60})
		auth.saveToken(current, true)
		const refresh = auth.refreshToken(true)
		const assertion = expect(refresh).rejects.toMatchObject({
			failure: {kind: 'rejected', status: 401},
		})
		respond(refreshCommand(), {token: token({sid: OTHER_SID})})
		await assertion

		expect(auth.getToken()).toBe(current)
	})

	it.each([
		['authentication', {kind: 'rejected', status: 401}],
		['unauthorized', {kind: 'rejected', status: 401}],
		['rate_limited', {kind: 'rate-limited'}],
		['server', {kind: 'server', status: 503}],
		['network', {kind: 'network'}],
	] as const)('classifies native %s failures without replacing the current token', async (error, failure) => {
		const current = token({expiresIn: 60})
		auth.saveToken(current, true)
		const refresh = auth.refreshToken(true)
		const assertion = expect(refresh).rejects.toMatchObject({failure})
		emit({
			id: refreshCommand().id,
			ok: false,
			error,
		})
		await assertion

		expect(auth.getToken()).toBe(current)
	})

	it('uses the normal refresh transport when the configured API belongs to another origin', async () => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL('https://task.tcymc.space.attacker.example'),
		})
		const renewed = token()
		webRefresh.mockResolvedValue({data: {token: renewed}})
		auth.saveToken(token({expiresIn: 60}), true)

		await auth.refreshToken(true)

		expect(webRefresh).toHaveBeenCalledOnce()
		expect(commands).toHaveLength(0)
		expect(auth.getToken()).toBe(renewed)
	})
})
