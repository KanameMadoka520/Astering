import Image from '@tiptap/extension-image'
import type {Editor} from '@tiptap/core'
import type {Node as ProseMirrorNode} from '@tiptap/pm/model'
import type {NodeView} from '@tiptap/pm/view'
import {
	fetchCompassImageUrl,
	releaseCompassImageUrl,
} from '@/helpers/compass/imageUrls'
import {
	COMPASS_IMAGE_ATTRIBUTE,
	clipCompassImageText,
	compassImageAttributes,
	parseCompassImageDimension,
	parseCompassImageId,
} from '@/helpers/compass/images'

export type CompassImageNodeAttributes = {
	fileId: number | null
	alt: string | null
	title: string | null
	width: number | null
	height: number | null
}

export type CompassImageExtensionOptions = {
	spaceId: number
	labels: {
		loading: string
		unavailable: string
		unnamed: string
	}
	// Whether an image's bytes could be shown here: an unavailable one will also fail to save.
	onAvailability: (fileId: number, available: boolean) => void
	onEditor: (editor: Editor | undefined) => void
}

/**
 * Drawn from the node's attributes, never from stored markup: the picture comes from the space's
 * authorized route, the caption sits under it, and the figure as a whole is what gets selected and dragged.
 */
class CompassImageView implements NodeView {
	dom: HTMLElement
	private image: HTMLImageElement
	private caption: HTMLElement
	private note: HTMLElement
	private fileId: number | null = null
	private url: string | null = null
	private disposed = false

	constructor(private node: ProseMirrorNode, private options: CompassImageExtensionOptions) {
		this.dom = document.createElement('figure')
		this.dom.className = 'compass-editor-image'
		this.dom.contentEditable = 'false'
		this.dom.draggable = true
		this.image = document.createElement('img')
		this.image.draggable = false
		this.image.decoding = 'async'
		this.note = document.createElement('span')
		this.note.className = 'compass-editor-image__note'
		this.caption = document.createElement('figcaption')
		this.caption.className = 'compass-editor-image__caption'
		this.dom.append(this.image, this.note, this.caption)
		this.render(node)
	}

	private render(node: ProseMirrorNode) {
		const attrs = node.attrs as CompassImageNodeAttributes
		const alt = attrs.alt ?? ''
		const title = attrs.title ?? ''
		this.image.alt = alt || (title ? '' : this.options.labels.unnamed)
		// With a known size the frame is drawn at once, so the text below does not jump when the bytes arrive.
		if (attrs.width && attrs.height) {
			this.image.width = attrs.width
			this.image.height = attrs.height
			this.image.style.aspectRatio = `${attrs.width} / ${attrs.height}`
			this.image.style.inlineSize = `min(100%, ${attrs.width}px)`
		} else {
			this.image.removeAttribute('width')
			this.image.removeAttribute('height')
			this.image.style.removeProperty('aspect-ratio')
			this.image.style.removeProperty('inline-size')
		}
		this.caption.textContent = title
		this.caption.hidden = title === ''
		if (attrs.fileId !== this.fileId) void this.load(attrs.fileId)
	}

	private release() {
		releaseCompassImageUrl(this.url)
		this.url = null
	}

	private setState(state: 'loading' | 'ready' | 'failed') {
		this.dom.dataset.state = state
		this.note.textContent = state === 'loading'
			? this.options.labels.loading
			: state === 'failed'
				? this.options.labels.unavailable
				: ''
		this.note.hidden = state === 'ready' || (state === 'loading' && this.image.hasAttribute('width'))
	}

	private async load(fileId: number | null) {
		this.release()
		this.fileId = fileId
		this.image.removeAttribute('src')
		if (fileId === null) {
			this.setState('failed')
			return
		}
		this.setState('loading')
		let url: string
		try {
			url = await fetchCompassImageUrl(this.options.spaceId, fileId)
		} catch {
			if (this.disposed || this.fileId !== fileId) return
			this.setState('failed')
			this.options.onAvailability(fileId, false)
			return
		}
		if (this.disposed || this.fileId !== fileId) {
			releaseCompassImageUrl(url)
			return
		}
		this.url = url
		this.image.src = url
		this.setState('ready')
		this.options.onAvailability(fileId, true)
	}

	update(node: ProseMirrorNode): boolean {
		if (node.type !== this.node.type) return false
		this.node = node
		this.render(node)
		return true
	}

	selectNode() {
		this.dom.classList.add('is-selected')
	}

	deselectNode() {
		this.dom.classList.remove('is-selected')
	}

	// The figure is an atom: nothing inside it is editable text.
	ignoreMutation() {
		return true
	}

	destroy() {
		this.disposed = true
		this.release()
	}
}

/** The `image` node of a Compass body, stored in canonical form (helpers/compass/images.ts). */
export function createCompassImageExtension(options: CompassImageExtensionOptions) {
	return Image.extend({
		atom: true,
		selectable: true,
		draggable: true,

		addOptions() {
			return {
				...this.parent!(),
				inline: false,
				allowBase64: false,
				resize: false as const,
			}
		},

		addAttributes() {
			return {
				fileId: {
					default: null,
					parseHTML: element => parseCompassImageId(element.getAttribute(COMPASS_IMAGE_ATTRIBUTE)),
					renderHTML: () => ({}),
				},
				alt: {
					default: null,
					parseHTML: element => clipCompassImageText(element.getAttribute('alt')) || null,
					renderHTML: () => ({}),
				},
				title: {
					default: null,
					parseHTML: element => clipCompassImageText(element.getAttribute('title')) || null,
					renderHTML: () => ({}),
				},
				width: {
					default: null,
					parseHTML: element => parseCompassImageDimension(element.getAttribute('width')) || null,
					renderHTML: () => ({}),
				},
				height: {
					default: null,
					parseHTML: element => parseCompassImageDimension(element.getAttribute('height')) || null,
					renderHTML: () => ({}),
				},
			}
		},

		// Only images that name a drive file; a pasted <img src> from elsewhere is dropped, never fetched.
		parseHTML() {
			return [{
				tag: `img[${COMPASS_IMAGE_ATTRIBUTE}]`,
				getAttrs: element => parseCompassImageId(element.getAttribute(COMPASS_IMAGE_ATTRIBUTE)) === null ? false : null,
			}]
		},

		// getHTML() is the stored form: the id and the texts, never a URL.
		renderHTML({node}) {
			const attrs = node.attrs as CompassImageNodeAttributes
			if (attrs.fileId === null) return ['img', {}]
			return ['img', compassImageAttributes({
				fileId: attrs.fileId,
				alt: attrs.alt ?? '',
				title: attrs.title ?? '',
				width: attrs.width ?? 0,
				height: attrs.height ?? 0,
			})]
		},

		// `![alt](url)` would make an image without a drive file.
		addInputRules() {
			return []
		},

		addNodeView() {
			return ({node}) => new CompassImageView(node, options)
		},

		onCreate() {
			options.onEditor(this.editor)
		},

		onDestroy() {
			options.onEditor(undefined)
		},
	})
}
