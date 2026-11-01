import {afterEach, describe, expect, it} from 'vitest'
import {mount, type VueWrapper} from '@vue/test-utils'

import ShortcutRecorder from './ShortcutRecorder.vue'

let wrapper: VueWrapper | undefined

function setup(modelValue = '') {
	wrapper = mount(ShortcutRecorder, {
		props: {modelValue},
		global: {mocks: {$t: (key: string) => key}, stubs: {Icon: true}},
		attachTo: document.body,
	})
	return wrapper
}

function press(target: Element, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
	target.dispatchEvent(event)
	return event
}

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	document.body.innerHTML = ''
})

describe('ShortcutRecorder', () => {
	it('lets Tab and Shift+Tab move focus on, also while recording', async () => {
		const view = setup()
		const button = view.get('.recorder-button').element
		await view.get('.recorder-button').trigger('click')

		expect(press(button, {key: 'Tab', code: 'Tab'}).defaultPrevented).toBe(false)
		expect(press(button, {key: 'Tab', code: 'Tab', shiftKey: true}).defaultPrevented).toBe(false)
		expect(view.emitted('update:modelValue')).toBeUndefined()
	})

	it('still records a shortcut with a modifier', async () => {
		const view = setup()
		const button = view.get('.recorder-button').element
		await view.get('.recorder-button').trigger('click')

		const event = press(button, {key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true})
		expect(event.defaultPrevented).toBe(true)
		expect(view.emitted('update:modelValue')?.[0]).toEqual(['CmdOrCtrl+Shift+K'])
	})
})
