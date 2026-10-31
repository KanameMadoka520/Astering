import {nextTick, toValue, type MaybeRefOrGetter, type Ref} from 'vue'

import StarterKit from '@tiptap/starter-kit'
import {createNodeFromContent, Extension, mergeAttributes, type Editor, type Extensions} from '@tiptap/core'
import {Plugin, PluginKey, TextSelection} from '@tiptap/pm/state'
import {Fragment} from '@tiptap/pm/model'
import {marked} from 'marked'

import Link from '@tiptap/extension-link'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import {Table, TableRow, TableCell, TableHeader} from '@tiptap/extension-table'
import Typography from '@tiptap/extension-typography'
import Image from '@tiptap/extension-image'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import Underline from '@tiptap/extension-underline'
import {Placeholder} from '@tiptap/extensions'
import HardBreak from '@tiptap/extension-hard-break'

import {TaskList} from '@tiptap/extension-list'
import {TaskItemWithId} from './taskItemWithId'
import {ListKeymapWithJoin} from './listKeymapWithJoin'
import {DeleteSelectionBeforeEnter} from './deleteSelectionBeforeEnter'
import {BlockquoteWithCommentId} from './blockquoteWithCommentId'
import {TaskLink, LINK_HTML_ATTRIBUTES} from './taskLink'
import {createClipboardParser, fillRequiredContent, repairSliceContent} from './contentRepair'
import {htmlHasFormatting} from './clipboardHtml'

import Commands from './commands'
import suggestionSetup from './suggestion'
import {EmojiExtension} from './emoji/emojiExtension'

import {common, createLowlight} from 'lowlight'

import type {EditorImageSource, UploadCallback} from './types'
import type {Task as ITask} from '@/client/generated'
import type {TaskAttachment as IAttachment} from '@/client/generated'
import {fetchAttachmentUrl, releaseAttachmentUrl} from '@/helpers/attachments'
import {getApiRootUrl} from '@/helpers/apiUrl'

type ImageNodeKey = `${ITask['id']}-${IAttachment['id']}`

// stored srcs predate the v2 flip, so the version segment is matched, not compared
const ATTACHMENT_URL = /^(.*?)(?:\/api\/v[12])?\/tasks\/(\d+)\/attachments\/(\d+)$/

interface AttachmentRef {
	taskId: number
	attachmentId: number
}

function parseAttachmentUrl(url: unknown): AttachmentRef | null {
	if (typeof url !== 'string') {
		return null
	}

	const match = ATTACHMENT_URL.exec(url)
	if (match === null) {
		return null
	}

	if (match[1] !== getApiRootUrl()) {
		return null
	}

	return {
		taskId: Number(match[2]),
		attachmentId: Number(match[3]),
	}
}

export interface EditorExtensionDeps {
allowImages?: boolean
allowTaskLists?: boolean
	t: (key: string) => string
	isEditing: Ref<boolean>
	isEditEnabled: () => boolean
	placeholder: MaybeRefOrGetter<string>
	contentHasChanged: Ref<boolean>
	bubbleSave: () => void
	getEditor: () => Editor | undefined
	uploadCallback: MaybeRefOrGetter<UploadCallback | undefined>
	uploadAndInsertFiles: (files: File[] | FileList) => void
	// Replaces the attachment image node and receives pasted and dropped image files (Compass).
	imageSource?: EditorImageSource
}

// the value lands in a style attribute, anything beyond a plain color allows CSS injection
const SAFE_CSS_COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i

function safeCssColor(value: unknown): string | null {
	return typeof value === 'string' && SAFE_CSS_COLOR.test(value.trim()) ? value.trim() : null
}

const CustomTableCell = TableCell.extend({
	addAttributes() {
		return {
			// extend the existing attributes …
			...this.parent?.(),

			// and add a new one …
			backgroundColor: {
				default: null,
				parseHTML: (element: HTMLElement) => safeCssColor(element.getAttribute('data-background-color')),
				renderHTML: (attributes) => {
					const color = safeCssColor(attributes.backgroundColor)
					if (color === null) {
						return {}
					}
					return {
						'data-background-color': color,
						style: `background-color: ${color}`,
					}
				},
			},
		}
	},
})

// prevent links from extending after space
const NonInclusiveLink = Link.extend({
	inclusive() {
		return false
	},
})

const additionalLinkProtocols = [
	'ftp',
	'git',
	'obsidian',
	'notion',
	'message',
]

