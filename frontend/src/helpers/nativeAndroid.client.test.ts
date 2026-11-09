import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

type Command = {
	id: string,
	action: string,
}
type Port = {
	postMessage: (encoded: string) => void,
	onmessage?: (event: {data: string}) => void,
}

const ORIGIN = 'https://personal.example:8443'
const CLIENT = {
	version_name: '2.7.1-aster.67',
	version_code: 67,
	capabilities: {clientSettings: true},
}

describe('Android client settings capabilities', () => {
	const originalLocation = window.location
	let native: typeof import('./nativeAndroid')
	let port: Port
	let commands: Command[]

	function respond(result: unknown, index = commands.length - 1) {
		port.onmessage?.({data: JSON.stringify({
			id: commands[index].id,
			ok: true,
			result,
		})})
	}

	beforeEach(async () => {
		vi.resetModules()
		commands = []
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL(ORIGIN),
		})
		window.API_URL = ''
		port = {
			postMessage: vi.fn(encoded => { commands.push(JSON.parse(encoded) as Command) }),
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
	})

	it('shares a single bounded probe without retaining extra native response data', async () => {
		const first = native.getNativeAndroidClientInfo()
		const second = native.getNativeAndroidClientInfo()
		expect(commands).toHaveLength(1)
		expect(commands[0].action).toBe('clientInfo')
		respond({
			...CLIENT,
			ignored_server: 'not-cached',
			ignored_user: 2,
		})
		await expect(first).resolves.toEqual(CLIENT)
		await expect(second).resolves.toEqual(CLIENT)
		await expect(native.getNativeAndroidClientInfo()).resolves.toEqual(CLIENT)
		expect(commands).toHaveLength(1)
	})

	it('treats an old client unsupported reply as absent and does not repeatedly probe', async () => {
		const probe = native.getNativeAndroidClientInfo()
		port.onmessage?.({data: JSON.stringify({
			id: commands[0].id,
			ok: false,
			error: 'unsupported',
		})})
		await expect(probe).resolves.toBeNull()
		await expect(native.getNativeAndroidClientInfo()).resolves.toBeNull()
		expect(commands).toHaveLength(1)
	})

	it.each([
		{},
		{
			...CLIENT,
			version_name: '',
		},
		{
			...CLIENT,
			version_code: 0,
		},
		{
			...CLIENT,
			version_code: 67.5,
		},
		{
			...CLIENT,
			capabilities: {clientSettings: 'true'},
		},
		{
			...CLIENT,
			capabilities: {clientSettings: false},
		},
		{
			version_name: CLIENT.version_name,
			version_code: 67,
			client_settings: true,
		},
	])('does not advertise malformed or missing settings capability %j', async value => {
		const probe = native.getNativeAndroidClientInfo()
		respond(value)
		await expect(probe).resolves.toBeNull()
	})

	it('does not probe ordinary browsers or a configured foreign API', async () => {
		delete window.AsteringNative
		await expect(native.getNativeAndroidClientInfo()).resolves.toBeNull()
		window.AsteringNative = port
		window.API_URL = 'https://other.example'
		await expect(native.getNativeAndroidClientInfo()).resolves.toBeNull()
		expect(commands).toHaveLength(0)
	})

	it('drops a capability reply after the configured API changes', async () => {
		const probe = native.getNativeAndroidClientInfo()
		window.API_URL = 'https://other.example'
		respond(CLIENT)
		await expect(probe).resolves.toBeNull()
	})

	it('reprobes when the actual injected bridge object changes', async () => {
		const first = native.getNativeAndroidClientInfo()
		respond(CLIENT)
		await first
		port = {postMessage: port.postMessage}
		window.AsteringNative = port
		const second = native.getNativeAndroidClientInfo()
		expect(commands).toHaveLength(2)
		respond({
			...CLIENT,
			version_code: 68,
			version_name: '2.7.1-aster.68',
		})
		await expect(second).resolves.toMatchObject({version_code: 68})
	})

	it('opens settings with only the fixed action and request ID', async () => {
		const probe = native.getNativeAndroidClientInfo()
		respond(CLIENT)
		await probe
		const open = native.openNativeAndroidClientSettings()
		await Promise.resolve()
		expect(commands).toHaveLength(2)
		expect(commands[1]).toEqual({
			id: expect.any(String),
			action: 'openClientSettings',
		})
		respond({})
		await open
	})

	it('checks the API again between cached capability resolution and opening settings', async () => {
		const probe = native.getNativeAndroidClientInfo()
		respond(CLIENT)
		await probe
		const open = native.openNativeAndroidClientSettings()
		window.API_URL = 'https://other.example'
		await expect(open).rejects.toThrow('native_context_changed')
		expect(commands).toHaveLength(1)
	})

	it('does not use an old capability decision on a newly injected bridge', async () => {
		const probe = native.getNativeAndroidClientInfo()
		respond(CLIENT)
		await probe
		const open = native.openNativeAndroidClientSettings()
		window.AsteringNative = {postMessage: vi.fn()}
		await expect(open).rejects.toThrow('native_context_changed')
		expect(window.AsteringNative.postMessage).not.toHaveBeenCalled()
	})
})
