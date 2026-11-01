import {describe, it, expect, vi, afterEach} from 'vitest'
import {mount, flushPromises} from '@vue/test-utils'
import {h} from 'vue'

const floatingUi = vi.hoisted(() => {
	let resolvePosition: (() => void) | undefined
	return {
		// Each placement waits until the test releases it, like a slow layout pass.
		computePosition: vi.fn(() => new Promise<{x: number, y: number}>(resolve => {
			resolvePosition = () => resolve({x: 12, y: 34})
		})),
		autoUpdate: vi.fn((reference: unknown, floating: unknown, update: () => void) => {
			update()
			return () => {}
		}),
		releasePosition: () => resolvePosition?.(),
	}
})

vi.mock('@floating-ui/dom', () => ({
	computePosition: floatingUi.computePosition,
	autoUpdate: floatingUi.autoUpdate,
	autoPlacement: () => ({name: 'autoPlacement'}),
	offset: () => ({name: 'offset'}),
	shift: () => ({name: 'shift'}),
	size: () => ({name: 'size'}),
}))

import Dropdown from './Dropdown.vue'

function mountDropdown(onShown: () => void) {
	return mount(Dropdown, {
		props: {onShown},
		slots: {
			trigger: ({toggleOpen}: {toggleOpen: () => void}) => h('button', {class: 'trigger', onClick: toggleOpen}, 'More'),
			default: () => h('button', {class: 'item'}, 'Item'),
		},
		attachTo: document.body,
	})
}

describe('Dropdown', () => {
	afterEach(() => {
		document.body.innerHTML = ''
	})

	it('emits shown only once the opened menu is positioned and visible', async () => {
		const visibilityWhenShown: string[] = []
		const wrapper = mountDropdown(() => {
			visibilityWhenShown.push(wrapper.get<HTMLElement>('.dropdown-menu').element.style.visibility)
		})

		await wrapper.get('.trigger').trigger('click')
		await flushPromises()

		// Still being placed: hidden, so nothing inside can take focus yet.
		expect(wrapper.get<HTMLElement>('.dropdown-menu').element.style.visibility).toBe('hidden')
		expect(visibilityWhenShown).toEqual([])

		floatingUi.releasePosition()
		await flushPromises()

		expect(visibilityWhenShown).toEqual(['visible'])
		expect(wrapper.emitted('shown')).toHaveLength(1)
	})

	it('emits shown again when the menu is reopened', async () => {
		const shown = vi.fn()
		const wrapper = mountDropdown(shown)

		await wrapper.get('.trigger').trigger('click')
		await flushPromises()
		floatingUi.releasePosition()
		await flushPromises()
		expect(shown).toHaveBeenCalledTimes(1)

		await wrapper.get('.trigger').trigger('click')
		await flushPromises()
		await wrapper.get('.trigger').trigger('click')
		await flushPromises()
		floatingUi.releasePosition()
		await flushPromises()

		expect(shown).toHaveBeenCalledTimes(2)
	})

	it('closes only itself on Escape, not a dialog around it', async () => {
		const wrapper = mountDropdown(() => {})
		await wrapper.get('.trigger').trigger('click')
		await flushPromises()
		floatingUi.releasePosition()
		await flushPromises()

		const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
		wrapper.get('.item').element.dispatchEvent(escape)
		await flushPromises()

		// A cancelled keydown is what keeps a native <dialog> from turning Escape into a close request.
		expect(escape.defaultPrevented).toBe(true)
		const menu = wrapper.find<HTMLElement>('.dropdown-menu')
		expect(menu.exists() && menu.element.style.display !== 'none').toBe(false)
	})

	it('can be closed by the page that holds it, giving focus back to its button', async () => {
		const wrapper = mountDropdown(() => {})
		await wrapper.get('.trigger').trigger('click')
		await flushPromises()
		floatingUi.releasePosition()
		await flushPromises()
		;(wrapper.get('.item').element as HTMLElement).focus()

		;(wrapper.vm as unknown as {closeMenu: (options?: {focusTrigger?: boolean}) => void}).closeMenu({focusTrigger: true})
		await flushPromises()

		const menu = wrapper.find<HTMLElement>('.dropdown-menu')
		expect(menu.exists() && menu.element.style.display !== 'none').toBe(false)
		expect(document.activeElement).toBe(wrapper.get('.trigger').element)
	})
})
