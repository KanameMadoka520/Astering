import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest'
import {createPinia, setActivePinia} from 'pinia'
import {nextTick, ref} from 'vue'
import {Editor} from '@tiptap/core'
import Image from '@tiptap/extension-image'
import {Slice} from '@tiptap/pm/model'
import {createEditorExtensions, type EditorExtensionDeps} from './editorExtensions'
import {queryClient} from '@/client/queryClient'
import {attachmentKeys} from '@/client/queries/attachments'

const {getBlobUrl} = vi.hoisted(() => ({getBlobUrl: vi.fn(async () => ({data: new Blob(['bytes'])}))}))

vi.mock('@/client/generated', () => ({taskAttachmentsDownload: getBlobUrl}))

const API_URL = 'http://localhost:3456'
window.API_URL = API_URL

const ATTACHMENT_URL = `${API_URL}/api/v2/tasks/5/attachments/9`

type EditorOverrides = Partial<Pick<EditorExtensionDeps, 'allowImages' | 'allowTaskLists' | 'imageSource' | 'uploadCallback' | 'uploadAndInsertFiles'>>

function createEditor(content: string, capabilities: EditorOverrides = {}) {
	const holder = document.createElement('div')
	document.body.appendChild(holder)

	let editor: Editor
	const deps: EditorExtensionDeps = {
		t: key => key,
		isEditing: ref(true),
		isEditEnabled: () => true,
		placeholder: '',
		contentHasChanged: ref(false),
		bubbleSave: () => {},
		getEditor: () => editor,
		uploadCallback: undefined,
		uploadAndInsertFiles: () => {},
		...capabilities,
	}

	editor = new Editor({
		element: holder,
		extensions: createEditorExtensions(deps),
		content,
	})

	return {editor, holder}
}

async function settle() {
	await nextTick()
	await new Promise(resolve => setTimeout(resolve, 0))
	await nextTick()
}

beforeEach(() => {
	window.API_URL = API_URL
	URL.createObjectURL = vi.fn(blob => (blob as Blob & {testUrl?: string}).testUrl ?? 'blob:real-attachment')
	setActivePinia(createPinia())
	queryClient.removeQueries({queryKey: attachmentKeys.blobs})
	getBlobUrl.mockClear()
})

afterEach(() => {
	document.body.innerHTML = ''
})

