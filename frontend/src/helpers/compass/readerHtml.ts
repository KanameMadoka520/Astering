import {announcementTextLines, sanitizeAnnouncement} from '@/helpers/sanitizeAnnouncement'

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
	readonly [sanitized]: true
}

const HEADINGS = 'h1, h2, h3, h4'

/**
 * Sanitizes an entry body with the announcement allow-list (text, lists, tables, links; no images,
 * styles, ids or scripts) and gives h1–h4 stable anchors for the table of contents. Ids are ours,
 * added after sanitizing, so authored ids can never collide with or spoof them.
 */
export function prepareCompassHtml(content: string, idPrefix = 'compass-section'): CompassPreparedHtml {
	const clean = sanitizeAnnouncement(content)
	const template = document.createElement('template')
	template.innerHTML = clean
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
	// The brand only exists in the type; this is the one place allowed to grant it.
	return {
		html: template.innerHTML,
		headings,
	} as unknown as CompassPreparedHtml
}

/** Visible text of a body, one block per line; feeds the reading time and emptiness checks. */
export function compassPlainText(content: string): string {
	return announcementTextLines(content).join('\n')
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu

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
