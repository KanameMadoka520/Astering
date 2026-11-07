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
import {removeToken, saveToken} from '@/helpers/auth'
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
		removeToken()
		window.API_URL = ''
		observed = []
		vi.stubGlobal('IntersectionObserver', FakeObserver)
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
		vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		files.saveChatBlob.mockClear()
		sdk.tcyAiAttachmentsDownload.mockReset()
		sdk.tcyAiAttachmentsDownload.mockImplementation(async () => ({data: new Blob(['png'])}))
	})
	afterEach(() => {
		removeToken()
		window.API_URL = ''
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

	it.each([401, 403, 404])('stops displaying and downloading cached bytes after an explicit HTTP %s', async status => {
		const queryKey = chatAttachmentQuery('c1', 'f1', true).queryKey
		client.setQueryData(queryKey, new Blob(['png']))
		const wrapper = mountHistory(['f1'])
		scrollNear(wrapper.get('.chat-file').element)
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(true)
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(Object.assign(new Error('Access changed'), {status}))
		await client.refetchQueries({queryKey, exact: true})
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(false)
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
		expect(wrapper.findAll('figcaption button').some(button => button.text() === 'chatFiles.download')).toBe(false)
		expect(files.saveChatBlob).not.toHaveBeenCalled()
	})

	it.each([503, undefined])('keeps a cached same-account image available after a transient HTTP %s', async status => {
		const queryKey = chatAttachmentQuery('c1', 'f1', true).queryKey
		client.setQueryData(queryKey, new Blob(['png']))
		const wrapper = mountHistory(['f1'])
		scrollNear(wrapper.get('.chat-file').element)
		await flushPromises()
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(Object.assign(new Error('Temporary failure'), {status}))
		await client.refetchQueries({queryKey, exact: true})
		await flushPromises()
		expect(wrapper.find('img').attributes('src')).toBe('blob:preview')
		await wrapper.get('figcaption button').trigger('click')
		expect(files.saveChatBlob).toHaveBeenCalledWith(expect.any(Blob), 'f1.png')
	})

	it('keeps revoked cached bytes hidden until a successful preview retry reauthorizes them', async () => {
		const queryKey = chatAttachmentQuery('c1', 'f1', true).queryKey
		client.setQueryData(queryKey, new Blob(['old png']))
		const wrapper = mountHistory(['f1'])
		scrollNear(wrapper.get('.chat-file').element)
		await flushPromises()
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(Object.assign(new Error('Access changed'), {status: 403}))
		await client.refetchQueries({queryKey, exact: true})
		await flushPromises()
		let finish!: (value: {data: Blob}) => void
		sdk.tcyAiAttachmentsDownload.mockImplementationOnce(() => new Promise(done => { finish = done }))
		await wrapper.get('button[aria-label="chatFiles.retryPreview"]').trigger('click')
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(false)
		expect(wrapper.findAll('figcaption button').some(button => button.text() === 'chatFiles.download')).toBe(false)
		finish({data: new Blob(['reauthorized png'])})
		await flushPromises()
		expect(wrapper.find('img').exists()).toBe(true)
		expect(wrapper.find('.file-error').exists()).toBe(false)
	})

	it('still downloads the original when asked, wherever the card is', async () => {
		const wrapper = mountHistory(['f1'])
		await wrapper.find('figcaption button').trigger('click')
		await flushPromises()

		expect(sdk.tcyAiAttachmentsDownload).toHaveBeenCalledTimes(1)
		expect(files.saveChatBlob).toHaveBeenCalledWith(expect.any(Blob), 'f1.png')
	})

	it('recovers a failed thumbnail in place without downloading a file', async () => {
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(new Error('isolated offline image'))
		const wrapper = mountHistory(['f1'])
		scrollNear(wrapper.find('.chat-file').element)
		await flushPromises()
		expect(wrapper.find('[role="alert"]').text()).toBe('chatFiles.loadFailed')
		expect(wrapper.find('img').exists()).toBe(false)

		const retry = wrapper.find('button[aria-label="chatFiles.retryPreview"]')
		expect(retry.exists()).toBe(true)
		await retry.trigger('click')
		await flushPromises()
		expect(wrapper.find('img').attributes('src')).toBe('blob:preview')
		expect(wrapper.find('[role="alert"]').exists()).toBe(false)
		expect(sdk.tcyAiAttachmentsDownload).toHaveBeenCalledTimes(2)
		expect(files.saveChatBlob).not.toHaveBeenCalled()
	})

	it('also restores the thumbnail and clears its error when a download retries successfully', async () => {
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(new Error('isolated offline image'))
		const wrapper = mountHistory(['f1'])
		scrollNear(wrapper.find('.chat-file').element)
		await flushPromises()
		expect(wrapper.find('[role="alert"]').exists()).toBe(true)
		await wrapper.find('figcaption button').trigger('click')
		await flushPromises()
		expect(wrapper.find('img').attributes('src')).toBe('blob:preview')
		expect(wrapper.find('[role="alert"]').exists()).toBe(false)
		expect(sdk.tcyAiAttachmentsDownload).toHaveBeenCalledTimes(2)
		expect(files.saveChatBlob).toHaveBeenCalledWith(expect.any(Blob), 'f1.png')
	})

	it('keeps the retry focused while loading, then moves focus to the recovered image', async () => {
		sdk.tcyAiAttachmentsDownload.mockRejectedValueOnce(new Error('offline image'))
		const wrapper = mount(ChatAttachmentCard, {props: {conversationId: 'c1', file: image('f1')},
			attachTo: document.body, global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		scrollNear(wrapper.element)
		await flushPromises()
		let finish!: (value: {data: Blob}) => void
		sdk.tcyAiAttachmentsDownload.mockImplementationOnce(() => new Promise(done => { finish = done }))
		const retry = wrapper.get('button[aria-label="chatFiles.retryPreview"]')
		;(retry.element as HTMLButtonElement).focus()
		await retry.trigger('click')
		await flushPromises()
		expect(document.activeElement).toBe(retry.element)
		expect(retry.attributes('aria-disabled')).toBe('true')
		await retry.trigger('click')
		expect(sdk.tcyAiAttachmentsDownload).toHaveBeenCalledTimes(2)
		finish({data: new Blob(['png'])})
		await flushPromises()
		expect(document.activeElement).toBe(wrapper.get('.image-button').element)
		expect(wrapper.find('button[aria-label="chatFiles.retryPreview"]').exists()).toBe(false)
	})

	it.each(['unmount', 'identity', 'api', 'file'] as const)('does not download a late attachment after changing %s', async change => {
		let finish!: (value: {data: Blob}) => void
		sdk.tcyAiAttachmentsDownload.mockImplementationOnce(() => new Promise(done => { finish = done }))
		const wrapper = mount(ChatAttachmentCard, {
			props: {conversationId: 'c1', file: {...image('f1'), mime: 'text/plain'}},
			global: {plugins: [[VueQueryPlugin, {queryClient: client}]]},
		})
		await wrapper.get('figcaption button').trigger('click')
		if (change === 'unmount') wrapper.unmount()
		if (change === 'identity') saveToken(`fixture.${btoa(JSON.stringify({id: 2, type: 1}))}.fixture`, false)
		if (change === 'api') window.API_URL = 'https://other.example/api/v2'
		if (change === 'file') await wrapper.setProps({file: {...image('f2'), mime: 'text/plain'}})
		finish({data: new Blob(['private notes'])})
		await flushPromises()
		expect(files.saveChatBlob).not.toHaveBeenCalled()
	})
})
