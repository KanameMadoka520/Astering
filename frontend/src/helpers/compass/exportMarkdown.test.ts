// @vitest-environment jsdom
// happy-dom breaks DOMPurify (empty nodeName via Node.prototype)
import {afterEach, describe, expect, it, vi} from 'vitest'

import type {CompassEntry, CompassSpace} from '@/client/queries/compass'
import type {CompassKind} from './constants'
import {
	compassEntryToMarkdown,
	compassMarkdownFilename,
	compassSpaceToMarkdown,
	downloadCompassMarkdown,
	type CompassExportLabels,
} from './exportMarkdown'

const KIND_LABELS: Record<CompassKind, string> = {
	principle: 'Principle',
	vision: 'Vision',
	action: 'Action',
	memory: 'Memory',
	note: 'Note',
}

const labels: CompassExportLabels = {
	kind: entry => KIND_LABELS[entry.kind],
	exportedFrom: 'Exported from Vikunja on 1 November 2026',
	contents: 'Contents',
}

function entry(overrides: Partial<CompassEntry>): CompassEntry {
	return {
		id: 5,
		space_id: 3,
		kind: 'note',
		title: 'Untitled',
		subtitle: '',
		content: '',
		quote: '',
		category: '',
		tags: [],
		theme: 'inherit',
		pinned: false,
		state: 'active',
		revision: 1,
		created: undefined,
		updated: undefined,
		created_by_id: 1,
		updated_by_id: 1,
		excerpt: '',
		content_bytes: 0,
		max_permission: 2,
		...overrides,
	}
}

const space: CompassSpace = {
	id: 3,
	owner_id: 1,
	team_id: 0,
	title: 'North',
	motto: 'Keep going\nand look up',
	introduction: '<p>Why this <em>exists</em>.</p>',
	theme: 'aurora',
	revision: 2,
	created: '2026-09-01T08:00:00Z',
	updated: '2026-10-30T09:30:00Z',
	max_permission: 2,
	entry_count: 2,
	pinned_count: 1,
}

describe('compassEntryToMarkdown', () => {
	it('writes front matter, title, subtitle, quote and body', () => {
		expect(compassEntryToMarkdown(entry({
			kind: 'principle',
			title: 'Stay curious',
			subtitle: 'Money is a means',
			quote: 'First line\n\n- not a list',
			content: '<h2>Why</h2><p>Freedom to <strong>create</strong>.</p>',
			category: 'Life',
			tags: ['freedom', 'craft'],
			pinned: true,
			state: 'archived',
			revision: 4,
			created: '2026-10-01T08:00:00Z',
			updated: '2026-10-30T09:30:00Z',
		}))).toBe([
			'---',
			'title: "Stay curious"',
			'kind: "principle"',
			'category: "Life"',
			'tags: ["freedom", "craft"]',
			'pinned: true',
			'state: "archived"',
			'created: "2026-10-01T08:00:00Z"',
			'updated: "2026-10-30T09:30:00Z"',
			'revision: 4',
			'---',
			'',
			'# Stay curious',
			'',
			'*Money is a means*',
			'',
			'> First line',
			'>',
			'> \\- not a list',
			'',
			'## Why',
			'',
			'Freedom to **create**.',
			'',
		].join('\n'))
	})

	it('leaves defaults and unknown times out of the front matter and quotes YAML safely', () => {
		expect(compassEntryToMarkdown(entry({title: 'Re: "home" #1'}))).toBe([
			'---',
			'title: "Re: \\"home\\" #1"',
			'kind: "note"',
			'revision: 1',
			'---',
			'',
			'# Re: "home" #1',
			'',
		].join('\n'))
	})

	it('shows authored plain text literally instead of as Markdown or HTML', () => {
		const markdown = compassEntryToMarkdown(entry({
			title: 'Notes on *craft* <img src=x onerror=alert(1)>',
			subtitle: 'snake_case\nand more',
			quote: '# Not a heading\n<script>x</script>',
		}))

		expect(markdown).toContain('\n# Notes on \\*craft\\* \\<img src=x onerror=alert(1)\\>\n')
		expect(markdown).toContain('\n*snake\\_case and more*\n')
		expect(markdown).toContain('\n> \\# Not a heading\n> \\<script\\>x\\</script\\>\n')
		// Front matter is JSON-quoted and never rendered.
		expect(markdown).toContain('title: "Notes on *craft* <img src=x onerror=alert(1)>"')
	})
})

