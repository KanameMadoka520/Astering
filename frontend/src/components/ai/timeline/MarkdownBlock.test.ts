// @vitest-environment jsdom
// Under happy-dom DOMPurify drops the tag of the first element of every fragment it returns, which would make
// per-block sanitizing look broken; jsdom matches the browsers here.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import {mount, type VueWrapper} from '@vue/test-utils'
import {marked} from 'marked'
import {sanitizeProjectDescription} from '@/helpers/sanitizeProjectDescription'
import MarkdownBlock from './MarkdownBlock.vue'

function fullRender(source: string) {
	const element = document.createElement('div')
	element.innerHTML = sanitizeProjectDescription(marked.parse(source, {async: false}))
	return element
}

// Compares children only; the block's own element carries Vue's class and scope attributes.
function sameDom(wrapper: VueWrapper, source: string) {
	const rendered = document.createElement('div')
	rendered.innerHTML = wrapper.element.innerHTML
	return fullRender(source).isEqualNode(rendered)
}

async function streamTo(wrapper: VueWrapper, source: string) {
	await wrapper.setProps({source})
	vi.advanceTimersByTime(200)
	await nextTick()
}

// Constructs that make a later line change an earlier block, or that cannot be split per block.
const TRICKY = [
	'Para line',
	'===',
	'',
	'- a',
	'- b',
	'',
	'  continued b',
	'',
	'- c',
	'',
	'See [ref] here and <b>bold',
	'',
	'```js',
	'let x = 1',
	'```',
	'',
	'| a | b |',
	'|---|---|',
	'| 1 | 2 |',
	'',
	'[ref]: https://example.com',
	'',
	'end',
].join('\n')

describe('MarkdownBlock', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('keeps the DOM of finished blocks while the answer streams', async () => {
		const wrapper = mount(MarkdownBlock, {props: {source: '# Title\n\nFirst paragraph.\n\nSecond', streaming: true}})
		const title = wrapper.element.firstElementChild
		expect(title?.outerHTML).toBe('<h1>Title</h1>')

		await streamTo(wrapper, '# Title\n\nFirst paragraph.\n\nSecond paragraph grows')

		expect(wrapper.element.textContent).toContain('grows')
		expect(wrapper.element.firstElementChild).toBe(title)
	})

	it('keeps a reader\'s selection inside a finished block while streaming', async () => {
		const wrapper = mount(MarkdownBlock, {
			props: {source: 'Copy this sentence.\n\nStill', streaming: true},
			attachTo: document.body,
		})
		const text = wrapper.element.firstElementChild!.firstChild!
		const selection = document.getSelection()!
		selection.removeAllRanges()
		const range = document.createRange()
		range.setStart(text, 0)
		range.setEnd(text, 4)
		selection.addRange(range)

		await streamTo(wrapper, 'Copy this sentence.\n\nStill writing the next paragraph')

		expect(text.isConnected).toBe(true)
		expect(selection.toString()).toBe('Copy')
		wrapper.unmount()
	})

	it('renders every streamed prefix exactly like a full render', async () => {
		const wrapper = mount(MarkdownBlock, {props: {source: '', streaming: true}})
		for (let end = 1; end <= TRICKY.length; end++) {
			const source = TRICKY.slice(0, end)
			await streamTo(wrapper, source)
			expect(sameDom(wrapper, source), `prefix ${end}: ${JSON.stringify(source.slice(-20))}`).toBe(true)
		}
	})

	it('settles on the full render when streaming ends', async () => {
		const source = '## Done\n\n- one\n- two\n\nFinal [link](https://example.com).'
		const wrapper = mount(MarkdownBlock, {props: {source: source.slice(0, 20), streaming: true}})
		await streamTo(wrapper, source)
		const list = wrapper.element.querySelector('ul')

		await wrapper.setProps({streaming: false})

		expect(sameDom(wrapper, source)).toBe(true)
		// Identical markup is not rebuilt, so a selection made during streaming survives the last render.
		expect(wrapper.element.querySelector('ul')).toBe(list)
	})

	it('throttles streamed renders and always lands the last delta', async () => {
		const wrapper = mount(MarkdownBlock, {props: {source: 'one', streaming: true}})
		await wrapper.setProps({source: 'one two'})
		await wrapper.setProps({source: 'one two three'})
		expect(wrapper.element.textContent?.trim()).toBe('one')

		vi.advanceTimersByTime(200)
		await nextTick()

		expect(wrapper.element.textContent?.trim()).toBe('one two three')
	})
})
