import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, type MutationOptions, type QueryKey} from '@tanstack/vue-query'

import {ApiError} from '@/client/problem'
import {isRequestContextAbort} from '@/client/requestContext'
import type {CompassEntryState} from '@/helpers/compass/constants'
import {i18n} from '@/i18n'
import {error, success} from '@/message'

const sdk = vi.hoisted(() => ({
	compassEntriesCreate: vi.fn(),
	compassEntriesDelete: vi.fn(),
	compassEntriesList: vi.fn(),
	compassEntriesRead: vi.fn(),
	compassEntriesUpdate: vi.fn(),
	compassImagesRead: vi.fn(),
	compassRevisionsList: vi.fn(),
	compassRevisionsRead: vi.fn(),
	compassRevisionsRestore: vi.fn(),
	compassSpacesCreate: vi.fn(),
	compassSpacesList: vi.fn(),
	compassSpacesRead: vi.fn(),
	compassSpacesUpdate: vi.fn(),
	compassTopicsList: vi.fn(),
}))

const session = vi.hoisted(() => ({epoch: 1}))

vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/helpers/auth', () => ({
	getAuthSessionEpoch: () => session.epoch,
	getToken: () => null,
	getTokenIdentity: () => ({id: 1, type: 1}),
}))

import {
	canAdminCompass,
	canWriteCompass,
	COMPASS_DEFAULT_BACKGROUND,
	compassEntriesQuery,
	compassEntryQuery,
	compassEntryText,
	compassKeys,
	compassRevisionQuery,
	compassRevisionsQuery,
	compassSpacesQuery,
	compassTopicsQuery,
	createCompassEntryMutationOptions,
	createCompassSpaceMutationOptions,
	deleteCompassEntryMutationOptions,
	fetchCompassEntriesForExport,
	fetchCompassImage,
	normalizeCompassEntry,
	normalizeCompassEntrySummary,
	normalizeCompassRevision,
	normalizeCompassRevisionSummary,
	normalizeCompassSpace,
	normalizeCompassTags,
	normalizeCompassTopics,
	restoreCompassRevisionMutationOptions,
	setCompassEntryMetaMutationOptions,
	toCompassEntrySummary,
	updateCompassEntryMutationOptions,
	updateCompassSpaceMutationOptions,
	type CompassEntry,
	type CompassEntryMetaChange,
	type CompassEntrySummary,
	type CompassEntryWritable,
	type CompassSpace,
	type RawCompassEntry,
	type RawCompassSpace,
} from './compass'
import type {Paginated} from './pagination'

function execute<TData, TVariables, TContext>(
	client: QueryClient,
	options: MutationOptions<TData, Error, TVariables, TContext>,
	variables: TVariables,
) {
	return client.getMutationCache().build(client, options).execute(variables)
}

function page<T>(items: T[], total = items.length, perPage = 50): Paginated<T> {
	return {
		items,
		page: 1,
		per_page: perPage,
		total,
		total_pages: Math.max(1, Math.ceil(total / perPage)),
	}
}

const rawEntry: RawCompassEntry = {
	id: 5,
	space_id: 3,
	kind: 'principle',
	title: 'Stay curious',
	subtitle: 'Why it matters',
	content: '<p>Body</p>',
	quote: 'Freedom to create',
	category: 'Life',
	tags: ['freedom', 'craft'],
	theme: 'solar',
	pinned: false,
	state: 'active',
	revision: 4,
	created: '2026-10-01T08:00:00Z',
	updated: '2026-10-30T09:30:00Z',
	created_by_id: 1,
	updated_by_id: 2,
	excerpt: 'Body',
	content_bytes: 11,
	max_permission: 2,
}

const cachedEntry: CompassEntry = normalizeCompassEntry(rawEntry)

// A write answer as the API sends it, minus the caller's permission, which the cache must keep.
function writeAnswer(overrides: RawCompassEntry): RawCompassEntry {
	const {max_permission: _permission, ...answer} = {...rawEntry, ...overrides}
	return answer
}

const rawSpace: RawCompassSpace = {
	id: 3,
	owner_id: 1,
	team_id: 0,
	title: 'North',
	motto: 'Keep going',
	introduction: '<p>Why</p>',
	theme: 'nebula',
	revision: 2,
	created: '2026-09-01T08:00:00Z',
	updated: '2026-10-01T08:00:00Z',
	max_permission: 2,
	entry_count: 7,
	pinned_count: 2,
}

const cachedSpace: CompassSpace = normalizeCompassSpace(rawSpace)

beforeEach(() => {
	Object.values(sdk).forEach(mock => mock.mockReset())
	vi.mocked(success).mockReset()
	vi.mocked(error).mockReset()
	session.epoch = 1
})

