import type {CompassEntry, CompassSpace} from '@/client/queries/compass'
import {
	escapeBlockStart,
	escapeInline,
	htmlToMarkdown,
	type MarkdownImageOptions,
} from './htmlToMarkdown'

export type CompassExportLabels = {
	kind: (entry: CompassEntry) => string
	// "Exported from …" line under the space title; already translated.
	exportedFrom: string
	contents: string
	// Said once at the top when the file refers to images it does not contain.
	imagesNote?: string
}

type YamlValue = string | number | boolean | string[]

// JSON strings are valid YAML double-quoted scalars, so every value round-trips.
function yaml(value: YamlValue): string {
	if (Array.isArray(value)) return `[${value.map(item => JSON.stringify(item)).join(', ')}]`
	return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function frontMatter(entry: CompassEntry): string {
	const fields: [string, YamlValue | undefined][] = [
		['title', entry.title],
		['kind', entry.kind],
		['category', entry.category || undefined],
		['tags', entry.tags.length > 0 ? entry.tags : undefined],
		['pinned', entry.pinned || undefined],
		['state', entry.state === 'active' ? undefined : entry.state],
		['created', entry.created],
		['updated', entry.updated],
		['revision', entry.revision],
	]
	const lines = fields
		.filter((field): field is [string, YamlValue] => field[1] !== undefined)
		.map(([key, value]) => `${key}: ${yaml(value)}`)
	return ['---', ...lines, '---'].join('\n')
}

// Authored plain text (titles, quotes, tags) must read literally, never as Markdown or HTML.
function plain(text: string): string {
	return escapeInline(text.replace(/\s*\n\s*/g, ' ').trim())
}

function quoteBlock(text: string): string {
	return text.split('\n')
		.map(line => line.trim() === '' ? '>' : `> ${escapeBlockStart(escapeInline(line.trim()))}`)
		.join('\n')
}

function entryBody(entry: CompassEntry, headingLevel: number, images?: MarkdownImageOptions): string {
	const parts = [`${'#'.repeat(headingLevel)} ${plain(entry.title)}`]
	if (entry.subtitle.trim() !== '') parts.push(`*${plain(entry.subtitle)}*`)
	if (entry.quote.trim() !== '') parts.push(quoteBlock(entry.quote.trim()))
	const body = htmlToMarkdown(entry.content, images).trim()
	if (body !== '') parts.push(body)
	return parts.join('\n\n')
}

function note(text: string | undefined): string[] {
	return text ? [quoteBlock(text)] : []
}

/**
 * One entry as a standalone Markdown file with YAML front matter. With `images`, pictures point at the files
 * saved next to it; without, they keep their `compass-image:{id}` reference and `imagesNote` says so.
 */
export function compassEntryToMarkdown(entry: CompassEntry, images?: MarkdownImageOptions, imagesNote?: string): string {
	return [frontMatter(entry), ...note(imagesNote), entryBody(entry, 1, images)].join('\n\n') + '\n'
}

function anchorFor(index: number): string {
	return `entry-${index + 1}`
}

/** A whole space as one file: title, motto, contents, then every entry under its own heading. */
export function compassSpaceToMarkdown(space: CompassSpace, entries: CompassEntry[], labels: CompassExportLabels, images?: MarkdownImageOptions): string {
	const parts = [`# ${plain(space.title)}`]
	if (space.motto.trim() !== '') parts.push(quoteBlock(space.motto.trim()))
	parts.push(`*${plain(labels.exportedFrom)}*`)
	parts.push(...note(labels.imagesNote))
	const introduction = htmlToMarkdown(space.introduction).trim()
	if (introduction !== '') parts.push(introduction)
	if (entries.length > 0) {
		parts.push(`## ${plain(labels.contents)}`)
		parts.push(entries
			.map((entry, index) => `${index + 1}. [${plain(entry.title)}](#${anchorFor(index)}) — ${plain(labels.kind(entry))}`)
			.join('\n'))
	}
	entries.forEach((entry, index) => {
		const meta = [
			labels.kind(entry),
			entry.category,
			entry.tags.map(tag => `#${tag}`).join(' '),
		].filter(part => part.trim() !== '').map(plain).join(' · ')
		parts.push('---')
		parts.push(`<a id="${anchorFor(index)}"></a>`)
		parts.push(entryBody(entry, 2, images))
		if (meta !== '') parts.push(`<sub>${meta}</sub>`)
	})
	return `${parts.join('\n\n')}\n`
}

const UNSAFE_FILENAME = /[\\/:*?"<>|]+/g

function isControl(character: string): boolean {
	const code = character.charCodeAt(0)
	return code < 32 || code === 127
}

/** A file name without extension that keeps CJK and spaces but nothing a file system rejects. */
export function compassExportBaseName(title: string, fallback = 'compass'): string {
	const cleaned = Array.from(title.replace(UNSAFE_FILENAME, ' '))
		.map(character => isControl(character) ? ' ' : character)
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
	const short = Array.from(cleaned).slice(0, 80).join('').trim()
	return short || fallback
}

export function compassMarkdownFilename(title: string, fallback = 'compass'): string {
	return `${compassExportBaseName(title, fallback)}.md`
}

export function downloadCompassMarkdown(markdown: string, filename: string) {
	downloadCompassFile(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}), filename)
}

export function downloadCompassFile(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	link.rel = 'noopener'
	document.body.appendChild(link)
	link.click()
	link.remove()
	// Revoking right away can cancel the download in some browsers.
	setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
