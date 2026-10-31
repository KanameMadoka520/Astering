import {sanitizeAnnouncement} from '@/helpers/sanitizeAnnouncement'

/**
 * Converts an entry body to CommonMark (plus GFM tables and strikethrough). Works on the sanitized
 * markup, so it only has to know the tags the reader can show; anything else keeps its text.
 * Formatting Markdown cannot express (underline, highlight, sub/superscript) stays as inline HTML,
 * which common Markdown readers render.
 */
export function htmlToMarkdown(html: string): string {
	if (html.trim() === '') return ''
	const template = document.createElement('template')
	template.innerHTML = sanitizeAnnouncement(html)
	return finish(blocks(template.content))
}

// Block builders already insert their own separators. Do not normalize the assembled text:
// fenced code can begin directly after a list marker or inside a blockquote, and its blank
// lines are authored content rather than extra paragraph spacing.
function finish(markdown: string): string {
	const trimmed = markdown.trim()
	return trimmed === '' ? '' : `${trimmed}\n`
}

const BLOCK_TAGS = new Set([
	'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'HR', 'TABLE', 'LI',
	'THEAD', 'TBODY', 'TR', 'TH', 'TD',
])

function isBlock(node: Node): boolean {
	return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.nodeName)
}

/** Block-level children of a container, separated by blank lines. Stray inline runs become paragraphs. */
function blocks(container: Node): string {
	const out: string[] = []
	let inlineRun: Node[] = []
	const flushInline = () => {
		const text = trimInline(inlineText(inlineRun))
		if (text !== '') out.push(escapeBlockStart(text))
		inlineRun = []
	}
	for (const child of Array.from(container.childNodes)) {
		if (isBlock(child)) {
			flushInline()
			const block = blockToMarkdown(child as Element)
			if (block !== '') out.push(block)
		} else {
			inlineRun.push(child)
		}
	}
	flushInline()
	return out.join('\n\n')
}

function blockToMarkdown(element: Element): string {
	switch (element.nodeName) {
		case 'P': {
			const text = trimInline(inlineText(Array.from(element.childNodes)))
			return text === '' ? '' : escapeBlockStart(text)
		}
		case 'H1':
		case 'H2':
		case 'H3':
		case 'H4':
		case 'H5':
		case 'H6': {
			const text = softenBreaks(inlineText(Array.from(element.childNodes))).replace(/\s*\n\s*/g, ' ').trim()
			return text === '' ? '' : `${'#'.repeat(Number(element.nodeName[1]))} ${text}`
		}
		case 'BLOCKQUOTE': {
			const inner = blocks(element)
			return inner === '' ? '' : prefixLines(inner, '> ', '>')
		}
		case 'UL':
		case 'OL':
			return list(element)
		case 'PRE':
			return codeBlock(element)
		case 'HR':
			return '---'
		case 'TABLE':
			return table(element)
		default:
			// A table part or list item outside its parent: keep the text.
			return blocks(element)
	}
}

function prefixLines(text: string, prefix: string, emptyPrefix = prefix.trimEnd()): string {
	return text.split('\n').map(line => line === '' ? emptyPrefix : `${prefix}${line}`).join('\n')
}

function list(element: Element): string {
	const ordered = element.nodeName === 'OL'
	const start = ordered ? Number(element.getAttribute('start') ?? '1') || 1 : 1
	const items = Array.from(element.children).filter(child => child.nodeName === 'LI')
	return items.map((item, index) => {
		const marker = ordered ? `${start + index}. ` : '- '
		const body = listItem(item)
		const indent = ' '.repeat(marker.length)
		const lines = body === '' ? [''] : body.split('\n')
		return [
			`${marker}${lines[0]}`.trimEnd(),
			...lines.slice(1).map(line => line === '' ? '' : `${indent}${line}`),
		].join('\n')
	}).join('\n')
}

// A list item from the editor wraps its text in <p>; one paragraph stays a tight item.
function listItem(item: Element): string {
	const children = Array.from(item.childNodes)
	const paragraphs = children.filter(child => child.nodeName === 'P')
	const nested = children.filter(child => child.nodeName === 'UL' || child.nodeName === 'OL')
	const others = children.filter(child => isBlock(child) && child.nodeName !== 'P' && !nested.includes(child))
	if (paragraphs.length <= 1 && others.length === 0) {
		const textNodes = children.filter(child => !nested.includes(child))
		const text = trimInline(paragraphs.length === 1
			? inlineText(Array.from(paragraphs[0].childNodes))
			: inlineText(textNodes))
		const sublists = nested.map(node => list(node as Element))
		return [escapeBlockStart(text), ...sublists].filter(part => part !== '').join('\n')
	}
	return blocks(item)
}

