import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, ref} from 'vue'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'

const sdk = vi.hoisted(() => ({compassImagesRead: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import {queryClient} from '@/client/queryClient'
import {pendingCompassImages, waitForCompassImages} from '@/helpers/compass/imageUrls'
import {useCompassImageHydration} from './useCompassImageHydration'

enableAutoUnmount(afterEach)

// happy-dom's IntersectionObserver never reports; this one reports whatever a test says is near.
let observed: {callback: IntersectionObserverCallback, targets: Set<Element>}[] = []
class FakeObserver {
	targets = new Set<Element>()
	constructor(public callback: IntersectionObserverCallback) {
		observed.push(this)
	}
	observe(target: Element) { this.targets.add(target) }
	unobserve(target: Element) { this.targets.delete(target) }
	disconnect() { this.targets.clear() }
}
function scrollNear(element: Element) {
	for (const observer of observed.filter(entry => entry.targets.has(element))) {
		observer.callback([{target: element, isIntersecting: true} as IntersectionObserverEntry], observer as never)
	}
}

const BODY = [1, 2, 3, 4]
	.map(id => `<figure class="compass-figure"><img data-compass-image="${id}" alt="Photo ${id}" width="800" height="600"></figure>`)
	.join('')

function mountBody() {
	return mount(defineComponent({
		setup() {
			const root = ref<HTMLElement>()
			useCompassImageHydration(root, () => 7, () => BODY)
			return () => h('div', {ref: root, innerHTML: BODY})
		},
	}), {attachTo: document.body})
}
const reads = () => sdk.compassImagesRead.mock.calls.map(([options]) => options.path.file)
const images = () => [...document.querySelectorAll<HTMLImageElement>('img[data-compass-image]')]

describe('useCompassImageHydration', () => {
	beforeEach(() => {
		observed = []
		queryClient.clear()
		vi.stubGlobal('IntersectionObserver', FakeObserver)
		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${crypto.randomUUID()}`)
		vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
		sdk.compassImagesRead.mockReset()
		sdk.compassImagesRead.mockImplementation(async () => ({data: new Blob(['png'], {type: 'image/png'})}))
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		document.body.innerHTML = ''
	})

	it('downloads an image only once the reader comes near it', async () => {
		mountBody()
		await flushPromises()
		expect(reads()).toEqual([])
		expect(images().map(image => image.getAttribute('data-compass-state'))).toEqual(['deferred', 'deferred', 'deferred', 'deferred'])
		// Waiting images still count for printing.
		expect(pendingCompassImages(document)).toBe(4)

		scrollNear(images()[1])
		await flushPromises()

		expect(reads()).toEqual([2])
		expect(images()[1].getAttribute('src')).toMatch(/^blob:/)
		expect(images()[0].hasAttribute('src')).toBe(false)
	})

	it('loads every waiting image before printing and waits for them', async () => {
		mountBody()
		await flushPromises()
		scrollNear(images()[0])
		await flushPromises()

		let printed: boolean | undefined
		void waitForCompassImages(document, 5_000).then(ready => { printed = ready })
		await flushPromises()

		expect(reads().sort()).toEqual([1, 2, 3, 4])
		expect(printed).toBeUndefined()

		images().forEach(image => image.dispatchEvent(new Event('load')))
		await flushPromises()
		expect(printed).toBe(true)
	})
})
