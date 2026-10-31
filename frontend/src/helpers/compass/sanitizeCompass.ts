import createDOMPurify, {type Config, type DOMPurify} from 'dompurify'
import {
	COMPASS_IMAGE_ATTRIBUTE,
	compassImageAttributes,
	readCompassImage,
} from './images'

// An entry body: the announcement set (text formatting, lists, tables, links) plus images that name a drive
// file. An image keeps only its id, alt text, caption and size hint; src, srcset, styles and anything else go,
// so a stored body can never load a remote or tracking URL. Mirrors the server's compassHTMLPolicy.
const CONFIG: Config = {
	ALLOWED_TAGS: [
		'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
		'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'mark', 'sub', 'sup',
		'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
	],
	ALLOWED_ATTR: [
		'href', 'target', 'rel', 'colspan', 'rowspan', 'data-type', 'data-checked',
		COMPASS_IMAGE_ATTRIBUTE, 'alt', 'title', 'width', 'height',
	],
	// Only href carries a URL; every other kept attribute is a plain value checked below.
	ADD_URI_SAFE_ATTR: [
		'target', 'rel', 'colspan', 'rowspan', 'data-type', 'data-checked',
		COMPASS_IMAGE_ATTRIBUTE, 'alt', 'title', 'width', 'height',
	],
	ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
	RETURN_DOM_FRAGMENT: true,
}

// Allowed above for images only; the server keeps them nowhere else either.
const IMAGE_ATTRIBUTES = [COMPASS_IMAGE_ATTRIBUTE, 'alt', 'title', 'width', 'height']
const IMAGE_ATTRIBUTE_SELECTOR = IMAGE_ATTRIBUTES.map(name => `[${name}]`).join(',')

let purifier: DOMPurify | undefined

// A private instance, like sanitizeAnnouncement's: hooks registered elsewhere must not apply here.
function getPurifier(): DOMPurify {
	if (!purifier) {
		purifier = createDOMPurify(window)
		purifier.addHook('afterSanitizeAttributes', node => {
			if (node.nodeName !== 'A') return
			if (node.hasAttribute('href')) {
				node.setAttribute('target', '_blank')
				node.setAttribute('rel', 'noopener noreferrer nofollow')
			} else {
				node.removeAttribute('target')
				node.removeAttribute('rel')
			}
		})
	}
	return purifier
}

/**
 * Sanitized body as a fragment. Images without a valid id are dropped and the rest rewritten in canonical
 * form (clipped texts, a size only when both sides are valid).
 */
export function sanitizeCompassFragment(html: string): DocumentFragment {
	if (html === '') return document.createDocumentFragment()
	const fragment = getPurifier().sanitize(html, CONFIG) as unknown as DocumentFragment
	fragment.querySelectorAll(IMAGE_ATTRIBUTE_SELECTOR).forEach(element => {
		if (element.nodeName !== 'IMG') IMAGE_ATTRIBUTES.forEach(name => element.removeAttribute(name))
	})
	fragment.querySelectorAll('img').forEach(element => {
		const image = readCompassImage(element)
		if (image === null) {
			element.remove()
			return
		}
		for (const name of element.getAttributeNames()) element.removeAttribute(name)
		for (const [name, value] of Object.entries(compassImageAttributes(image))) element.setAttribute(name, value)
	})
	return fragment
}

export function sanitizeCompass(html: string): string {
	if (html === '') return ''
	const container = document.createElement('div')
	container.appendChild(sanitizeCompassFragment(html))
	return container.innerHTML
}