describe('normalizers', () => {
	it('reads Go zero times as never and unknown enums as safe defaults', () => {
		expect(normalizeCompassEntry({
			...rawEntry,
			kind: 'manifesto',
			theme: 'sunset',
			state: 'deleted',
			created: '0001-01-01T00:00:00Z',
			content: undefined,
			max_permission: null,
		})).toEqual({
			...cachedEntry,
			kind: 'note',
			theme: 'inherit',
			state: 'active',
			created: undefined,
			content: '',
			max_permission: 0,
		})
	})

	it('reads a missing entry as an empty, read-only one', () => {
		const entry = normalizeCompassEntry(undefined)

		expect(entry).toMatchObject({
			id: 0,
			kind: 'note',
			title: '',
			content: '',
			tags: [],
			theme: 'inherit',
			pinned: false,
			state: 'active',
			max_permission: 0,
		})
		expect(canWriteCompass(entry)).toBe(false)
	})

	it('repairs a space with an unknown theme and missing counters', () => {
		expect(normalizeCompassSpace({
			...rawSpace,
			theme: 'sunset',
			updated: '0001-01-01T00:00:00Z',
			max_permission: null,
			entry_count: null,
			pinned_count: undefined,
		})).toEqual({
			...cachedSpace,
			theme: 'aurora',
			updated: undefined,
			max_permission: 0,
			entry_count: 0,
			pinned_count: 0,
		})
	})

	it('reads the background with safe defaults: the theme sky, a centred focus and a medium veil', () => {
		expect(cachedSpace).toMatchObject({
			background_file_id: 0,
			background_focus_x: 50,
			background_focus_y: 50,
			background_scrim: 'medium',
		})
		expect(normalizeCompassSpace({
			...rawSpace,
			background_file_id: 12,
			background_focus_x: 140,
			background_focus_y: -3.6,
			background_scrim: 'strong',
		})).toMatchObject({
			background_file_id: 12,
			background_focus_x: 100,
			background_focus_y: 0,
			background_scrim: 'strong',
		})
		expect(normalizeCompassSpace({...rawSpace, background_file_id: -4, background_scrim: 'opaque'})).toMatchObject({
			background_file_id: 0,
			background_scrim: 'medium',
		})
	})

	it('counts the images of an entry, zero when the server leaves it out', () => {
		expect(cachedEntry.image_count).toBe(0)
		expect(normalizeCompassEntry({...rawEntry, image_count: 3}).image_count).toBe(3)
		expect(toCompassEntrySummary(normalizeCompassEntry({...rawEntry, image_count: 3}))).toMatchObject({image_count: 3})
	})

	it('dedupes tags exactly like the server: trimmed, case kept', () => {
		expect(normalizeCompassTags([' Life ', 'Life', 'life', '', '  ', '自由', '自由']))
			.toEqual(['Life', 'life', '自由'])
		expect(normalizeCompassTags(null)).toEqual([])
		expect(normalizeCompassEntrySummary({...rawEntry, tags: ['craft', ' craft', 'Craft']}).tags)
			.toEqual(['craft', 'Craft'])
	})

	it('repairs revision list items', () => {
		expect(normalizeCompassRevisionSummary({
			id: 31,
			entry_id: 5,
			revision: 3,
			kind: 'unknown',
			title: 'Then',
			state: 'gone',
			updated_by_id: 2,
			created: '0001-01-01T00:00:00Z',
			content_bytes: 20,
		})).toEqual({
			id: 31,
			entry_id: 5,
			revision: 3,
			kind: 'note',
			title: 'Then',
			state: 'active',
			updated_by_id: 2,
			created: undefined,
			content_bytes: 20,
		})
	})

	it('dates a saved version by when it was saved and ties it to the requested entry', () => {
		const revision = normalizeCompassRevision({...rawEntry, id: 99, revision: 3}, 5)

		expect(revision.entry_id).toBe(5)
		expect(revision.revision).toBe(3)
		expect(revision.created).toBe('2026-10-30T09:30:00Z')
		expect(normalizeCompassRevision({...rawEntry, updated: '0001-01-01T00:00:00Z'}, 5).created)
			.toBe('2026-10-01T08:00:00Z')
	})

	it('maps topic items to categories and drops nameless ones', () => {
		expect(normalizeCompassTopics({
			items: [{name: 'Life', count: 3}, {name: '', count: 1}, {name: null, count: 2}],
			tags: null,
		})).toEqual({
			categories: [{name: 'Life', count: 3}],
			tags: [],
		})
	})

	it('grants writing from permission 1 and administration from 2 only', () => {
		expect([0, 1, 2].map(max_permission => canWriteCompass({max_permission}))).toEqual([false, true, true])
		expect([0, 1, 2].map(max_permission => canAdminCompass({max_permission}))).toEqual([false, false, true])
		expect(canWriteCompass(undefined)).toBe(false)
		expect(canAdminCompass(undefined)).toBe(false)
	})

	it('takes only the writer\'s text from an entry, with its own tag list', () => {
		const text = compassEntryText(cachedEntry)

		expect(text).toStrictEqual({
			kind: 'principle',
			title: 'Stay curious',
			subtitle: 'Why it matters',
			content: '<p>Body</p>',
			quote: 'Freedom to create',
			category: 'Life',
			tags: ['freedom', 'craft'],
			theme: 'solar',
		})
		text.tags.push('changed')
		expect(cachedEntry.tags).toEqual(['freedom', 'craft'])
	})
})

