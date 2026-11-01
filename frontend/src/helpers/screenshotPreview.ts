import {i18n} from '@/i18n'

function getStaticLabels(): Set<string> {
	const labels = new Set<string>(['Vikunja', 'vikunja-x', 'x版本', 'x edition', 'GitHub'])
	function collect(value: unknown, path: string) {
		if (typeof value === 'string' || typeof value === 'function' || (value && typeof value === 'object' && (('body' in value && 'type' in value) || ('b' in value && 't' in value)))) {
			const translated = i18n.global.t(path)
			if (translated.trim()) labels.add(translated.trim())
		} else if (value && typeof value === 'object') {
			for (const [key, child] of Object.entries(value)) collect(child, path ? `${path}.${key}` : key)
		}
	}
	collect(i18n.global.getLocaleMessage('en'), '')
	collect(i18n.global.getLocaleMessage(i18n.global.locale.value), '')
	return labels
}

export type ScreenshotLabels = {project: string, task: string, person: string, content: string, image: string}
const privateText = '.project-title,.project-menu-title,.tasktext,.kanban-card__title-link,.task-id,.username,.label-wrapper,.tiptap,.ProseMirror,[contenteditable],.bucket-title,.gantt-task,.task-title'
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400"><rect width="800" height="400" fill="#dce5ed"/><circle cx="600" cy="110" r="45" fill="#b8cbdc"/><path d="M0 400 220 140 430 360 580 240 800 400" fill="#a5bed3"/></svg>')

// Work only on a detached snapshot. Never rewrite live editor DOM: TipTap could
// observe a cosmetic substitution and accidentally save it as real content.
export function createScreenshotPreview(source: HTMLElement, labels: ScreenshotLabels): HTMLElement {
	const staticLabels = getStaticLabels()
	const clone = source.cloneNode(true) as HTMLElement
	const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
	const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
	const scrolls: {copy: HTMLElement, top: number, left: number}[] = []
	for (let i = 0; i < copies.length; i++) {
		const copy = copies[i], original = originals[i]
		if (copy.matches('script,style,iframe,object,embed,video,audio,source,track,canvas')) {copy.remove(); continue}
		for (const attr of Array.from(copy.attributes)) {
			if (attr.name.startsWith('on') || ['id', 'title', 'alt', 'href', 'srcset', 'poster', 'value', 'contenteditable', 'autofocus', 'form', 'name'].includes(attr.name) || attr.name.startsWith('aria-') || (attr.name.startsWith('data-') && !attr.name.startsWith('data-v-'))) copy.removeAttribute(attr.name)
		}
		copy.setAttribute('tabindex', '-1')
		const background = getComputedStyle(original).backgroundImage
		if (background.includes('url(')) copy.style.backgroundImage = 'linear-gradient(135deg, #dce5ed, #b8cbdc)'
		if (copy instanceof HTMLImageElement) {
			const box = original.getBoundingClientRect()
			copy.src = picture
			copy.alt = labels.image
			if (box.width && box.height) {copy.style.width = `${box.width}px`; copy.style.height = `${box.height}px`; copy.style.objectFit = 'cover'}
		}
		if (copy instanceof HTMLInputElement) {
			copy.value = ['checkbox', 'radio', 'range', 'color', 'button'].includes(copy.type) ? copy.value : ''
			copy.placeholder = labels.content
			copy.readOnly = true
		}
		if (copy instanceof HTMLTextAreaElement) {copy.value = labels.content; copy.textContent = labels.content; copy.readOnly = true}
		if (copy instanceof HTMLSelectElement) copy.value = (original as HTMLSelectElement).value
		if (original.scrollTop || original.scrollLeft) scrolls.push({copy, top: original.scrollTop, left: original.scrollLeft})
	}
	const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
	let node: Node | null
	while ((node = walker.nextNode())) {
		const value = node.textContent?.trim() ?? ''
		if (!value) continue
		const parent = node.parentElement!
		if (!parent.closest(privateText) && staticLabels.has(value)) continue
		const text = parent.closest('.project-title,.project-menu-title') ? labels.project
			: parent.closest('.tasktext,.kanban-card__title-link,.task-title,.task-id') ? labels.task
				: parent.closest('.username,.user') ? labels.person : labels.content
		node.textContent = node.textContent!.replace(value, text)
	}
	clone.setAttribute('aria-hidden', 'true')
	// The caller attaches before the next frame; restore independent scroll areas.
	requestAnimationFrame(() => scrolls.forEach(({copy, top, left}) => {copy.scrollTop = top; copy.scrollLeft = left}))
	return clone
}
