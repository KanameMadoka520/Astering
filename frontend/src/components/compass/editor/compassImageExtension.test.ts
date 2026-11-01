import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises} from '@vue/test-utils'
import {Editor} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

const sdk = vi.hoisted(() => ({compassImagesRead: vi.fn()}))
vi.mock('@/client/generated', () => sdk)

import {queryClient} from '@/client/queryClient'
import {createCompassImageExtension} from './compassImageExtension'

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

const BODY = [1, 2, 3]
	.map(id => `<img data-compass-image="${id}" alt="Photo ${id}" width="800" height="600">`)
	.join('')

describe('Compass editor images', () => {
	let editor: Editor | undefined

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
		editor?.destroy()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		document.body.innerHTML = ''
	})

	it('downloads a picture only once the writer scrolls near it', async () => {
		const available = vi.fn()
		const element = document.createElement('div')
		document.body.append(element)
		editor = new Editor({
			element,
			extensions: [
				StarterKit,
				createCompassImageExtension({
					spaceId: 7,
					labels: {
						loading: 'Loading',
						unavailable: 'Unavailable',
						unnamed: 'Picture',
					},
					onAvailability: available,
					onEditor: () => undefined,
				}),
			],
			content: BODY,
		})
		await flushPromises()
		const figures = [...element.querySelectorAll('figure.compass-editor-image')]
		expect(figures).toHaveLength(3)
		expect(sdk.compassImagesRead).not.toHaveBeenCalled()

		scrollNear(figures[2])
		await flushPromises()

		expect(sdk.compassImagesRead.mock.calls.map(([options]) => options.path.file)).toEqual([3])
		expect(figures[2].querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
		expect(available).toHaveBeenCalledWith(3, true)
	})
})
