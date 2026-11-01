import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, nextTick, ref} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import {provideNearViewportRoot, useNearViewport} from './useNearViewport'

enableAutoUnmount(afterEach)

// A controllable stand-in: happy-dom's IntersectionObserver never reports anything.
class FakeObserver {
	static all: FakeObserver[] = []
	targets = new Set<Element>()
	constructor(private callback: IntersectionObserverCallback, public options: IntersectionObserverInit) {
		FakeObserver.all.push(this)
	}
	observe(target: Element) { this.targets.add(target) }
	unobserve(target: Element) { this.targets.delete(target) }
	disconnect() { this.targets.clear() }
	report(target: Element, isIntersecting: boolean) {
		this.callback([{target, isIntersecting} as IntersectionObserverEntry], this as unknown as IntersectionObserver)
	}
}

function reportAll(target: Element, isIntersecting = true) {
	FakeObserver.all.filter(observer => observer.targets.has(target)).forEach(observer => observer.report(target, isIntersecting))
}

const Probe = defineComponent({
	props: {id: {type: String, required: true}},
	setup(props) {
		const element = ref<HTMLElement>()
		const near = useNearViewport(element)
		return () => h('div', {ref: element, id: props.id, 'data-near': String(near.value)})
	},
})

describe('useNearViewport', () => {
	beforeEach(() => {
		FakeObserver.all = []
		vi.stubGlobal('IntersectionObserver', FakeObserver)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('turns true once the element comes near and stays true', async () => {
		const wrapper = mount(Probe, {props: {id: 'a'}})
		expect(wrapper.attributes('data-near')).toBe('false')

		reportAll(wrapper.element)
		await nextTick()
		expect(wrapper.attributes('data-near')).toBe('true')

		// Scrolling away keeps what was loaded.
		reportAll(wrapper.element, false)
		await nextTick()
		expect(wrapper.attributes('data-near')).toBe('true')
	})

	it('shares one observer between many elements and stops watching each once it was near', async () => {
		const wrapper = mount(defineComponent({
			setup: () => () => h('div', ['a', 'b', 'c'].map(id => h(Probe, {id, key: id}))),
		}))
		expect(FakeObserver.all).toHaveLength(1)
		const [observer] = FakeObserver.all
		expect(observer.targets.size).toBe(3)
		expect(observer.options.rootMargin).toBe('150% 0px')

		reportAll(wrapper.find('#b').element)
		await nextTick()
		expect(wrapper.findAll('[data-near="true"]').map(element => element.attributes('id'))).toEqual(['b'])
		expect(observer.targets.size).toBe(2)

		wrapper.unmount()
		expect(observer.targets.size).toBe(0)
	})

	it('measures against the scroll area a parent provides', () => {
		const area = document.createElement('section')
		mount(defineComponent({
			setup() {
				provideNearViewportRoot(() => area)
				return () => h(Probe, {id: 'inside'})
			},
		}))
		expect(FakeObserver.all.at(-1)?.options.root).toBe(area)
	})

	it('is near at once without IntersectionObserver', () => {
		vi.stubGlobal('IntersectionObserver', undefined)
		const wrapper = mount(Probe, {props: {id: 'a'}})
		expect(wrapper.attributes('data-near')).toBe('true')
	})
})
