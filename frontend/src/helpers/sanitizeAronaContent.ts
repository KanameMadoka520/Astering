import createDOMPurify, {type DOMPurify} from 'dompurify'

let purifier: DOMPurify | undefined

// Keep the description HTML boundary, with a private instance so Arona's link policy cannot change
// task descriptions or other editors. Native new-tab links work before any click handler runs too.
export function sanitizeAronaContent(html: string): string {
	if (!purifier) {
		purifier = createDOMPurify(window)
		purifier.addHook('afterSanitizeAttributes', node => {
			if (['a', 'area'].includes(node.localName) && (node.hasAttribute('href') || node.hasAttribute('xlink:href'))) {
				node.setAttribute('target', '_blank')
				node.setAttribute('rel', 'noopener noreferrer')
			}
		})
	}
	return purifier.sanitize(html, {
		ADD_ATTR: ['target'],
		FORBID_ATTR: ['style'],
		FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
	})
}
