export const COMPASS_KINDS = ['principle', 'vision', 'action', 'memory', 'note'] as const
export type CompassKind = typeof COMPASS_KINDS[number]

export const COMPASS_THEMES = ['aurora', 'solar', 'nebula', 'ink'] as const
export type CompassTheme = typeof COMPASS_THEMES[number]

export const COMPASS_ENTRY_THEMES = ['inherit', ...COMPASS_THEMES] as const
export type CompassEntryTheme = typeof COMPASS_ENTRY_THEMES[number]

export const COMPASS_ENTRY_STATES = ['active', 'archived', 'trashed'] as const
export type CompassEntryState = typeof COMPASS_ENTRY_STATES[number]

// What the library can ask for: `all` is active plus archived, never the trash.
export const COMPASS_STATE_FILTERS = ['active', 'archived', 'all', 'trashed'] as const
export type CompassStateFilter = typeof COMPASS_STATE_FILTERS[number]

export const COMPASS_SORTS = ['updated', 'created', 'title'] as const
export type CompassSort = typeof COMPASS_SORTS[number]

export const COMPASS_DEFAULT_THEME: CompassTheme = 'aurora'

// How strongly a space's background photo is veiled so the title stays readable.
export const COMPASS_BACKGROUND_SCRIMS = ['soft', 'medium', 'strong'] as const
export type CompassBackgroundScrim = typeof COMPASS_BACKGROUND_SCRIMS[number]

// Server limits (v31 contract); counted in characters (runes) except content, which is bytes.
export const COMPASS_LIMITS = {
	spaceTitle: 80,
	motto: 600,
	introductionBytes: 64 * 1024,
	entryTitle: 200,
	subtitle: 600,
	quote: 1000,
	category: 80,
	tags: 24,
	tag: 40,
	contentBytes: 2 * 1024 * 1024,
} as const

export const COMPASS_ERROR_CODES = {
	revisionConflict: 20101,
	missing: 20102,
	invalidState: 20103,
	// A referenced image is not usable in this space (409): not mounted here and not an active image of
	// the saver's own drive.
	imageUnavailable: 20104,
	// More than 100 distinct images in one body.
	imageLimit: 20105,
	// Not JPEG, PNG, GIF or WebP, too large, or not decodable.
	imageUnsupported: 20106,
} as const

export function isCompassKind(value: unknown): value is CompassKind {
	return typeof value === 'string' && (COMPASS_KINDS as readonly string[]).includes(value)
}

export function isCompassTheme(value: unknown): value is CompassTheme {
	return typeof value === 'string' && (COMPASS_THEMES as readonly string[]).includes(value)
}

export function isCompassEntryTheme(value: unknown): value is CompassEntryTheme {
	return typeof value === 'string' && (COMPASS_ENTRY_THEMES as readonly string[]).includes(value)
}

export function isCompassEntryState(value: unknown): value is CompassEntryState {
	return typeof value === 'string' && (COMPASS_ENTRY_STATES as readonly string[]).includes(value)
}

export function isCompassStateFilter(value: unknown): value is CompassStateFilter {
	return typeof value === 'string' && (COMPASS_STATE_FILTERS as readonly string[]).includes(value)
}

export function isCompassSort(value: unknown): value is CompassSort {
	return typeof value === 'string' && (COMPASS_SORTS as readonly string[]).includes(value)
}

/** The theme a page should paint: an entry's own theme, or its space's when it inherits. */
export function resolveCompassTheme(entryTheme: CompassEntryTheme | undefined, spaceTheme: CompassTheme | undefined): CompassTheme {
	if (entryTheme && entryTheme !== 'inherit') return entryTheme
	return spaceTheme ?? COMPASS_DEFAULT_THEME
}

/** Characters as the server counts them (runes), so a CJK title is not cut at half its length. */
export function runeLength(value: string): number {
	return Array.from(value).length
}

export function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length
}