describe('reads', () => {
	it('collects every page of spaces for the switcher', async () => {
		const client = new QueryClient()
		sdk.compassSpacesList
			.mockResolvedValueOnce({data: {items: [{...rawSpace, id: 1}], page: 1, total_pages: 2}})
			.mockResolvedValueOnce({data: {
				items: [{...rawSpace, id: 2, team_id: 4, theme: 'unknown'}],
				page: 2,
				total_pages: 2,
			}})

		const spaces = await client.fetchQuery(compassSpacesQuery())

		expect(spaces.map(space => [space.id, space.team_id, space.theme])).toEqual([[1, 0, 'nebula'], [2, 4, 'aurora']])
		expect(sdk.compassSpacesList).toHaveBeenNthCalledWith(1, {query: {page: 1}, signal: expect.any(AbortSignal)})
		expect(sdk.compassSpacesList).toHaveBeenNthCalledWith(2, {query: {page: 2}, signal: expect.any(AbortSignal)})
	})

	it('sends every library filter, with pinned as the string the API expects', async () => {
		const client = new QueryClient()
		sdk.compassEntriesList.mockResolvedValue({data: {
			items: [{...rawEntry, content: undefined, kind: 'unknown'}],
			page: 2,
			per_page: 1,
			total: 3,
			total_pages: 3,
		}})

		const result = await client.fetchQuery(compassEntriesQuery(3, {
			q: 'sea',
			kind: 'memory',
			category: 'Life',
			tag: 'craft',
			state: 'archived',
			pinned: true,
			sort: 'title',
		}, 2))

		expect(sdk.compassEntriesList).toHaveBeenCalledWith({
			path: {space: 3},
			query: {
				q: 'sea',
				kind: 'memory',
				category: 'Life',
				tag: 'craft',
				state: 'archived',
				sort: 'title',
				pinned: 'true',
				page: 2,
			},
			signal: expect.any(AbortSignal),
		})
		expect(result).toEqual({
			items: [{...toCompassEntrySummary(cachedEntry), kind: 'note'}],
			page: 2,
			per_page: 1,
			total: 3,
			total_pages: 3,
		})
	})

	it('sends pinned=false as a filter and leaves pinned out when unset', async () => {
		const client = new QueryClient()
		sdk.compassEntriesList.mockResolvedValue({data: {items: [], total: 0, total_pages: 0}})

		await client.fetchQuery(compassEntriesQuery(3, {pinned: false}, 1))
		await client.fetchQuery(compassEntriesQuery(3, {}, 1))

		expect(sdk.compassEntriesList.mock.calls[0][0].query).toEqual({pinned: 'false', page: 1})
		expect(sdk.compassEntriesList.mock.calls[1][0].query).toEqual({page: 1})
		expect(sdk.compassEntriesList.mock.calls[1][0].query.pinned).toBeUndefined()
	})

	it('keeps the previous rows while paging in one space, never across spaces', () => {
		const previous = page([toCompassEntrySummary(cachedEntry)])
		const placeholderData = compassEntriesQuery(3, {}, 2).placeholderData as (
			previousData: Paginated<CompassEntrySummary> | undefined,
			previousQuery: {queryKey: QueryKey} | undefined,
		) => Paginated<CompassEntrySummary> | undefined

		expect(placeholderData(previous, {queryKey: compassKeys.entryList(3, {kind: 'memory'}, 1)})).toBe(previous)
		expect(placeholderData(previous, {queryKey: compassKeys.entryList(4, {}, 2)})).toBeUndefined()
	})

	it('keeps the previous revisions page for the same entry only', () => {
		const previous = page([normalizeCompassRevisionSummary({id: 31, entry_id: 5, revision: 3})])
		const placeholderData = compassRevisionsQuery(5, 2).placeholderData as (
			previousData: typeof previous | undefined,
			previousQuery: {queryKey: QueryKey} | undefined,
		) => typeof previous | undefined

		expect(placeholderData(previous, {queryKey: compassKeys.revisionList(5, 1)})).toBe(previous)
		expect(placeholderData(previous, {queryKey: compassKeys.revisionList(6, 2)})).toBeUndefined()
	})

	it('reads an entry whose body the API left out as empty', async () => {
		const client = new QueryClient()
		sdk.compassEntriesRead.mockResolvedValue({data: {...rawEntry, content: undefined}})

		expect(await client.fetchQuery(compassEntryQuery(5))).toEqual({...cachedEntry, content: ''})
		expect(sdk.compassEntriesRead).toHaveBeenCalledWith({path: {entry: 5}, signal: expect.any(AbortSignal)})
	})

	it('reads revision lists and single versions of the requested entry', async () => {
		const client = new QueryClient()
		sdk.compassRevisionsList.mockResolvedValue({data: {
			items: [{id: 31, entry_id: 5, revision: 3, kind: 'vision', title: 'Then', state: 'archived'}],
			page: 1,
			per_page: 50,
			total: 1,
			total_pages: 1,
		}})
		sdk.compassRevisionsRead.mockResolvedValue({data: {...rawEntry, revision: 3, title: 'Then'}})

		const list = await client.fetchQuery(compassRevisionsQuery(5, 1))
		const version = await client.fetchQuery(compassRevisionQuery(5, 3))

		expect(sdk.compassRevisionsList).toHaveBeenCalledWith({
			path: {entry: 5},
			query: {page: 1},
			signal: expect.any(AbortSignal),
		})
		expect(list.items.map(item => [item.revision, item.kind, item.state])).toEqual([[3, 'vision', 'archived']])
		expect(sdk.compassRevisionsRead).toHaveBeenCalledWith({
			path: {
				entry: 5,
				revision: 3,
			},
			signal: expect.any(AbortSignal),
		})
		expect(version).toMatchObject({
			entry_id: 5,
			revision: 3,
			title: 'Then',
			content: '<p>Body</p>',
		})
	})

	it('reads the topics of one space', async () => {
		const client = new QueryClient()
		sdk.compassTopicsList.mockResolvedValue({data: {
			items: [{name: 'Life', count: 3}],
			tags: [{name: 'craft', count: 2}],
		}})

		expect(await client.fetchQuery(compassTopicsQuery(3))).toEqual({
			categories: [{name: 'Life', count: 3}],
			tags: [{name: 'craft', count: 2}],
		})
		expect(sdk.compassTopicsList).toHaveBeenCalledWith({path: {space: 3}, signal: expect.any(AbortSignal)})
	})
})

