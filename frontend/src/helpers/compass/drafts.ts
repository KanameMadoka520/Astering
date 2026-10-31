import {
	isCompassEntryTheme,
	isCompassKind,
	type CompassEntryTheme,
	type CompassKind,
} from './constants'
import {COMPASS_IMAGE_ATTRIBUTE} from './images'
import {
	compassStorageKey,
	readCompassJson,
	removeCompassStorage,
	writeCompassStorage,
} from './storage'

/** Everything the writing desk edits. Pin and state are not here: they change elsewhere and must not be rolled back. */
export type CompassDraftFields = {
	kind: CompassKind
	title: string
	subtitle: string
	content: string
	quote: string
	category: string
	tags: string[]
	theme: CompassEntryTheme
	// Only used when creating; an existing entry is pinned from the reader.
	pinned: boolean
}

export const COMPASS_DRAFT_FIELDS: (keyof CompassDraftFields)[] = [
	'kind',
	'title',
	'subtitle',
	'quote',
	'content',
	'category',
	'tags',
	'theme',
	'pinned',
]

export type CompassDraft = {
	v: 1
	spaceId: number
	// 0 while the entry does not exist yet.
	entryId: number
	// The server revision the draft was written against; 0 for a new entry.
	baseRevision: number
	savedAt: string
	fields: CompassDraftFields
}

export function emptyCompassDraftFields(kind: CompassKind = 'note'): CompassDraftFields {
	return {
		kind,
		title: '',
		subtitle: '',
		content: '',
		quote: '',
		category: '',
		tags: [],
		theme: 'inherit',
		pinned: false,
	}
}

/** One key per account, API server, space and entry ("new" for the one unsaved entry per space). */
export function compassDraftKey(namespace: string, spaceId: number, entryId: number): string {
	return compassStorageKey('draft', namespace, spaceId, entryId > 0 ? entryId : 'new')
}

function parseFields(value: unknown): CompassDraftFields | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const strings = ['title', 'subtitle', 'content', 'quote', 'category'] as const
	if (!strings.every(field => typeof record[field] === 'string')) return null
	if (!Array.isArray(record.tags) || !record.tags.every(tag => typeof tag === 'string')) return null
	return {
		kind: isCompassKind(record.kind) ? record.kind : 'note',
		title: record.title as string,
		subtitle: record.subtitle as string,
		content: record.content as string,
		quote: record.quote as string,
		category: record.category as string,
		tags: record.tags as string[],
		theme: isCompassEntryTheme(record.theme) ? record.theme : 'inherit',
		pinned: record.pinned === true,
	}
}

export function loadCompassDraft(key: string, spaceId: number, entryId: number): CompassDraft | null {
	const value = readCompassJson(key)
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	const fields = parseFields(record.fields)
	// A draft that names another space or entry was not written for this page; never mix them.
	if (record.v !== 1 || !fields || record.spaceId !== spaceId || record.entryId !== Math.max(entryId, 0)) return null
	return {
		v: 1,
		spaceId,
		entryId: Math.max(entryId, 0),
		baseRevision: typeof record.baseRevision === 'number' ? record.baseRevision : 0,
		savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
		fields,
	}
}

/** Returns false when the browser refused to persist it; the copy then only lives for this session. */
export function saveCompassDraft(key: string, draft: CompassDraft): boolean {
	return writeCompassStorage(key, JSON.stringify(draft))
}

export function clearCompassDraft(key: string) {
	removeCompassStorage(key)
}

export function hasCompassDraft(key: string): boolean {
	return readCompassJson(key) !== null
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((tag, index) => tag === b[index])
}

// The editor answers an emptied document with markup such as `<p></p>`. Cheap on purpose: this runs on
// every keystroke and bodies can be megabytes, so only short markup is inspected. An image is content
// even without a word around it.
export function isBlankCompassHtml(html: string): boolean {
	return html.length < 256 &&
		!html.includes(COMPASS_IMAGE_ATTRIBUTE) &&
		html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '') === ''
}

/** Fields whose values differ, in display order. Text is compared trimmed at the edges only. */
export function changedCompassDraftFields(a: CompassDraftFields, b: CompassDraftFields): (keyof CompassDraftFields)[] {
	return COMPASS_DRAFT_FIELDS.filter(field => {
		const left = a[field]
		const right = b[field]
		if (Array.isArray(left) && Array.isArray(right)) return !sameTags(left, right)
		if (field === 'content' && typeof left === 'string' && typeof right === 'string') {
			return left !== right && !(isBlankCompassHtml(left) && isBlankCompassHtml(right))
		}
		if (typeof left === 'string' && typeof right === 'string') return left.trim() !== right.trim()
		return left !== right
	})
}