describe('CustomImage attachment id', () => {
	it('resolves the blob url for a freshly inserted image', async () => {
		const {editor} = createEditor('<p>hi</p>')

		editor.chain().setImage({src: ATTACHMENT_URL}).run()
		await settle()

		const img = editor.view.dom.querySelector('img')!
		expect(img.getAttribute('data-src')).toBe(ATTACHMENT_URL)
		expect(img.id).toBe('tiptap-image-5-9')
		expect(img.src).toBe('blob:real-attachment')
	})

	it('resolves the blob url for a reloaded stored description', async () => {
		const stored = `<p><img src="#" data-src="${ATTACHMENT_URL}" id="tiptap-image-5-9"></p>`
		const {editor} = createEditor(stored)
		await settle()

		const img = editor.view.dom.querySelector('img')!
		expect(img.id).toBe('tiptap-image-5-9')
		expect(img.src).toBe('blob:real-attachment')
	})

	it('resolves the blob url for a legacy stored description without data-src', async () => {
		const {editor} = createEditor(`<p><img src="${ATTACHMENT_URL}"></p>`)
		await settle()

		const img = editor.view.dom.querySelector('img')!
		expect(img.id).toBe('tiptap-image-5-9')
		expect(img.src).toBe('blob:real-attachment')
	})

	it.each([
		`${API_URL}/api/v1/tasks/5/attachments/9`,
		`${API_URL}/tasks/5/attachments/9`,
	])('resolves the older stored src %s', async src => {
		const {editor} = createEditor(`<p><img src="${src}"></p>`)
		await settle()

		const img = editor.view.dom.querySelector('img')!
		expect(img.id).toBe('tiptap-image-5-9')
		expect(img.src).toBe('blob:real-attachment')
	})

	it('leaves an image on another host alone', async () => {
		const {editor} = createEditor('<p><img src="https://attacker.example/tasks/5/attachments/9"></p>')
		await settle()

		const img = editor.view.dom.querySelector('img')!
		expect(img.src).toBe('https://attacker.example/tasks/5/attachments/9')
		expect(getBlobUrl).not.toHaveBeenCalled()
	})

	it('does not let a planted id hijack another image\'s blob url', async () => {
		const stored = '<p><img src="https://attacker.example/x.png" id="tiptap-image-5-9">' +
			`<img src="#" data-src="${ATTACHMENT_URL}" id="tiptap-image-5-9"></p>`
		const {editor} = createEditor(stored)
		await settle()

		const [planted, real] = Array.from(editor.view.dom.querySelectorAll('img'))
		expect(planted.id).toBe('')
		expect(planted.src).toBe('https://attacker.example/x.png')
		expect(real.src).toBe('blob:real-attachment')
	})

	it('fetches the attachment once for two editors showing the same image', async () => {
		const stored = `<p><img src="#" data-src="${ATTACHMENT_URL}" id="tiptap-image-5-9"></p>`
		const first = createEditor(stored)
		const second = createEditor(stored)
		await settle()

		expect(first.editor.view.dom.querySelector('img')!.src).toBe('blob:real-attachment')
		expect(second.editor.view.dom.querySelector('img')!.src).toBe('blob:real-attachment')
		expect(getBlobUrl).toHaveBeenCalledTimes(1)
	})

	it('resolves every copy of the same image in one editor', async () => {
		const {editor} = createEditor(`<p><img src="${ATTACHMENT_URL}"><img src="${ATTACHMENT_URL}"></p>`)
		await settle()
		expect(Array.from(editor.view.dom.querySelectorAll('img')).map(image => image.src)).toEqual(['blob:real-attachment', 'blob:real-attachment'])
	})

	it('shows a recoverable placeholder without saving it into the description', async () => {
		getBlobUrl.mockRejectedValueOnce(new Error('missing image'))
		const {editor} = createEditor(`<p><img src="${ATTACHMENT_URL}"></p>`)
		await settle()
		const image = editor.view.dom.querySelector('img')!
		expect(image.src).toContain('data:image/svg+xml')
		expect(image.alt).toBe('task.attachment.imageUnavailable')
		expect(editor.getHTML()).toContain(ATTACHMENT_URL)
		expect(editor.getHTML()).not.toContain('data:image/svg+xml')
	})

	it('round trips the rendered html', async () => {
		const {editor} = createEditor(`<p><img src="${ATTACHMENT_URL}"></p>`)
		await settle()

		const html = editor.getHTML()
		expect(html).toContain(`data-src="${ATTACHMENT_URL}"`)
		expect(html).toContain('id="tiptap-image-5-9"')

		const reloaded = createEditor(html)
		await settle()
		expect(reloaded.editor.view.dom.querySelector('img')!.src).toBe('blob:real-attachment')
	})
})

