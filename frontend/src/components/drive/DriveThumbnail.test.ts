import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({drivePreview: vi.fn()}))
vi.mock('@/client/generated', () => sdk)

import type {DriveEntry} from '@/client/queries/drive'
import {drivePreviewQuery} from '@/client/queries/drive'
import DriveThumbnail from './DriveThumbnail.vue'

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

function picture(id: number): DriveEntry {
	return {
		file_id: id,
		revision: 1,
		category: '',
		pinned: false,
		file: {
			name: `${id}.png`,
			mime: 'image/png',
			size: 100,
		},
	} as DriveEntry
}

describe('DriveThumbnail', () => {
	beforeEach(() => {
		observed = []
		vi.stubGlobal('IntersectionObserver', FakeObserver)
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail')
		vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
		sdk.drivePreview.mockReset()
		sdk.drivePreview.mockImplementation(async () => ({data: new Blob(['png'], {type: 'image/png'})}))
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('fetches previews only for cards near the screen, and keeps them', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const wrapper = mount(defineComponent({
			setup: () => () => h('div', Array.from({length: 60}, (_, index) => h(DriveThumbnail, {
				key: index,
				file: picture(index + 1),
				decorative: true,
			}))),
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]], stubs: {Icon: true}}})
		await flushPromises()
		expect(sdk.drivePreview).not.toHaveBeenCalled()

		scrollNear(wrapper.findAll('.drive-file-symbol')[0].element)
		await flushPromises()

		expect(sdk.drivePreview.mock.calls.map(([options]) => options.path.file)).toEqual([1])
		expect(wrapper.find('img.drive-thumbnail').attributes('src')).toBe('blob:thumbnail')
	})

	it('does not initialize cached offscreen thumbnails until near and releases the URL on unmount', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		for (let id = 1; id <= 60; id++) client.setQueryData(drivePreviewQuery(id).queryKey, new Blob(['png']))
		const wrapper = mount(defineComponent({
			setup: () => () => h('div', Array.from({length: 60}, (_, index) => h(DriveThumbnail, {
				key: index, file: picture(index + 1), decorative: true,
			}))),
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]], stubs: {Icon: true}}})
		await flushPromises()
		expect(URL.createObjectURL).not.toHaveBeenCalled()
		expect(wrapper.find('img').exists()).toBe(false)

		scrollNear(wrapper.findAll('.drive-file-symbol')[0].element)
		await flushPromises()
		expect(wrapper.find('img').attributes('src')).toBe('blob:thumbnail')
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
		expect(sdk.drivePreview).not.toHaveBeenCalled()
		wrapper.unmount()
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:thumbnail')
	})
})
