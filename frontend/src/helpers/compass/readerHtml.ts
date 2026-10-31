import {announcementTextLines, sanitizeAnnouncement} from '@/helpers/sanitizeAnnouncement'
import {readCompassImage, type CompassImageRef} from './images'
import {sanitizeCompassFragment} from './sanitizeCompass'

export type CompassHeading = {
	id: string
	level: number
	text: string
}

declare const sanitized: unique symbol

/** Markup that went through the Compass sanitizer; the only thing CompassProse renders. */
export type CompassPreparedHtml = {
	readonly html: string
	readonly headings: readonly CompassHeading[]
	// Distinct body images in reading order; CompassProse loads them through the space.
	readonly images: readonly CompassImageRef[]
	readonly [sanitized]: true
}

const HEADINGS = 'h1, h2, h3, h4'

// Where a figure may stand; inside a paragraph or a link the caption stays inline.
const FIGURE_PARENTS = new Set(['BLOCKQUOTE', 'LI', 'TD', 'TH'])

/**
 * Sanitizes a body and gives h1–h4 stable anchors for the table of contents. Ids are ours, added after
 * sanitizing, so authored ids can never collide with or spoof them. Entry bodies keep their images (as ids,
 * without any src) and each gets a figure, with its caption when it has one; a space preface uses the
 * announcement allow-list, which has no images.
 */
export function prepareCompassHtml(content: string, idPrefix = 'compass-section', options: {images?: boolean} = {}): CompassPreparedHtml {
	const template = document.createElement('template')
	if (options.images === false) {
		template.innerHTML = sanitizeAnnouncement(content)
	} else {
		template.content.appendChild(sanitizeCompassFragment(content))
	}
	const headings: CompassHeading[] = []
	template.content.querySelectorAll(HEADINGS).forEach(element => {
		const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
		if (text === '') return
		const id = `${idPrefix}-${headings.length + 1}`
		element.id = id
		headings.push({
			id,
			level: Number(element.tagName.slice(1)),
			text,
		})
	})
	const images: CompassImageRef[] = []
	const seen = new Set<number>()
	template.content.querySelectorAll('img').forEach(element => {
		const image = readCompassImage(element)
		if (image === null) return
		if (!seen.has(image.fileId)) {
			seen.add(image.fileId)
			images.push(image)
		}
		wrapFigure(element, image.title)
	})
	// The brand only exists in the type; this is the one place allowed to grant it.
	return {
		html: template.innerHTML,
		headings,
		images,
	} as unknown as CompassPreparedHtml
}

function wrapFigure(image: HTMLImageElement, caption: string) {
	const parent = image.parentNode
	if (!parent) return
	const block = parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE || FIGURE_PARENTS.has(parent.nodeName)
	const figure = document.createElement(block ? 'figure' : 'span')
	figure.className = 'compass-figure'
	parent.replaceChild(figure, image)
	figure.appendChild(image)
	if (caption === '') return
	const text = document.createElement(block ? 'figcaption' : 'span')
	text.className = 'compass-figure__caption'
	text.textContent = caption
	figure.appendChild(text)
}

/** Visible text of a body, one block per line; feeds the reading time and emptiness checks. */
export function compassPlainText(content: string): string {
	return announcementTextLines(content).join('\n')
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu

/**
 * Minutes to read, rounded up: about 400 CJK characters or 220 words per minute.
 * 0 for an empty text, so callers can leave the hint out.
 */
export function estimateCompassReadingMinutes(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0
	const words = text.replace(CJK, ' ').split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length
	if (cjk === 0 && words === 0) return 0
	return Math.max(1, Math.ceil(cjk / 400 + words / 220))
}