describe('CustomTableCell backgroundColor', () => {
	const cell = (color: string) => `<table><tbody><tr><td data-background-color="${color}">x</td></tr></tbody></table>`

	it.each([
		'#fff',
		'#a1b2c3',
		'#a1b2c3d4',
		'rgb(1, 2, 3)',
		'rgba(1, 2, 3, 0.5)',
		'red',
	])('keeps %s', color => {
		const {editor} = createEditor(cell(color))

		const td = editor.view.dom.querySelector('td')!
		expect(td.getAttribute('data-background-color')).toBe(color)
		expect(td.style.backgroundColor).not.toBe('')
		expect(editor.getHTML()).toContain(`data-background-color="${color}"`)
	})

	it.each([
		'red;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999',
		'url(https://attacker.example/x.png)',
		'red !important',
		'expression(alert(1))',
	])('drops %s', color => {
		const {editor} = createEditor(cell(color))

		const td = editor.view.dom.querySelector('td')!
		expect(td.hasAttribute('data-background-color')).toBe(false)
		expect(td.getAttribute('style') ?? '').not.toContain('position')
		expect(editor.getHTML()).not.toContain('data-background-color')
	})

	it('drops an unsafe value set programmatically', () => {
		const {editor} = createEditor(cell('red'))

		editor.chain().setTextSelection(3).setCellAttribute('backgroundColor', 'red;position:fixed').run()

		expect(editor.getHTML()).not.toContain('position')
		expect(editor.view.dom.querySelector('td')!.getAttribute('style') ?? '').not.toContain('position')
	})
})

describe('announcement editor capabilities', () => {
 it('drops images and checklist controls while keeping readable pasted text', () => {
  const {editor} = createEditor('<p>Notice<img src="https://example.com/a.png"></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Read this</p></li></ul>', {allowImages: false, allowTaskLists: false})
  expect(editor.schema.nodes.image).toBeUndefined()
  expect(editor.schema.nodes.taskList).toBeUndefined()
  expect(editor.getHTML()).not.toContain('<img')
  expect(editor.getText()).toContain('Read this')
  editor.destroy()
 })
})

describe('image sources', () => {
	function paste(editor: Editor, files: File[]) {
		const event = {
			clipboardData: {
				items: files.map(file => ({kind: 'file', type: file.type, getAsFile: () => file})),
				getData: () => '',
			},
			preventDefault: () => {},
		} as unknown as ClipboardEvent
		return editor.view.someProp('handlePaste', handler => handler(editor.view, event, Slice.empty))
	}

	const files = [
		new File(['a'], 'a.png', {type: 'image/png'}),
		new File(['b'], 'b.webp', {type: 'image/webp'}),
	]

	it('keeps the task editor on attachment images with its one-file paste', () => {
		const uploadAndInsertFiles = vi.fn()
		const {editor} = createEditor('<p>x</p>', {uploadCallback: async () => [], uploadAndInsertFiles})
		expect(paste(editor, files)).toBe(true)
		expect(uploadAndInsertFiles).toHaveBeenCalledWith([files[0]])
		editor.commands.setContent(`<p><img src="${ATTACHMENT_URL}" alt="a"></p>`)
		expect(editor.getHTML()).toContain(`src="${ATTACHMENT_URL}"`)
		editor.destroy()
	})

	it('does not take pasted images without an upload target', () => {
		const uploadAndInsertFiles = vi.fn()
		const {editor} = createEditor('<p>x</p>', {uploadAndInsertFiles})
		expect(paste(editor, files)).toBeFalsy()
		expect(uploadAndInsertFiles).not.toHaveBeenCalled()
		editor.destroy()
	})

	it('hands every pasted image to an image source, whose node replaces the attachment image', () => {
		const uploadAndInsertFiles = vi.fn()
		const extension = Image.extend({
			parseHTML: () => [{tag: 'img[data-own]'}],
			renderHTML: () => ['img', {'data-own': 'yes'}],
		})
		const {editor} = createEditor('<p>x</p>', {
			uploadAndInsertFiles,
			imageSource: {extension, accept: 'image/*', insertFiles: () => {}},
		})
		expect(paste(editor, files)).toBe(true)
		expect(uploadAndInsertFiles).toHaveBeenCalledWith(files)
		editor.commands.setContent(`<img src="${ATTACHMENT_URL}"><img data-own="1">`)
		expect(editor.getHTML()).not.toContain(ATTACHMENT_URL)
		expect(editor.getHTML()).toContain('data-own="yes"')
		editor.destroy()
	})
})
