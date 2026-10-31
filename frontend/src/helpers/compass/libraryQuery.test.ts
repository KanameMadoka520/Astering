import {describe, expect, it} from 'vitest'

import {
	compassEntryFiltersFor,
	compassLibraryStateToQuery,
	DEFAULT_COMPASS_LIBRARY_STATE,
	isCompassLibraryNarrowed,
	parseCompassLibraryQuery,
	withCompassLibraryChange,
	type CompassLibraryState,
} from './libraryQuery'

const narrowed: CompassLibraryState = {
	q: 'sea',
	kind: 'memory',
	category: 'Travel',
	tag: '海',
	state: 'trashed',
	pinned: true,
	sort: 'title',
	page: 3,
}

describe('parseCompassLibraryQuery', () => {
	it('reads an empty URL as the default library', () => {
		expect(parseCompassLibraryQuery({})).toEqual(DEFAULT_COMPASS_LIBRARY_STATE)
	})

	it('reads every filter from the URL', () => {
		expect(parseCompassLibraryQuery({
			q: '  sea  ',
			kind: 'memory',
			category: ' Travel ',
			tag: '海',
			state: 'trashed',
			pinned: '1',
			sort: 'title',
			page: '3',
		})).toEqual(narrowed)
	})

	it('drops values the API would refuse instead of sending them', () => {
		expect(parseCompassLibraryQuery({
			kind: 'Memory',
			state: 'deleted',
			sort: 'relevance',
			pinned: 'yes',
		})).toEqual(DEFAULT_COMPASS_LIBRARY_STATE)
	})

	it('takes the first of repeated parameters and ignores valueless ones', () => {
		expect(parseCompassLibraryQuery({
			kind: ['vision', 'memory'],
			tag: [null, 'craft'],
			q: null,
		})).toEqual({
			...DEFAULT_COMPASS_LIBRARY_STATE,
			kind: 'vision',
		})
	})

	it('falls back to page 1 for anything but a positive whole number', () => {
		for (const page of ['0', '-2', '2.5', 'abc', '']) {
			expect(parseCompassLibraryQuery({page}).page).toBe(1)
		}
		expect(parseCompassLibraryQuery({page: '12'}).page).toBe(12)
	})
})

describe('compassLibraryStateToQuery', () => {
	it('keeps the URL clean for the default library', () => {
		expect(compassLibraryStateToQuery(DEFAULT_COMPASS_LIBRARY_STATE)).toStrictEqual({})
	})

	it('writes only what differs from the default', () => {
		expect(compassLibraryStateToQuery({
			...DEFAULT_COMPASS_LIBRARY_STATE,
			state: 'all',
			page: 2,
		})).toStrictEqual({
			state: 'all',
			page: '2',
		})
	})

	it('round-trips through the URL so Back restores the same search', () => {
		const query = compassLibraryStateToQuery(narrowed)

		expect(query).toStrictEqual({
			q: 'sea',
			kind: 'memory',
			category: 'Travel',
			tag: '海',
			state: 'trashed',
			pinned: '1',
			sort: 'title',
			page: '3',
		})
		expect(parseCompassLibraryQuery(query as Record<string, string>)).toEqual(narrowed)
	})
})

describe('withCompassLibraryChange', () => {
	it('starts again at page 1 and keeps the other filters', () => {
		const next = withCompassLibraryChange(narrowed, {kind: 'vision'})

		expect(next).toEqual({
			...narrowed,
			kind: 'vision',
			page: 1,
		})
		expect(narrowed.page).toBe(3)
		expect(narrowed.kind).toBe('memory')
	})
})

describe('compassEntryFiltersFor', () => {
	it('sends nothing for the default library, so it shares one cache key', () => {
		expect(compassEntryFiltersFor(DEFAULT_COMPASS_LIBRARY_STATE)).toStrictEqual({})
	})

	it('leaves the page to the query key and sends pinned as a flag', () => {
		expect(compassEntryFiltersFor(narrowed)).toStrictEqual({
			q: 'sea',
			kind: 'memory',
			category: 'Travel',
			tag: '海',
			state: 'trashed',
			pinned: true,
			sort: 'title',
		})
		expect(compassEntryFiltersFor({...narrowed, page: 1})).toStrictEqual(compassEntryFiltersFor(narrowed))
	})
})

describe('isCompassLibraryNarrowed', () => {
	it('is false for the default list, whatever the order or page', () => {
		expect(isCompassLibraryNarrowed(DEFAULT_COMPASS_LIBRARY_STATE)).toBe(false)
		expect(isCompassLibraryNarrowed({
			...DEFAULT_COMPASS_LIBRARY_STATE,
			sort: 'title',
			page: 4,
		})).toBe(false)
	})

	it('is true as soon as a filter or another state changes which entries are listed', () => {
		const changes: Partial<CompassLibraryState>[] = [
			{q: 'sea'},
			{kind: 'note'},
			{category: 'Travel'},
			{tag: 'craft'},
			{state: 'archived'},
			{state: 'all'},
			{pinned: true},
		]
		for (const change of changes) {
			expect(isCompassLibraryNarrowed({...DEFAULT_COMPASS_LIBRARY_STATE, ...change})).toBe(true)
		}
	})
})