function codeBlock(element: Element): string {
	const code = (element.textContent ?? '').replace(/\n$/, '')
	const longestRun = Math.max(2, ...Array.from(code.matchAll(/`+/g), match => match[0].length))
	const fence = '`'.repeat(longestRun + 1)
	return `${fence}\n${code}\n${fence}`
}

function table(element: Element): string {
	const rows = Array.from(element.querySelectorAll('tr'))
		.map(row => Array.from(row.children)
			.filter(cell => cell.nodeName === 'TH' || cell.nodeName === 'TD')
			.map(cell => tableCell(cell)))
		.filter(row => row.length > 0)
	if (rows.length === 0) return ''
	const width = Math.max(...rows.map(row => row.length))
	const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')]
	const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
	const [header, ...body] = rows
	return [
		line(header),
		`| ${Array<string>(width).fill('---').join(' | ')} |`,
		...body.map(line),
	].join('\n')
}

function tableCell(cell: Element): string {
	const parts: string[] = []
	let run: Node[] = []
	const flush = () => {
		const text = softenBreaks(inlineText(run)).trim()
		if (text !== '') parts.push(text)
		run = []
	}
	for (const child of Array.from(cell.childNodes)) {
		if (isBlock(child)) {
			flush()
			const text = softenBreaks(inlineText(Array.from(child.childNodes))).trim()
			if (text !== '') parts.push(text)
		} else {
			run.push(child)
		}
	}
	flush()
	return parts.join('<br>').replace(/\n/g, '<br>').replace(/\|/g, '\\|')
}

// Text nodes already collapse their own whitespace; joining must not touch code spans.
function inlineText(nodes: Node[]): string {
	return nodes.map(inline).join('')
}

// A hard break is `\` + newline. Authored backslashes are always escaped in pairs, so only an odd run
// of backslashes ends in a break. Markdown has none at the end of a block, in a heading or in a table
// cell: there the backslash would print.

function trimInline(text: string): string {
	const trimmed = text.trim()
	const run = /\\+$/.exec(trimmed)?.[0] ?? ''
	return run.length % 2 === 1 ? trimInline(trimmed.slice(0, -1)) : trimmed
}

function softenBreaks(text: string): string {
	return text.replace(/(\\+)\n/g, (match, slashes: string) => slashes.length % 2 === 1
		? `${slashes.slice(1)}\n`
		: match)
}

function inline(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = escapeInline((node.textContent ?? '').replace(/\s+/g, ' '))
		// `!` right before a link would make it an image.
		return node.nextSibling?.nodeName === 'A' ? text.replace(/!$/, '\\!') : text
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return ''
	const element = node as Element
	const children = () => inlineText(Array.from(element.childNodes))
	switch (element.nodeName) {
		case 'BR':
			return '\\\n'
		case 'STRONG':
		case 'B':
			return wrap(children(), '**')
		case 'EM':
		case 'I':
			return wrap(children(), '*')
		case 'S':
		case 'DEL':
			return wrap(children(), '~~')
		case 'U':
			return wrapHtml(children(), 'u')
		case 'MARK':
			return wrapHtml(children(), 'mark')
		case 'SUB':
			return wrapHtml(children(), 'sub')
		case 'SUP':
			return wrapHtml(children(), 'sup')
		case 'CODE':
			return inlineCode(element.textContent ?? '')
		case 'A':
			return link(element, children())
		default:
			return isBlock(element) ? `\n${blocks(element)}\n` : children()
	}
}

// Emphasis markers must hug the text: move edge spaces outside so `** bold**` cannot happen.
function wrap(text: string, marker: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
	if (!match || match[2] === '') return text
	return `${match[1]}${marker}${match[2]}${marker}${match[3]}`
}

function wrapHtml(text: string, tag: string): string {
	return text.trim() === '' ? text : `<${tag}>${text}</${tag}>`
}

function inlineCode(code: string): string {
	if (code === '') return ''
	const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), match => match[0].length))
	const fence = '`'.repeat(longestRun + 1)
	const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : ''
	return `${fence}${pad}${code}${pad}${fence}`
}

function link(element: Element, text: string): string {
	const href = element.getAttribute('href') ?? ''
	if (href === '') return text
	const label = text.trim() === '' ? escapeInline(href) : text
	// Angle brackets allow spaces and parentheses in the destination.
	const destination = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href
	return `[${label}](${destination})`
}

/** Escapes authored plain text so Markdown shows it literally. */
export function escapeInline(text: string): string {
	return text
		.replace(/[\\`*_[\]<>~|]/g, '\\$&')
		// Only an ampersand that would form an entity ("&amp;") changes meaning.
		.replace(/&(?=#?\w+;)/g, '\\&')
}

// Text that would otherwise start a heading, quote, list or rule at the beginning of a line.
export function escapeBlockStart(text: string): string {
	return text.split('\n').map(line => line
		.replace(/^(\s*)([#>+=-])/, '$1\\$2')
		.replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4')).join('\n')
}