describe('compassSpaceToMarkdown', () => {
	it('writes the space, a linked table of contents and every entry', () => {
		const entries = [
			entry({
				kind: 'principle',
				title: 'Stay curious',
				content: '<p>Body A</p>',
				category: 'Life',
				tags: ['craft'],
			}),
			entry({
				id: 6,
				kind: 'memory',
				title: 'The sea',
			}),
		]

		expect(compassSpaceToMarkdown(space, entries, labels)).toBe([
			'# North',
			'> Keep going\n> and look up',
			'*Exported from Vikunja on 1 November 2026*',
			'Why this *exists*.',
			'## Contents',
			'1. [Stay curious](#entry-1) — Principle\n2. [The sea](#entry-2) — Memory',
			'---',
			'<a id="entry-1"></a>',
			'## Stay curious\n\nBody A',
			'<sub>Principle · Life · #craft</sub>',
			'---',
			'<a id="entry-2"></a>',
			'## The sea',
			'<sub>Memory</sub>',
		].join('\n\n') + '\n')
	})

	it('writes only the title for an empty space', () => {
		expect(compassSpaceToMarkdown({...space, motto: ' ', introduction: '<p></p>'}, [], labels))
			.toBe('# North\n\n*Exported from Vikunja on 1 November 2026*\n')
	})

	it('keeps a team member\'s text from becoming markup in someone else\'s export', () => {
		const markdown = compassSpaceToMarkdown({...space, title: 'Team <b>space</b>'}, [entry({
			kind: 'principle',
			title: 'A [link](https://evil.example)',
			category: '</sub><img src=x onerror=alert(1)>',
			tags: ['a|b'],
		})], labels)

		expect(markdown.startsWith('# Team \\<b\\>space\\</b\\>\n')).toBe(true)
		expect(markdown).toContain('1. [A \\[link\\](https://evil.example)](#entry-1) — Principle')
		expect(markdown).toContain('<sub>Principle · \\</sub\\>\\<img src=x onerror=alert(1)\\> · #a\\|b</sub>')
		expect(markdown).not.toMatch(/(^|[^\\])<img/)
	})
})

describe('compassMarkdownFilename', () => {
	it('keeps CJK and spaces and replaces what file systems reject', () => {
		expect(compassMarkdownFilename('我的原则：自由 / 创造')).toBe('我的原则：自由 创造.md')
		expect(compassMarkdownFilename('a<b>:c*?"d|e\\f')).toBe('a b c d e f.md')
		expect(compassMarkdownFilename('line\u0007break\ttab')).toBe('line break tab.md')
	})

	it('never starts with a dot and falls back for an empty name', () => {
		expect(compassMarkdownFilename('...hidden')).toBe('hidden.md')
		expect(compassMarkdownFilename('   ')).toBe('compass.md')
		expect(compassMarkdownFilename('/:*', 'entry')).toBe('entry.md')
	})

	it('shortens to 80 characters without splitting one', () => {
		expect(compassMarkdownFilename('星'.repeat(100))).toBe(`${'星'.repeat(80)}.md`)
		expect(compassMarkdownFilename('𠀀'.repeat(81))).toBe(`${'𠀀'.repeat(80)}.md`)
	})
})

describe('downloadCompassMarkdown', () => {
	const createObjectURL = URL.createObjectURL
	const revokeObjectURL = URL.revokeObjectURL

	afterEach(() => {
		URL.createObjectURL = createObjectURL
		URL.revokeObjectURL = revokeObjectURL
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('downloads a UTF-8 Markdown file and releases it only later', () => {
		vi.useFakeTimers()
		const create = vi.fn((_blob: Blob) => 'blob:compass-export')
		const revoke = vi.fn()
		URL.createObjectURL = create
		URL.revokeObjectURL = revoke
		const clicks: {href: string | null, download: string, connected: boolean}[] = []
		vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
			const link = this as HTMLAnchorElement
			clicks.push({
				href: link.getAttribute('href'),
				download: link.download,
				connected: link.isConnected,
			})
		})

		downloadCompassMarkdown('# 星\n', '星图.md')

		const blob = create.mock.calls[0][0]
		expect(blob.type).toBe('text/markdown;charset=utf-8')
		expect(blob.size).toBe(6)
		expect(clicks).toEqual([{href: 'blob:compass-export', download: '星图.md', connected: true}])
		expect(document.querySelector('a[download]')).toBeNull()
		expect(revoke).not.toHaveBeenCalled()

		vi.advanceTimersByTime(60_000)

		expect(revoke).toHaveBeenCalledWith('blob:compass-export')
	})
})
