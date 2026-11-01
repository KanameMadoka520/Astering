import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {defineComponent, h, ref} from 'vue'
import {mount, flushPromises, type VueWrapper} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import type {Editor} from '@tiptap/core'

import TipTap from './TipTap.vue'
import en from '@/i18n/lang/en.json'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
const mounted: {wrapper: VueWrapper, client: QueryClient}[] = []

function mountEditor(saved: string) {
	const text = ref(saved)
	const discarded = ref(0)
	const Parent = defineComponent({
		setup: () => () => h(TipTap, {
			modelValue: text.value,
			'onUpdate:modelValue': (value: string) => { text.value = value },
			onDiscard: () => { discarded.value++ },
			enableDiscardShortcut: true,
			alwaysEditing: true,
			storageKey: 'task-description-7',
			showSave: true,
		}),
	})
	const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const wrapper = mount(Parent, {
		global: {plugins: [i18n, [VueQueryPlugin, {queryClient: client}]]},
		attachTo: document.body,
	})
	mounted.push({wrapper, client})
	return {wrapper, text, discarded}
}

function liveEditor(wrapper: VueWrapper): Editor {
	const dom = wrapper.element.querySelector('.ProseMirror') as (HTMLElement & {editor?: Editor}) | null
	if (!dom?.editor) throw new Error('editor not mounted')
	return dom.editor
}

describe('TipTap discard shortcut', () => {
	beforeEach(() => localStorage.clear())
	afterEach(() => {
		mounted.splice(0).forEach(({wrapper, client}) => {
			wrapper.unmount()
			client.clear()
		})
	})

	it('hands the saved text back to the parent and tells it the edit was discarded', async () => {
		const {wrapper, text, discarded} = mountEditor('<p>saved</p>')
		await flushPromises()
		await flushPromises()
		const editor = liveEditor(wrapper)
		editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' and typed')
		await flushPromises()
		expect(text.value).toContain('and typed')

		editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}))
		await flushPromises()

		expect(text.value).toBe('<p>saved</p>')
		expect(discarded.value).toBe(1)
		expect(localStorage.getItem('editorDraft-task-description-7')).toBeNull()
	})
	it('keeps the local copy when Save is pressed before the parent acknowledges the request', async () => {
		const {wrapper} = mountEditor('<p>saved</p>')
		await flushPromises()
		const editor = liveEditor(wrapper)
		editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' pending')
		await flushPromises()
		await wrapper.find('.tiptap__footer button').trigger('click')
		await flushPromises()
		expect(localStorage.getItem('editorDraft-task-description-7')).toBe('<p>saved pending</p>')
	})

})