describe('fetchCompassImage', () => {
	function image(type = 'image/webp') {
		return new Blob([new Uint8Array([1, 2, 3])], {type})
	}

	it('reads through the space as a blob and refuses types that are not safe raster images', async () => {
		sdk.compassImagesRead.mockResolvedValueOnce({data: image()})
		await expect(fetchCompassImage(3, 12)).resolves.toBeInstanceOf(Blob)
		expect(sdk.compassImagesRead).toHaveBeenCalledWith(expect.objectContaining({
			path: {space: 3, file: 12},
			parseAs: 'blob',
		}))

		sdk.compassImagesRead.mockResolvedValueOnce({data: image('image/svg+xml')})
		await expect(fetchCompassImage(3, 13)).rejects.toThrow('unsupported type')
	})

	it('reads four images at a time and lets a cancelled read leave the queue', async () => {
		const pending: (() => void)[] = []
		sdk.compassImagesRead.mockImplementation(() => new Promise(resolve => {
			pending.push(() => resolve({data: image()}))
		}))
		const running = [1, 2, 3, 4].map(id => fetchCompassImage(3, id))
		const cancelled = new AbortController()
		const queued = fetchCompassImage(3, 5, cancelled.signal)
		const next = fetchCompassImage(3, 6)
		await vi.waitFor(() => expect(sdk.compassImagesRead).toHaveBeenCalledTimes(4))

		cancelled.abort()
		await expect(queued).rejects.toSatisfy(isRequestContextAbort)
		pending.shift()!()
		await running[0]
		await vi.waitFor(() => expect(sdk.compassImagesRead).toHaveBeenCalledTimes(5))
		expect(sdk.compassImagesRead.mock.lastCall?.[0].path).toEqual({space: 3, file: 6})

		pending.splice(0).forEach(resolve => resolve())
		await Promise.all([...running, next])
	})

	it('never starts or returns a queued read under another session', async () => {
		const pending: (() => void)[] = []
		sdk.compassImagesRead.mockImplementation(() => new Promise(resolve => {
			pending.push(() => resolve({data: image()}))
		}))
		const running = [1, 2, 3, 4].map(id => fetchCompassImage(3, id))
		const queued = fetchCompassImage(3, 5)
		await vi.waitFor(() => expect(sdk.compassImagesRead).toHaveBeenCalledTimes(4))
		session.epoch = 2

		pending.splice(0).forEach(resolve => resolve())
		await Promise.all(running.map(read => expect(read).rejects.toSatisfy(isRequestContextAbort)))
		await expect(queued).rejects.toSatisfy(isRequestContextAbort)
		expect(sdk.compassImagesRead).toHaveBeenCalledTimes(4)
	})
})

describe('fetchCompassEntriesForExport', () => {
	it('lists active and archived entries on every page, then reads each body and reports progress', async () => {
		const controller = new AbortController()
		sdk.compassEntriesList
			.mockResolvedValueOnce({data: {items: [{id: 5}, {id: 6}], total_pages: 2}})
			.mockResolvedValueOnce({data: {items: [{id: 7}], total_pages: 2}})
		sdk.compassEntriesRead.mockImplementation(async ({path}: {path: {entry: number}}) => ({
			data: {...rawEntry, id: path.entry},
		}))
		const progress: [number, number][] = []

		const entries = await fetchCompassEntriesForExport(3, (done, total) => {
			progress.push([done, total])
		}, controller.signal)

		expect(entries.map(entry => entry.id)).toEqual([5, 6, 7])
		expect(entries[2].content).toBe('<p>Body</p>')
		expect(progress).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]])
		expect(sdk.compassEntriesList).toHaveBeenNthCalledWith(2, {
			path: {space: 3},
			query: {
				state: 'all',
				page: 2,
			},
			signal: controller.signal,
		})
		expect(sdk.compassEntriesRead).toHaveBeenCalledWith({path: {entry: 7}, signal: controller.signal})
	})

	it('stops reading bodies once cancelled', async () => {
		const controller = new AbortController()
		sdk.compassEntriesList.mockResolvedValue({data: {items: [{id: 5}, {id: 6}, {id: 7}], total_pages: 1}})
		sdk.compassEntriesRead.mockResolvedValue({data: rawEntry})

		const failure = await fetchCompassEntriesForExport(3, done => {
			if (done === 1) controller.abort()
		}, controller.signal).catch((cause: unknown) => cause)

		expect(isRequestContextAbort(failure)).toBe(true)
		expect(sdk.compassEntriesRead).toHaveBeenCalledTimes(1)
	})
})

