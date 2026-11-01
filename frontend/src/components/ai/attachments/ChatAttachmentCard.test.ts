import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({tcyAiAttachmentsDownload: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
const files = vi.hoisted(() => ({saveChatBlob: vi.fn()}))
vi.mock('../export/files', () => ({
	chatBytes: (bytes = 0) => `${bytes} B`,
	saveChatBlob: files.saveChatBlob,
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import type {ChatAttachment} from '@/client/generated'
import {chatAttachmentQuery} from '@/client/queries/chatAttachments'
import ChatAttachmentCard from './ChatAttachmentCard.vue'

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

function image(id: string): ChatAttachment {
	return {
		id,
		name: `${id}.png`,
		mime: 'image/png',
		size: 10,
	}
}

describe('ChatAttachmentCard', () => {
	let client: QueryClient

	function mountHistory(ids: string[]) {
		return mount(defineComponent({
			setup: () => () => h('div', ids.map(id => h(ChatAttachmentCard, {
				key: id,
				conversationId: 'c1',
				file: image(id),
			}))),
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
	}

	beforeEach(() => {
		observed = []
		vi.stubGlobal('IntersectionObserver', FakeObserver)
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
		vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tcyAiAttachmentsDownload.mockReset()
		sdk.tcyAiAttachmentsDownload.mockImplementation(async () => ({data: new Blob(['png'])}))
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('downloads only the images of turns near the visible part of the thread', async () => {
		const wrapper = mountHistory(Array.from({length: 20}, (_, index) => `f${index}`))
		await flushPromises()
		expect(sdk.tcyAiAttachmentsDownload).not.toHaveBeenCalled()

		const cards = wrapper.findAll('.chat-file')
		scrollNear(cards[18].element)
		scrollNear(cards[19].element)
		await flushPromises()

		expect(sdk.tcyAiAttachmentsDownload.mock.calls.map(([options]) => options.path.file)).toEqual(['f18', 'f19'])
		expect(cards[19].find('img').attributes('src')).toBe('blob:preview')
	})

	it('creates cached image URLs only near the viewport and releases them on unmount', async () => {
		const ids = Array.from({length: 20}, (_, index) => `f${index}`)
		for (const id of ids) client.setQueryData(chatAttachmentQuery('c1', id, true).queryKey, new Blob(['png']))
		const wrapper = mountHistory(ids)
		await flushPromises()

		expect(URL.createObjectURL).not.toHaveBeenCalled()
		expect(wrapper.find('img').exists()).toBe(false)
		const card = wrapper.findAll('.chat-file')[19]
		scrollNear(card.element)
		await flushPromises()

		expect(card.find('img').attributes('src')).toBe('blob:preview')
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
		scrollNear(card.element)
		await flushPromises()
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
		expect(sdk.tcyAiAttachmentsDownload).not.toHaveBeenCalled()
		wrapper.unmount()
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview')
	})

	it('releases the preview if a previously cached image is marked missing', async () => {
		client.setQueryData(chatAttachmentQuery('c1', 'f1', true).queryKey, new Blob(['png']))
		const wrapper = mount(ChatAttachmentCard, {props: {conversationId: 'c1', file: image('f1')},
			global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		scrollNear(wrapper.element)
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(true)

		await wrapper.setProps({file: {...image('f1'), missing: true}})
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(false)
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview')
	})

	it('still downloads the original when asked, wherever the card is', async () => {
		const wrapper = mountHistory(['f1'])
		await wrapper.find('figcaption button').trigger('click')
		await flushPromises()

		expect(sdk.tcyAiAttachmentsDownload).toHaveBeenCalledTimes(1)
		expect(files.saveChatBlob).toHaveBeenCalledWith(expect.any(Blob), 'f1.png')
	})
})
