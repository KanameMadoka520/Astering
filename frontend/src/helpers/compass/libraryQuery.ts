import type {LocationQuery, LocationQueryRaw} from 'vue-router'
import type {CompassEntryFilters} from '@/client/queries/compass'
import {normalizePageNumber} from '@/client/queries/pagination'
import {
	isCompassKind,
	isCompassSort,
	isCompassStateFilter,
	type CompassKind,
	type CompassSort,
	type CompassStateFilter,
} from './constants'

/** The library's filters as the URL holds them, so Back restores a search. */
export type CompassLibraryState = {
	q: string
	kind: CompassKind | ''
	category: string
	tag: string
	state: CompassStateFilter
	pinned: boolean
	sort: CompassSort
	page: number
}

export const DEFAULT_COMPASS_LIBRARY_STATE: CompassLibraryState = {
	q: '',
	kind: '',
	category: '',
	tag: '',
	state: 'active',
	pinned: false,
	sort: 'updated',
	page: 1,
}

function single(value: LocationQuery[string] | undefined): string {
	const first = Array.isArray(value) ? value[0] : value
	return typeof first === 'string' ? first : ''
}

export function parseCompassLibraryQuery(query: LocationQuery): CompassLibraryState {
	const kind = single(query.kind)
	const state = single(query.state)
	const sort = single(query.sort)
	return {
		q: single(query.q).trim(),
		kind: isCompassKind(kind) ? kind : '',
		category: single(query.category).trim(),
		tag: single(query.tag).trim(),
		state: isCompassStateFilter(state) ? state : 'active',
		pinned: single(query.pinned) === '1',
		sort: isCompassSort(sort) ? sort : 'updated',
		page: normalizePageNumber(single(query.page) || 1),
	}
}

/** Only non-default values go into the URL. */
export function compassLibraryStateToQuery(state: CompassLibraryState): LocationQueryRaw {
	const query: LocationQueryRaw = {}
	if (state.q !== '') query.q = state.q
	if (state.kind !== '') query.kind = state.kind
	if (state.category !== '') query.category = state.category
	if (state.tag !== '') query.tag = state.tag
	if (state.state !== 'active') query.state = state.state
	if (state.pinned) query.pinned = '1'
	if (state.sort !== 'updated') query.sort = state.sort
	if (state.page > 1) query.page = String(state.page)
	return query
}

/** Any change to what is listed starts again at page 1. */
export function withCompassLibraryChange(state: CompassLibraryState, change: Partial<Omit<CompassLibraryState, 'page'>>): CompassLibraryState {
	return {
		...state,
		...change,
		page: 1,
	}
}

export function compassEntryFiltersFor(state: CompassLibraryState): CompassEntryFilters {
	const filters: CompassEntryFilters = {}
	if (state.q !== '') filters.q = state.q
	if (state.kind !== '') filters.kind = state.kind
	if (state.category !== '') filters.category = state.category
	if (state.tag !== '') filters.tag = state.tag
	if (state.state !== 'active') filters.state = state.state
	if (state.pinned) filters.pinned = true
	if (state.sort !== 'updated') filters.sort = state.sort
	return filters
}

/** Whether anything narrows the list beyond the default "active, newest first". */
export function isCompassLibraryNarrowed(state: CompassLibraryState): boolean {
	return state.q !== '' || state.kind !== '' || state.category !== '' || state.tag !== '' ||
		state.state !== 'active' || state.pinned
}