describe('space mutations', () => {
	it('creates a space, seeds it and appends it to the loaded switcher', async () => {
		const client = new QueryClient()
		const existing = normalizeCompassSpace({...rawSpace, id: 2, title: 'Older'})
		client.setQueryData(compassKeys.spaces, [existing])
		const created = {...rawSpace, id: 4, title: '星图', motto: '', introduction: '', theme: 'aurora', revision: 1}
		sdk.compassSpacesCreate.mockResolvedValue({data: created})

		await execute(client, createCompassSpaceMutationOptions(), {
			title: '星图',
			motto: '',
			introduction: '',
			theme: 'aurora',
			team_id: 0,
		})

		expect(sdk.compassSpacesCreate).toHaveBeenCalledWith({body: {
			title: '星图',
			motto: '',
			introduction: '',
			theme: 'aurora',
			team_id: 0,
			background_file_id: 0,
			background_focus_x: 50,
			background_focus_y: 50,
			background_scrim: 'medium',
		}})
		expect(client.getQueryData(compassKeys.space(4))).toEqual(normalizeCompassSpace(created))
		expect(client.getQueryData(compassKeys.spaces)).toEqual([existing, normalizeCompassSpace(created)])
		expect(client.getQueryState(compassKeys.spaces)?.isInvalidated).toBe(true)
		expect(success).toHaveBeenCalledWith({message: i18n.global.t('compass.space.created')})
	})

	it('does not build a partial switcher list nobody loaded', async () => {
		const client = new QueryClient()
		sdk.compassSpacesCreate.mockResolvedValue({data: {...rawSpace, id: 4}})

		await execute(client, createCompassSpaceMutationOptions(), {
			title: 'North',
			motto: '',
			introduction: '',
			theme: 'nebula',
			team_id: 0,
		})

		expect(client.getQueryCache().find({queryKey: compassKeys.spaces, exact: true})).toBeUndefined()
		expect(client.getQueryData(compassKeys.space(4))).toEqual(normalizeCompassSpace({...rawSpace, id: 4}))
	})

	it('saves settings against the base revision and keeps counters and permission the answer lacks', async () => {
		const client = new QueryClient()
		const other = normalizeCompassSpace({...rawSpace, id: 8, title: 'Other'})
		client.setQueryData(compassKeys.space(3), cachedSpace)
		client.setQueryData(compassKeys.spaces, [cachedSpace, other])
		// The answer leaves out the emptied motto, the permission and the counters.
		sdk.compassSpacesUpdate.mockResolvedValue({data: {
			id: 3,
			owner_id: 1,
			team_id: 0,
			title: 'South',
			introduction: '<p>New</p>',
			theme: 'ink',
			background_file_id: 9,
			background_focus_x: 30,
			background_focus_y: 70,
			background_scrim: 'strong',
			revision: 3,
			created: '2026-09-01T08:00:00Z',
			updated: '2026-10-31T08:00:00Z',
		}})

		await execute(client, updateCompassSpaceMutationOptions(), {
			spaceId: 3,
			title: 'South',
			motto: '',
			introduction: '<p>New</p>',
			theme: 'ink',
			background_file_id: 9,
			background_focus_x: 30,
			background_focus_y: 70,
			background_scrim: 'strong',
			revision: 2,
		})

		expect(sdk.compassSpacesUpdate).toHaveBeenCalledWith({
			path: {space: 3},
			body: {
				title: 'South',
				motto: '',
				introduction: '<p>New</p>',
				theme: 'ink',
				background_file_id: 9,
				background_focus_x: 30,
				background_focus_y: 70,
				background_scrim: 'strong',
				revision: 2,
			},
		})
		const saved: CompassSpace = {
			...cachedSpace,
			title: 'South',
			motto: '',
			introduction: '<p>New</p>',
			theme: 'ink',
			background_file_id: 9,
			background_focus_x: 30,
			background_focus_y: 70,
			background_scrim: 'strong',
			revision: 3,
			updated: '2026-10-31T08:00:00Z',
		}
		expect(client.getQueryData(compassKeys.space(3))).toEqual(saved)
		expect(client.getQueryData(compassKeys.spaces)).toEqual([saved, other])
		expect(client.getQueryState(compassKeys.space(3))?.isInvalidated).toBe(true)
		expect(success).toHaveBeenCalledWith({message: i18n.global.t('compass.space.saved')})
	})

	it('leaves a settings conflict to the form: no toast, cache kept', async () => {
		const client = new QueryClient()
		client.setQueryData(compassKeys.space(3), cachedSpace)
		const conflict = new ApiError({status: 409, code: 20101, detail: 'The space changed.'})
		sdk.compassSpacesUpdate.mockRejectedValue(conflict)

		await expect(execute(client, updateCompassSpaceMutationOptions(), {
			spaceId: 3,
			title: 'Mine',
			motto: '',
			introduction: '',
			theme: 'ink',
			...COMPASS_DEFAULT_BACKGROUND,
			revision: 1,
		})).rejects.toBe(conflict)

		expect(error).not.toHaveBeenCalled()
		expect(success).not.toHaveBeenCalled()
		expect(client.getQueryData(compassKeys.space(3))).toEqual(cachedSpace)
	})
})

