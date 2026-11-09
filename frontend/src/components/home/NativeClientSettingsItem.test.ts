import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import NativeClientSettingsItem from './NativeClientSettingsItem.vue'

const {showError} = vi.hoisted(() => ({showError: vi.fn()}))
vi.mock('@/message', () => ({error: showError}))
vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))

type Command = {
	id: string,
	action: string,
}
type Port = {
	postMessage: (encoded: string) => void,
	onmessage?: (event: {data: string}) => void,
}

describe('client settings account-menu item', () => {
	const originalLocation = window.location
	let wrapper: VueWrapper | undefined
	let commands: Command[]
	let port: Port

	function respond(result: unknown, error?: string) {
		const id = commands.at(-1)?.id
		port.onmessage?.({data: JSON.stringify({
			id,
			ok: !error,
			result,
			error,
		})})
	}

	async function supported() {
		wrapper = mount(NativeClientSettingsItem, {global: {stubs: {Icon: true}}})
		respond({
			version_name: '2.7.1-aster.67',
			version_code: 67,
			capabilities: {clientSettings: true},
		})
		await flushPromises()
		return wrapper.get('button')
	}

	beforeEach(() => {
		showError.mockReset()
		commands = []
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL('https://personal.example:8443/ai'),
		})
		window.API_URL = ''
		port = {postMessage: encoded => { commands.push(JSON.parse(encoded) as Command) }}
		window.AsteringNative = port
	})

	afterEach(() => {
		wrapper?.unmount()
		wrapper = undefined
		delete window.AsteringNative
		window.API_URL = ''
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
	})

	it('appears only after support is confirmed and guards repeated activation', async () => {
		const button = await supported()
		expect(button.text()).toBe('androidClient.settings')
		await button.trigger('click')
		await button.trigger('click')
		expect(wrapper?.emitted('activate')).toHaveLength(1)
		expect(commands.filter(command => command.action === 'openClientSettings')).toHaveLength(1)
		expect(button.attributes('aria-disabled')).toBe('true')
		expect(button.attributes('disabled')).toBeUndefined()
		respond({})
		await flushPromises()
		expect(button.attributes('aria-disabled')).toBeUndefined()
		expect(showError).not.toHaveBeenCalled()
	})

	it('keeps unsupported old clients and ordinary browsers free of dead entries', async () => {
		wrapper = mount(NativeClientSettingsItem)
		expect(wrapper.find('button').exists()).toBe(false)
		respond(null, 'unsupported')
		await flushPromises()
		expect(wrapper.find('button').exists()).toBe(false)
		wrapper.unmount()
		delete window.AsteringNative
		wrapper = mount(NativeClientSettingsItem)
		await flushPromises()
		expect(wrapper.find('button').exists()).toBe(false)
		expect(commands).toHaveLength(1)
	})

	it('reuses account-independent capabilities when the menu is remounted', async () => {
		await supported()
		wrapper?.unmount()
		wrapper = mount(NativeClientSettingsItem, {global: {stubs: {Icon: true}}})
		await flushPromises()
		expect(wrapper.find('button').exists()).toBe(true)
		expect(commands.filter(command => command.action === 'clientInfo')).toHaveLength(1)
	})

	it('reports a readable failure and lets the user try again', async () => {
		const button = await supported()
		await button.trigger('click')
		respond(null, 'foreground_required')
		await flushPromises()
		expect(showError).toHaveBeenCalledWith(new Error('androidClient.openFailed'))
		await button.trigger('click')
		expect(commands.filter(command => command.action === 'openClientSettings')).toHaveLength(2)
		respond({})
		await flushPromises()
	})

	it('does not display a late probe or an error after the menu unmounts', async () => {
		wrapper = mount(NativeClientSettingsItem)
		wrapper.unmount()
		respond({
			version_name: '2.7.1-aster.67',
			version_code: 67,
			capabilities: {clientSettings: true},
		})
		await flushPromises()
		expect(showError).not.toHaveBeenCalled()
	})
})