export function createEditorExtensions(deps: EditorExtensionDeps): Extensions {
	const {
		t,
		isEditing,
		isEditEnabled,
		placeholder,
		contentHasChanged,
		bubbleSave,
		getEditor,
		uploadCallback,
		uploadAndInsertFiles,
	} = deps

	// One url per image node, reused across re-renders and released with the editor that handed it out.
	const imageUrls = new Map<ImageNodeKey, string>()
	let imagesDisposed = false

	async function resolveImageUrl(nodeKey: ImageNodeKey, taskId: number, attachmentId: number): Promise<string> {
		if (imagesDisposed) throw new Error('Editor disposed')
		const cached = imageUrls.get(nodeKey)
		if (cached !== undefined) {
			return cached
		}

		const url = await fetchAttachmentUrl({task_id: taskId, id: attachmentId})
		if (imagesDisposed) { releaseAttachmentUrl(url); throw new Error('Editor disposed') }
		const won = imageUrls.get(nodeKey)
		if (won !== undefined) {
			releaseAttachmentUrl(url)
			return won
		}
		imageUrls.set(nodeKey, url)
		return url
	}

	const CustomImage = Image.extend({
		onDestroy() {
			imagesDisposed = true
			imageUrls.forEach(releaseAttachmentUrl)
			imageUrls.clear()
		},
		addAttributes() {
			return {
				src: {
					default: null,
				},
				alt: {
					default: null,
				},
				title: {
					default: null,
				},
				id: {
					default: null,
					// never trust stored ids: a planted one would hijack the blob lookup
					parseHTML: () => null,
				},
				'data-src': {
					default: null,
				},
			}
		},
		renderHTML({HTMLAttributes}) {
			const imageUrl = HTMLAttributes['data-src'] ?? HTMLAttributes.src
			const attachment = parseAttachmentUrl(imageUrl)
			if (attachment !== null) {
				const {taskId, attachmentId} = attachment
				const nodeKey: ImageNodeKey = `${taskId}-${attachmentId}`
				const id = 'tiptap-image-' + nodeKey

				nextTick(async () => {

					// no live view: fail closed, never fall back to document
					if (imagesDisposed) return
					const root = getEditor()?.view?.dom
					if (!root) return

					const images = root.querySelectorAll<HTMLImageElement>(`[id="${id}"]`)
					const img = images.item(0)

					if (!img || !(img instanceof HTMLImageElement)) return

					try {
						const url = await resolveImageUrl(nodeKey, taskId, attachmentId)
						if (imagesDisposed || getEditor()?.view?.dom !== root) return
						images.forEach(image => { if (root.contains(image)) image.src = url })
					} catch {
						if (imagesDisposed) return
						const label = t('task.attachment.imageUnavailable')
						const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
						const placeholder = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="64" viewBox="0 0 420 64"><rect width="420" height="64" rx="8" fill="#f1f3f5"/><text x="16" y="37" fill="#586174" font-family="sans-serif" font-size="14">${escaped}</text></svg>`)
						images.forEach(image => {if (root.contains(image)) {image.src = placeholder; image.alt = label; image.title = label}})
					}
				})

				return ['img', mergeAttributes(this.options.HTMLAttributes, {
					'data-src': imageUrl,
					src: '#',
					alt: HTMLAttributes.alt,
					title: HTMLAttributes.title,
					id,
				})]
			}

			return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
		},
	})

	const PasteHandler = Extension.create({
		name: 'pasteHandler',

		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: new PluginKey('pasteHandler'),
					props: {
						clipboardParser: createClipboardParser(this.editor.schema),
						transformPasted: slice => repairSliceContent(slice),

						handlePaste: (view, event) => {

							// Handle images pasted from clipboard
							if ((typeof toValue(uploadCallback) !== 'undefined' || deps.imageSource) && event.clipboardData?.items?.length) {
								const files = Array.from(event.clipboardData.items)
									.filter(item => item.kind === 'file' && item.type.startsWith('image/'))
									.map(item => item.getAsFile())
									.filter((file): file is File => file !== null)
								if (files.length > 0) {
									// An image source takes the whole selection; attachments keep their one-file paste.
									uploadAndInsertFiles(deps.imageSource ? files : [files[0]])
									return true
								}
							}

							const text = event.clipboardData?.getData('text/plain') || ''
							if (!text) {
								return false
							}

							// Don't convert markdown when pasting inside a code block
							const $from = view.state.selection.$from
							if ($from.parent.type.name === 'codeBlock') {
								return false
							}

							// Rich clipboard content was never markdown source, converting it
							// would drop the formatting the browser already gave us.
							if (htmlHasFormatting(event.clipboardData?.getData('text/html') || '')) {
								return false
							}

							const hasMarkdownSyntax = new RegExp('[*`_\\[\\]#-]').test(text)
							if (!hasMarkdownSyntax) {
								return false
							}

							const parsed = createNodeFromContent(marked.parse(text) as string, this.editor.schema, {
								parseOptions: {preserveWhitespace: 'full', ...this.editor.options.parseOptions},
							})

							this.editor.commands.insertContent(fillRequiredContent(Fragment.from(parsed)))
							return true
						},

						// Files dropped on an editor with an image source upload there, at the drop point; a moved
						// node is ProseMirror's own drag and stays its business.
						handleDrop: (view, event, _slice, moved) => {
							if (moved || !deps.imageSource) return false
							const files = Array.from(event.dataTransfer?.files ?? [])
							if (files.length === 0) return false
							event.preventDefault()
							const drop = view.posAtCoords({left: event.clientX, top: event.clientY})
							if (drop) {
								view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(drop.pos))))
							}
							uploadAndInsertFiles(files)
							return true
						},
					},
				}),
			]
		},
	})

	return [
		// Starterkit:
		StarterKit.configure({
			codeBlock: false,
			hardBreak: false,
			blockquote: false,
			listKeymap: false,
			// Registered separately below with custom options; the StarterKit copies
			// would otherwise also run (e.g. link's openOnClick opening tabs in edit mode).
			link: false,
			underline: false,
		}),
		ListKeymapWithJoin,
		DeleteSelectionBeforeEnter,
		BlockquoteWithCommentId,

		CodeBlockLowlight.configure({
			lowlight: createLowlight(common),
		}),
		HardBreak.extend({
			addKeyboardShortcuts() {
				return {
					'Shift-Enter': () => this.editor.commands.setHardBreak(),
					'Mod-Enter': () => {
						if (contentHasChanged.value) {
							bubbleSave()
						}
						return true
					},
				}
			},
		}),

		Placeholder.configure({
			placeholder({editor}) {
				if (!isEditing.value || editor.getText() !== '' && !editor.isFocused) {
					return ''
				}

				return toValue(placeholder) || t('input.editor.placeholder')
			},
		}),
		Typography,
		Subscript,
		Superscript,
		Underline,
		NonInclusiveLink.configure({
			openOnClick: false,
			validate: (href) => (new RegExp(
				`^(https?|${additionalLinkProtocols.join('|')}):\\/\\/`,
				'i',
			)).test(href),
			protocols: additionalLinkProtocols,
			HTMLAttributes: LINK_HTML_ATTRIBUTES,
		}),
		TaskLink,
		Table.configure({
			resizable: true,
		}),
		TableRow,
		TableHeader,
		// Custom TableCell with backgroundColor attribute
		CustomTableCell,

		deps.imageSource?.extension ?? CustomImage,

		TaskList,
		TaskItemWithId.configure({
			nested: true,
			onReadOnlyChecked(node, checked) {
				if (!isEditEnabled()) {
					return false
				}

				// Use taskId attribute to reliably find the correct node
				// This fixes GitHub issues #293 and #563
				const targetTaskId = node.attrs.taskId

				if (!targetTaskId) {
					// Fallback to original behavior if no ID (shouldn't happen)
					console.warn('TaskItem missing taskId, falling back to node comparison')
					getEditor()!.state.doc.descendants((subnode, pos) => {
						if (subnode === node) {
							const {tr} = getEditor()!.state
							tr.setNodeMarkup(pos, undefined, {
								...node.attrs,
								checked,
							})
							getEditor()!.view.dispatch(tr)
							bubbleSave()
						}
					})
					return true
				}

				// Find node by taskId for reliable matching
				getEditor()!.state.doc.descendants((subnode, pos) => {
					if (subnode.type.name === 'taskItem' && subnode.attrs.taskId === targetTaskId) {
						const {tr} = getEditor()!.state
						tr.setNodeMarkup(pos, undefined, {
							...subnode.attrs,
							checked,
						})
						getEditor()!.view.dispatch(tr)
						bubbleSave()
						return false // Stop iteration once found
					}
				})

				return true
			},
		}),

		Commands.configure({
			suggestion: suggestionSetup(t, {allowImages: deps.allowImages, allowTaskLists: deps.allowTaskLists}),
		}),

		EmojiExtension,

		PasteHandler,
	].filter(extension =>
		(deps.allowImages !== false || extension.name !== 'image') &&
  (deps.allowTaskLists !== false || !['taskList', 'taskItem'].includes(extension.name)))
}