describe('createCompassEntryMutationOptions', () => {
	it('sends only the text, the pin and an active state, and refreshes only its own space', async () => {
		const client = new QueryClient()
		for (const spaceId of [3, 4]) {
			client.setQueryData(compassKeys.space(spaceId), {...cachedSpace, id: spaceId})
			client.setQueryData(compassKeys.topics(spaceId), {categories: [], tags: []})
			client.setQueryData(compassKeys.entryList(spaceId, {}, 1), page([]))
		}
		client.setQueryData(compassKeys.spaces, [cachedSpace])
		const created = {...rawEntry, id: 9, revision: 1}
		sdk.compassEntriesCreate.mockResolvedValue({data: created})
		// What an editor might hold; only the writable text may reach the API.
		const editorState = {
			...cachedEntry,
			id: 77,
			state: 'archived' as const,
			pinned: true,
		}

		await execute(client, createCompassEntryMutationOptions(), {spaceId: 3, entry: editorState})

		expect(sdk.compassEntriesCreate).toHaveBeenCalledWith({
			path: {space: 3},
			body: {
				kind: 'principle',
				title: 'Stay curious',
				subtitle: 'Why it matters',
				content: '<p>Body</p>',
				quote: 'Freedom to create',
				category: 'Life',
				tags: ['freedom', 'craft'],
				theme: 'solar',
				pinned: true,
				state: 'active',
			},
		})
		expect(client.getQueryData(compassKeys.entry(9))).toEqual(normalizeCompassEntry(created))
		const invalidated = (key: QueryKey) => client.getQueryState(key)?.isInvalidated
		expect(invalidated(compassKeys.entryList(3, {}, 1))).toBe(true)
		expect(invalidated(compassKeys.topics(3))).toBe(true)
		expect(invalidated(compassKeys.space(3))).toBe(true)
		expect(invalidated(compassKeys.spaces)).toBe(true)
		expect(invalidated(compassKeys.entryList(4, {}, 1))).toBe(false)
		expect(invalidated(compassKeys.topics(4))).toBe(false)
		expect(invalidated(compassKeys.space(4))).toBe(false)
	})

	it('leaves a failed create to the editor', async () => {
		const client = new QueryClient()
		const offline = new TypeError('Failed to fetch')
		sdk.compassEntriesCreate.mockRejectedValue(offline)

		await expect(execute(client, createCompassEntryMutationOptions(), {
			spaceId: 3,
			entry: {...compassEntryText(cachedEntry), pinned: false},
		})).rejects.toBe(offline)

		expect(error).not.toHaveBeenCalled()
	})
})

describe('updateCompassEntryMutationOptions', () => {
	const writable: CompassEntryWritable = {
		...compassEntryText(cachedEntry),
		title: 'Stay curious, always',
		content: '',
		pinned: false,
		state: 'active',
	}

	it('saves against the base revision and writes the answer into the detail and every list row', async () => {
		const client = new QueryClient()
		const neighbour = normalizeCompassEntrySummary({...rawEntry, id: 6, title: 'Neighbour'})
		const elsewhere = normalizeCompassEntrySummary({...rawEntry, id: 40, space_id: 4})
		client.setQueryData(compassKeys.entry(5), cachedEntry)
		client.setQueryData(compassKeys.entryList(3, {}, 1), page([toCompassEntrySummary(cachedEntry), neighbour]))
		client.setQueryData(compassKeys.entryList(3, {kind: 'principle'}, 1), page([toCompassEntrySummary(cachedEntry)]))
		client.setQueryData(compassKeys.entryList(4, {}, 1), page([elsewhere]))
		client.setQueryData(compassKeys.revisionList(5, 1), page([]))
		client.setQueryData(compassKeys.revisionList(6, 1), page([]))
		const untouched = client.getQueryState(compassKeys.entryList(4, {}, 1))?.dataUpdateCount
		// The body was emptied, so the API leaves it out of the answer.
		sdk.compassEntriesUpdate.mockResolvedValue({data: writeAnswer({
			title: 'Stay curious, always',
			content: undefined,
			revision: 5,
			updated: '2026-10-31T10:00:00Z',
			updated_by_id: 1,
			excerpt: '',
			content_bytes: 0,
		})})

		await execute(client, updateCompassEntryMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			entry: writable,
			revision: 4,
		})

		expect(sdk.compassEntriesUpdate).toHaveBeenCalledWith({
			path: {entry: 5},
			body: {
				kind: 'principle',
				title: 'Stay curious, always',
				subtitle: 'Why it matters',
				content: '',
				quote: 'Freedom to create',
				category: 'Life',
				tags: ['freedom', 'craft'],
				theme: 'solar',
				pinned: false,
				state: 'active',
				revision: 4,
			},
		})
		const saved: CompassEntry = {
			...cachedEntry,
			title: 'Stay curious, always',
			content: '',
			revision: 5,
			updated: '2026-10-31T10:00:00Z',
			updated_by_id: 1,
			excerpt: '',
			content_bytes: 0,
		}
		expect(client.getQueryData(compassKeys.entry(5))).toEqual(saved)
		expect(client.getQueryData(compassKeys.entryList(3, {}, 1))).toEqual(page([toCompassEntrySummary(saved), neighbour]))
		expect(client.getQueryData(compassKeys.entryList(3, {kind: 'principle'}, 1)))
			.toEqual(page([toCompassEntrySummary(saved)]))
		expect(client.getQueryState(compassKeys.entryList(4, {}, 1))?.dataUpdateCount).toBe(untouched)
		expect(client.getQueryState(compassKeys.revisionList(5, 1))?.isInvalidated).toBe(true)
		expect(client.getQueryState(compassKeys.revisionList(6, 1))?.isInvalidated).toBe(false)
	})

	it('does not materialize a detail or list nobody reads', async () => {
		const client = new QueryClient()
		sdk.compassEntriesUpdate.mockResolvedValue({data: writeAnswer({revision: 5})})

		await execute(client, updateCompassEntryMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			entry: writable,
			revision: 4,
		})

		expect(client.getQueryCache().find({queryKey: compassKeys.entry(5), exact: true})).toBeUndefined()
		expect(client.getQueryCache().findAll({queryKey: compassKeys.entryLists(3)})).toEqual([])
	})

	it('leaves a conflict to the editor: no toast, cache kept', async () => {
		const client = new QueryClient()
		client.setQueryData(compassKeys.entry(5), cachedEntry)
		const conflict = new ApiError({status: 409, code: 20101, detail: 'The entry changed.'})
		sdk.compassEntriesUpdate.mockRejectedValue(conflict)

		await expect(execute(client, updateCompassEntryMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			entry: writable,
			revision: 3,
		})).rejects.toBe(conflict)

		expect(error).not.toHaveBeenCalled()
		expect(client.getQueryData(compassKeys.entry(5))).toEqual(cachedEntry)
	})
})

