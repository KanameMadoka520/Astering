import {describe, expect, it} from 'vitest'

import {
	COMPASS_LIMITS,
	isCompassEntryState,
	isCompassEntryTheme,
	isCompassKind,
	isCompassSort,
	isCompassStateFilter,
	isCompassTheme,
	resolveCompassTheme,
	runeLength,
	utf8Bytes,
} from './constants'

describe('resolveCompassTheme', () => {
	it('paints an entry in its own theme, and in the space theme when it inherits', () => {
		expect(resolveCompassTheme('solar', 'ink')).toBe('solar')
		expect(resolveCompassTheme('inherit', 'nebula')).toBe('nebula')
		expect(resolveCompassTheme(undefined, 'ink')).toBe('ink')
	})

	it('falls back to aurora while the space is not loaded yet', () => {
		expect(resolveCompassTheme('inherit', undefined)).toBe('aurora')
		expect(resolveCompassTheme(undefined, undefined)).toBe('aurora')
	})
})

describe('runeLength', () => {
	it('counts characters like the server does, not UTF-16 units', () => {
		// U+20000 is a CJK Extension B character outside the BMP: two UTF-16 units, one rune.
		const title = '星图𠀀a'

		expect(title.length).toBe(5)
		expect(runeLength(title)).toBe(4)
		expect(runeLength('')).toBe(0)
	})
})

describe('utf8Bytes', () => {
	it('measures content the way the server limits it', () => {
		expect(utf8Bytes('a')).toBe(1)
		expect(utf8Bytes('é')).toBe(2)
		expect(utf8Bytes('星')).toBe(3)
		expect(utf8Bytes('𠀀')).toBe(4)
		expect(utf8Bytes('<p>星</p>')).toBe(10)
	})

	it('uses the byte limits of the API', () => {
		// pkg/models/compass.go: len(Content) > 2097152, len(Introduction) > 65536.
		expect(COMPASS_LIMITS.contentBytes).toBe(2_097_152)
		expect(COMPASS_LIMITS.introductionBytes).toBe(65_536)
	})
})

describe('enum guards', () => {
	it('accepts only the exact lower-case values', () => {
		expect(isCompassKind('principle')).toBe(true)
		expect(isCompassKind('Principle')).toBe(false)
		expect(isCompassKind('guide')).toBe(false)
		expect(isCompassKind(1)).toBe(false)
		expect(isCompassKind(undefined)).toBe(false)
	})

	it('keeps "inherit" an entry-only theme', () => {
		expect(isCompassEntryTheme('inherit')).toBe(true)
		expect(isCompassTheme('inherit')).toBe(false)
		expect(isCompassTheme('aurora')).toBe(true)
		expect(isCompassEntryTheme('aurora')).toBe(true)
		expect(isCompassTheme('sunset')).toBe(false)
	})

	it('keeps "all" a filter, never a state an entry can have', () => {
		expect(isCompassStateFilter('all')).toBe(true)
		expect(isCompassEntryState('all')).toBe(false)
		expect(isCompassEntryState('trashed')).toBe(true)
		expect(isCompassStateFilter('deleted')).toBe(false)
	})

	it('knows the three sort orders', () => {
		expect(isCompassSort('updated')).toBe(true)
		expect(isCompassSort('created')).toBe(true)
		expect(isCompassSort('title')).toBe(true)
		expect(isCompassSort('relevance')).toBe(false)
		expect(isCompassSort(null)).toBe(false)
	})
})
