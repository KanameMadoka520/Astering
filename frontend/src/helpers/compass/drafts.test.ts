import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
	changedCompassDraftFields,
	clearCompassDraft,
	compassDraftKey,
	emptyCompassDraftFields,
	hasCompassDraft,
	isBlankCompassHtml,
	loadCompassDraft,
	saveCompassDraft,
	type CompassDraft,
	type CompassDraftFields,
} from './drafts'
import {compassAccountNamespace} from './storage'

const namespace = compassAccountNamespace('https://a.example/api/v2', 7)
const key = compassDraftKey(namespace, 3, 12)

const fields: CompassDraftFields = {
	kind: 'principle',
	title: 'Stay curious',
	subtitle: 'Why it matters',
	content: '<p>Money is a means.</p>',
	quote: 'Freedom to create',
	category: 'Life',
	tags: ['freedom', 'craft'],
	theme: 'solar',
	pinned: false,
}

const draft: CompassDraft = {
	v: 1,
	spaceId: 3,
	entryId: 12,
	baseRevision: 4,
	savedAt: '2026-10-31T21:00:00.000Z',
	fields,
}

function store(value: unknown) {
	localStorage.setItem(key, JSON.stringify(value))
}

beforeEach(() => {
	localStorage.clear()
})

afterEach(() => {
	vi.unstubAllGlobals()
	clearCompassDraft(key)
	localStorage.clear()
})

describe('compassDraftKey', () => {
	it('keys a draft by account, API server, space and entry', () => {
		expect(key).toBe(`tcymc-compass-draft:v1:${namespace}:3:12`)
		expect(compassDraftKey(namespace, 3, 0)).toBe(`tcymc-compass-draft:v1:${namespace}:3:new`)
		expect(compassDraftKey(namespace, 3, -1)).toBe(compassDraftKey(namespace, 3, 0))
		expect(compassDraftKey(compassAccountNamespace('https://a.example/api/v2', 8), 3, 12)).not.toBe(key)
	})
})

describe('saving and loading', () => {
	it('restores exactly what was saved', () => {
		expect(saveCompassDraft(key, draft)).toBe(true)

		expect(hasCompassDraft(key)).toBe(true)
		expect(loadCompassDraft(key, 3, 12)).toEqual(draft)
	})

	it('never hands a draft to another space or entry', () => {
		saveCompassDraft(key, draft)

		expect(loadCompassDraft(key, 4, 12)).toBeNull()
		expect(loadCompassDraft(key, 3, 13)).toBeNull()
		expect(loadCompassDraft(key, 3, 0)).toBeNull()
	})

	it('loads the draft of a new entry', () => {
		const newKey = compassDraftKey(namespace, 3, 0)
		saveCompassDraft(newKey, {...draft, entryId: 0, baseRevision: 0})

		expect(loadCompassDraft(newKey, 3, 0)?.fields.title).toBe('Stay curious')
		expect(loadCompassDraft(newKey, 3, 12)).toBeNull()
		clearCompassDraft(newKey)
	})

	it('rejects drafts of another format or with unreadable text', () => {
		store({...draft, v: 2})
		expect(loadCompassDraft(key, 3, 12)).toBeNull()

		store({...draft, fields: {...fields, title: 5}})
		expect(loadCompassDraft(key, 3, 12)).toBeNull()

		store({...draft, fields: {...fields, tags: ['ok', 3]}})
		expect(loadCompassDraft(key, 3, 12)).toBeNull()

		localStorage.setItem(key, '{not json')
		expect(loadCompassDraft(key, 3, 12)).toBeNull()
	})

	it('repairs metadata it can default without losing the text', () => {
		store({
			...draft,
			baseRevision: '4',
			savedAt: null,
			fields: {
				...fields,
				kind: 'manifesto',
				theme: 'sunset',
				pinned: 'yes',
			},
		})

		expect(loadCompassDraft(key, 3, 12)).toEqual({
			...draft,
			baseRevision: 0,
			savedAt: '',
			fields: {
				...fields,
				kind: 'note',
				theme: 'inherit',
				pinned: false,
			},
		})
	})

	it('keeps a draft for this session when the browser refuses to store it', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => {
				throw new DOMException('Quota exceeded', 'QuotaExceededError')
			},
			removeItem: () => {},
		})

		expect(saveCompassDraft(key, draft)).toBe(false)
		expect(loadCompassDraft(key, 3, 12)).toEqual(draft)

		clearCompassDraft(key)

		expect(hasCompassDraft(key)).toBe(false)
	})

	it('forgets a discarded draft', () => {
		saveCompassDraft(key, draft)

		clearCompassDraft(key)

		expect(hasCompassDraft(key)).toBe(false)
		expect(loadCompassDraft(key, 3, 12)).toBeNull()
	})
})

describe('isBlankCompassHtml', () => {
	it('sees the markup of an emptied editor as blank', () => {
		expect(isBlankCompassHtml('')).toBe(true)
		expect(isBlankCompassHtml('<p></p>')).toBe(true)
		expect(isBlankCompassHtml('<p>&nbsp; </p><p><br></p>')).toBe(true)
	})

	it('sees any text as content', () => {
		expect(isBlankCompassHtml('<p>a</p>')).toBe(false)
		expect(isBlankCompassHtml('<p>&amp;</p>')).toBe(false)
	})

	it('does not inspect long markup', () => {
		expect(isBlankCompassHtml('<p></p>'.repeat(40))).toBe(false)
	})
})

describe('changedCompassDraftFields', () => {
	it('finds nothing in equal fields', () => {
		expect(changedCompassDraftFields(fields, {...fields, tags: [...fields.tags]})).toEqual([])
	})

	it('ignores whitespace at the edges of plain text but not inside it', () => {
		expect(changedCompassDraftFields(fields, {...fields, title: '  Stay curious\n'})).toEqual([])
		expect(changedCompassDraftFields(fields, {...fields, title: 'Stay  curious'})).toEqual(['title'])
	})

	it('treats an emptied editor as equal to no body, and compares bodies exactly otherwise', () => {
		const empty = emptyCompassDraftFields('principle')

		expect(changedCompassDraftFields(empty, {...empty, content: '<p></p>'})).toEqual([])
		expect(changedCompassDraftFields(fields, {...fields, content: '<p>Money is a means. </p>'})).toEqual(['content'])
	})

	it('counts a reordered tag list as a change', () => {
		expect(changedCompassDraftFields(fields, {...fields, tags: ['craft', 'freedom']})).toEqual(['tags'])
	})

	it('lists changes in display order', () => {
		expect(changedCompassDraftFields(fields, {
			...fields,
			pinned: true,
			content: '<p>Other</p>',
			theme: 'inherit',
			kind: 'vision',
			quote: '',
		})).toEqual(['kind', 'quote', 'content', 'theme', 'pinned'])
	})
})

describe('emptyCompassDraftFields', () => {
	it('starts with nothing written and the chosen kind', () => {
		expect(emptyCompassDraftFields('memory')).toEqual({
			kind: 'memory',
			title: '',
			subtitle: '',
			content: '',
			quote: '',
			category: '',
			tags: [],
			theme: 'inherit',
			pinned: false,
		})
		expect(emptyCompassDraftFields().kind).toBe('note')
	})
})