describe('setCompassEntryMetaMutationOptions', () => {
	it('trashes the latest version, not the cached one, and unpins it', async () => {
		const client = new QueryClient()
		const stale = {...cachedEntry, pinned: true}
		client.setQueryData(compassKeys.entry(5), stale)
		client.setQueryData(compassKeys.entryList(3, {}, 1), page([toCompassEntrySummary(stale)]))
		const latest = {
			...rawEntry,
			title: 'Edited elsewhere',
			content: '<p>Newer</p>',
			tags: ['craft'],
			pinned: true,
			revision: 6,
		}
		sdk.compassEntriesRead.mockResolvedValue({data: latest})
		sdk.compassEntriesUpdate.mockResolvedValue({data: writeAnswer({
			...latest,
			pinned: false,
			state: 'trashed',
			revision: 7,
		})})

		await execute(client, setCompassEntryMetaMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			change: {state: 'trashed'},
		})

		expect(sdk.compassEntriesRead).toHaveBeenCalledWith({path: {entry: 5}})
		expect(sdk.compassEntriesUpdate).toHaveBeenCalledWith({
			path: {entry: 5},
			body: {
				kind: 'principle',
				title: 'Edited elsewhere',
				subtitle: 'Why it matters',
				content: '<p>Newer</p>',
				quote: 'Freedom to create',
				category: 'Life',
				tags: ['craft'],
				theme: 'solar',
				pinned: false,
				state: 'trashed',
				revision: 6,
			},
		})
		const saved: CompassEntry = {
			...normalizeCompassEntry(latest),
			pinned: false,
			state: 'trashed',
			revision: 7,
			max_permission: 2,
		}
		expect(client.getQueryData(compassKeys.entry(5))).toEqual(saved)
		expect(client.getQueryData(compassKeys.entryList(3, {}, 1))).toEqual(page([toCompassEntrySummary(saved)]))
		expect(client.getQueryState(compassKeys.entry(5))?.isInvalidated).toBe(true)
		expect(client.getQueryState(compassKeys.entryList(3, {}, 1))?.isInvalidated).toBe(true)
		expect(success).toHaveBeenCalledWith({message: i18n.global.t('compass.entry.movedToTrash')})
	})

	const cases: {
		name: string
		latest: {state: CompassEntryState, pinned: boolean}
		change: CompassEntryMetaChange
		sent: {state: CompassEntryState, pinned: boolean}
		message: string
	}[] = [
		{
			name: 'pins an archived entry without restoring it',
			latest: {state: 'archived', pinned: false},
			change: {pinned: true},
			sent: {state: 'archived', pinned: true},
			message: 'compass.entry.pinned',
		},
		{
			name: 'unpins',
			latest: {state: 'active', pinned: true},
			change: {pinned: false},
			sent: {state: 'active', pinned: false},
			message: 'compass.entry.unpinned',
		},
		{
			name: 'archives and keeps the pin',
			latest: {state: 'active', pinned: true},
			change: {state: 'archived'},
			sent: {state: 'archived', pinned: true},
			message: 'compass.entry.archived',
		},
		{
			name: 'restores from the trash',
			latest: {state: 'trashed', pinned: false},
			change: {state: 'active'},
			sent: {state: 'active', pinned: false},
			message: 'compass.entry.restored',
		},
	]

	it.each(cases)('$name', async ({latest, change, sent, message}) => {
		const client = new QueryClient()
		sdk.compassEntriesRead.mockResolvedValue({data: {...rawEntry, ...latest, revision: 6}})
		sdk.compassEntriesUpdate.mockResolvedValue({data: writeAnswer({...sent, revision: 7})})

		await execute(client, setCompassEntryMetaMutationOptions(), {entryId: 5, spaceId: 3, change})

		expect(sdk.compassEntriesUpdate).toHaveBeenCalledWith({
			path: {entry: 5},
			body: {
				...compassEntryText(cachedEntry),
				...sent,
				revision: 6,
			},
		})
		expect(success).toHaveBeenCalledWith({message: i18n.global.t(message)})
	})

	it('reports a failed change, since the reader has no place to show it', async () => {
		const client = new QueryClient()
		const conflict = new ApiError({status: 409, code: 20101, detail: 'The entry changed.'})
		sdk.compassEntriesRead.mockResolvedValue({data: rawEntry})
		sdk.compassEntriesUpdate.mockRejectedValue(conflict)

		await expect(execute(client, setCompassEntryMetaMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			change: {pinned: true},
		})).rejects.toBe(conflict)

		expect(error).toHaveBeenCalledWith(conflict)
		expect(success).not.toHaveBeenCalled()
	})

	it('never writes under another account than the one that read the entry', async () => {
		const client = new QueryClient()
		sdk.compassEntriesRead.mockImplementation(async () => {
			session.epoch = 2
			return {data: rawEntry}
		})

		const failure = await execute(client, setCompassEntryMetaMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			change: {state: 'trashed'},
		}).catch((cause: unknown) => cause)

		expect(isRequestContextAbort(failure)).toBe(true)
		expect(sdk.compassEntriesUpdate).not.toHaveBeenCalled()
		expect(error).not.toHaveBeenCalled()
	})
})

