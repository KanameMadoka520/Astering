import {afterEach, describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'
import {defineComponent, h, nextTick} from 'vue'
import {useVisualViewport} from './useVisualViewport'

const mounted: Array<ReturnType<typeof mount>> = []

function mountViewport() {
	const wrapper = mount(defineComponent({
		setup() {
			const {style} = useVisualViewport()
			return () => h('div', {style: style.value})
		},
	}))
	mounted.push(wrapper)
	return wrapper
}

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('visible assistant viewport', () => {
	it('follows keyboard-only resizes and visual panning while the layout viewport stays unchanged', async () => {
		const view = Object.assign(new EventTarget(), {
			width: 390,
			height: 740,
			offsetLeft: 0,
			offsetTop: 0,
		})
		vi.stubGlobal('visualViewport', view)
		const layoutHeight = window.innerHeight
		const wrapper = mountViewport()
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-height')).toBe('740px')

		view.height = 320
		view.dispatchEvent(new Event('resize'))
		await nextTick()
		expect(window.innerHeight).toBe(layoutHeight)
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-height')).toBe('320px')

		view.offsetTop = 72
		view.offsetLeft = 15
		view.dispatchEvent(new Event('scroll'))
		await nextTick()
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-top')).toBe('72px')
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-left')).toBe('15px')

		Object.assign(view, {
			width: 740,
			height: 280,
			offsetLeft: 0,
			offsetTop: 0,
		})
		window.dispatchEvent(new Event('resize'))
		await nextTick()
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-width')).toBe('740px')
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-height')).toBe('280px')
	})

	it('keeps a shared subscription until the last shell consumer unmounts, then removes all listeners', async () => {
		const view = Object.assign(new EventTarget(), {
			width: 390,
			height: 740,
			offsetLeft: 0,
			offsetTop: 0,
		})
		vi.stubGlobal('visualViewport', view)
		const add = vi.spyOn(view, 'addEventListener')
		const remove = vi.spyOn(view, 'removeEventListener')
		const removeWindow = vi.spyOn(window, 'removeEventListener')
		const first = mountViewport()
		const second = mountViewport()
		expect(add.mock.calls.map(([event]) => event)).toEqual(['resize', 'scroll'])

		first.unmount()
		expect(remove).not.toHaveBeenCalled()
		view.height = 350
		view.dispatchEvent(new Event('resize'))
		await nextTick()
		expect(second.element.style.getPropertyValue('--visual-viewport-height')).toBe('350px')

		second.unmount()
		expect(remove.mock.calls.map(([event]) => event)).toEqual(['resize', 'scroll'])
		expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
	})

	it('uses window dimensions when visualViewport is unavailable', async () => {
		vi.stubGlobal('visualViewport', undefined)
		const wrapper = mountViewport()
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-height')).toBe(`${window.innerHeight}px`)
		vi.stubGlobal('innerHeight', 360)
		vi.stubGlobal('innerWidth', 640)
		window.dispatchEvent(new Event('resize'))
		await nextTick()
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-height')).toBe('360px')
		expect(wrapper.element.style.getPropertyValue('--visual-viewport-width')).toBe('640px')
	})
})
