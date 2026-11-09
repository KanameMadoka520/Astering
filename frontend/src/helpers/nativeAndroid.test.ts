import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

type Command = {
	id: string,
	action: string,
	token?: string,
}
type Port = {
	postMessage: (encoded: string) => void,
	onmessage?: (event: {data: string}) => void,
}

const ORIGIN = 'https://notes.example:8443'

describe('native Android selected-server boundary', () => {
	const originalLocation = window.location
	let native: typeof import('./nativeAndroid')
	let port: Port
	let commands: Command[]
	let automaticReplies: boolean

	function page(url: string, api = '') {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL(url),
		})
		window.API_URL = api
	}

	function emit(message: Record<string, unknown>, target = port) {
		target.onmessage?.({data: JSON.stringify(message)})
	}

	beforeEach(async () => {
		vi.resetModules()
		vi.useFakeTimers()
		page(ORIGIN)
		commands = []
		automaticReplies = true
		port = {
			postMessage: vi.fn(encoded => {
				const command = JSON.parse(encoded) as Command
				commands.push(command)
				if (automaticReplies) emit({id: command.id, ok: true, result: {accepted: true}})
			}),
		}
		window.AsteringNative = port
		native = await import('./nativeAndroid')
	})

	afterEach(() => {
		delete window.AsteringNative
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
		window.API_URL = ''
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it.each([
		[ORIGIN, ''],
		[ORIGIN, '/api/v2'],
		[ORIGIN, ORIGIN],
		[ORIGIN, `${ORIGIN}/api/v2/`],
		['https://notes.example', 'https://notes.example:443'],
		['https://task.tcymc.space', 'https://task.tcymc.space'],
	])('uses the bridge on selected HTTPS page %s with canonical local API %s', async (url, api) => {
		page(url, api)
		expect(native.isNativeAndroid()).toBe(true)
		await expect(native.requestNativeAndroid('offlineStatus')).resolves.toEqual({accepted: true})
		expect(commands).toHaveLength(1)
	})

	it.each([
		['http://notes.example', ''],
		['file:///notes', ''],
		['about:blank', ''],
		['https://user:secret@notes.example', ''],
		[ORIGIN, 'https://other.example'],
		[ORIGIN, 'https://notes.example'],
		[ORIGIN, 'https://notes.example:8444'],
		[ORIGIN, 'https://notes.example.attacker.example:8443'],
		[ORIGIN, 'https://user:secret@notes.example:8443'],
		[ORIGIN, `${ORIGIN}/prefix`],
		[ORIGIN, `${ORIGIN}/api/v2?query=1`],
		[ORIGIN, `${ORIGIN}/api/v2#fragment`],
		[ORIGIN, '//notes.example:8443'],
		[ORIGIN, 'javascript:alert(1)'],
	])('blocks native credentials on page %s with API %s', async (url, api) => {
		page(url, api)
		expect(native.isNativeAndroid()).toBe(false)
		await expect(native.requestNativeAndroid('session', {token: 'private-token'}))
			.rejects.toThrow('native_unavailable')
		native.nativeAndroidSession('private-token')
		expect(commands).toHaveLength(0)
	})

	it('requires the injected bridge and a valid configured API', async () => {
		delete window.AsteringNative
		expect(native.isNativeAndroid()).toBe(false)
		window.AsteringNative = port
		Object.assign(window, {API_URL: undefined})
		expect(native.isNativeAndroid()).toBe(false)
		await expect(native.requestNativeAndroid('refresh', {token: 'private-token'}))
			.rejects.toThrow('native_unavailable')
		expect(commands).toHaveLength(0)
	})

	it('can revoke an existing native session after API configuration changes without sending credentials', async () => {
		window.API_URL = 'https://other.example'
		await native.requestNativeAndroid('clearSession', {token: 'must-not-leave-page'})
		native.nativeAndroidSession(null)

		expect(commands).toHaveLength(2)
		for (const command of commands) {
			expect(command).toEqual({id: expect.any(String), action: 'clearSession'})
		}
	})

	it('does not allow even credential-free revocation outside an HTTPS page', async () => {
		page('http://notes.example')
		await expect(native.requestNativeAndroid('clearSession')).rejects.toThrow('native_unavailable')
		native.nativeAndroidSession(null)
		expect(commands).toHaveLength(0)
	})

	it('rejects a delayed reply and ignores events when the API stops matching the selected page', async () => {
		automaticReplies = false
		const observer = vi.fn()
		native.onNativeAndroidEvent(observer)
		const request = native.requestNativeAndroid('refresh', {token: 'private-token'})
		const assertion = expect(request).rejects.toThrow('native_context_changed')
		window.API_URL = 'https://other.example'
		emit({id: commands[0].id, ok: true, result: {token: 'late-token'}})
		emit({event: 'token', token: 'late-token'})
		await assertion
		expect(observer).not.toHaveBeenCalled()
	})

	it('ignores a prior origin port even when another server has the same user and session IDs', async () => {
		automaticReplies = false
		const observer = vi.fn()
		native.onNativeAndroidEvent(observer)
		const request = native.requestNativeAndroid('offlineStatus', {}, 100)
		const assertion = expect(request).rejects.toThrow('native_timeout')
		page('https://another.example')
		emit({event: 'openNote', user_id: 2, sid: 'same-sid', note_id: 1})
		emit({id: commands[0].id, ok: true, result: {private: 'old-server'}})
		await vi.advanceTimersByTimeAsync(100)
		await assertion
		expect(observer).not.toHaveBeenCalled()
	})

	it('ignores events from a replaced bridge port', () => {
		const observer = vi.fn()
		native.onNativeAndroidEvent(observer)
		const previous = port
		port = {postMessage: vi.fn()}
		window.AsteringNative = port
		native.onNativeAndroidEvent(() => {})
		emit({event: 'token', token: 'old-server-token'}, previous)
		expect(observer).not.toHaveBeenCalled()
		emit({event: 'token', token: 'current-server-token'})
		expect(observer).toHaveBeenCalledOnce()
	})
})