describe('deleteCompassEntryMutationOptions', () => {
	it('deletes the trashed revision and removes the entry from every cached view', async () => {
		const client = new QueryClient()
		const trashed = {state: 'trashed'} as const
		const row = (id: number) => normalizeCompassEntrySummary({...rawEntry, id, state: 'trashed'})
		client.setQueryData(compassKeys.entryList(3, trashed, 1), page([row(5), row(8)], 3, 2))
		client.setQueryData(compassKeys.entryList(3, trashed, 2), {...page([row(9)], 3, 2), page: 2})
		client.setQueryData(compassKeys.entryList(3, {}, 1), page([toCompassEntrySummary({...cachedEntry, id: 6})], 1, 2))
		client.setQueryData(compassKeys.entry(5), {...cachedEntry, state: 'trashed'})
		client.setQueryData(compassKeys.entry(6), {...cachedEntry, id: 6})
		client.setQueryData(compassKeys.revisionList(5, 1), page([]))
		client.setQueryData(compassKeys.revision(5, 3), {})
		const activeUpdates = client.getQueryState(compassKeys.entryList(3, {}, 1))?.dataUpdateCount
		sdk.compassEntriesDelete.mockResolvedValue({data: undefined})

		await execute(client, deleteCompassEntryMutationOptions(), {entryId: 5, spaceId: 3, revision: 12})

		expect(sdk.compassEntriesDelete).toHaveBeenCalledWith({
			path: {entry: 5},
			query: {revision: 12},
		})
		expect(client.getQueryData(compassKeys.entryList(3, trashed, 1))).toEqual({
			items: [row(8)],
			page: 1,
			per_page: 2,
			total: 2,
			total_pages: 1,
		})
		expect(client.getQueryData<Paginated<CompassEntrySummary>>(compassKeys.entryList(3, trashed, 2)))
			.toMatchObject({total: 2, total_pages: 1})
		expect(client.getQueryState(compassKeys.entryList(3, {}, 1))?.dataUpdateCount).toBe(activeUpdates)
		expect(client.getQueryCache().find({queryKey: compassKeys.entry(5), exact: true})).toBeUndefined()
		expect(client.getQueryCache().findAll({queryKey: compassKeys.revisions(5)})).toEqual([])
		expect(client.getQueryData(compassKeys.entry(6))).toBeDefined()
		expect(success).toHaveBeenCalledWith({message: i18n.global.t('compass.entry.deleted')})
	})

	it('reports a refused delete and keeps the entry', async () => {
		const client = new QueryClient()
		client.setQueryData(compassKeys.entry(5), cachedEntry)
		const notTrashed = new ApiError({status: 400, code: 20103, detail: 'Move this entry to trash first.'})
		sdk.compassEntriesDelete.mockRejectedValue(notTrashed)

		await expect(execute(client, deleteCompassEntryMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			revision: 4,
		})).rejects.toBe(notTrashed)

		expect(error).toHaveBeenCalledWith(notTrashed)
		expect(client.getQueryData(compassKeys.entry(5))).toEqual(cachedEntry)
	})
})

describe('restoreCompassRevisionMutationOptions', () => {
	it('restores a version against the shown revision and writes the new current version', async () => {
		const client = new QueryClient()
		client.setQueryData(compassKeys.entry(5), cachedEntry)
		client.setQueryData(compassKeys.revisionList(5, 1), page([]))
		sdk.compassRevisionsRestore.mockResolvedValue({data: writeAnswer({title: 'Then', revision: 5})})

		await execute(client, restoreCompassRevisionMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			revision: 2,
			expectedRevision: 4,
		})

		expect(sdk.compassRevisionsRestore).toHaveBeenCalledWith({
			path: {
				entry: 5,
				revision: 2,
			},
			body: {expected_revision: 4},
		})
		expect(client.getQueryData(compassKeys.entry(5))).toEqual({
			...cachedEntry,
			title: 'Then',
			revision: 5,
		})
		expect(client.getQueryState(compassKeys.revisionList(5, 1))?.isInvalidated).toBe(true)
		expect(success).toHaveBeenCalledWith({message: i18n.global.t('compass.history.restored', {revision: 2})})
	})

	it('leaves a conflict to the history page', async () => {
		const client = new QueryClient()
		const conflict = new ApiError({status: 409, code: 20101, detail: 'The entry changed.'})
		sdk.compassRevisionsRestore.mockRejectedValue(conflict)

		await expect(execute(client, restoreCompassRevisionMutationOptions(), {
			entryId: 5,
			spaceId: 3,
			revision: 2,
			expectedRevision: 3,
		})).rejects.toBe(conflict)

		expect(error).not.toHaveBeenCalled()
		expect(success).not.toHaveBeenCalled()
	})
})
