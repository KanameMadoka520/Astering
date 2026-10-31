import {
	queryOptions,
	useMutation,
	type QueryClient,
} from '@tanstack/vue-query'
import {
	compassEntriesCreate,
	compassEntriesDelete,
	compassEntriesList,
	compassEntriesRead,
	compassEntriesUpdate,
	compassRevisionsList,
	compassRevisionsRead,
	compassRevisionsRestore,
	compassSpacesCreate,
	compassSpacesList,
	compassSpacesRead,
	compassSpacesUpdate,
	compassTopicsList,
} from '@/client/generated'
import {assertClientRequestContext} from '@/client/requestContext'
import {PERMISSIONS} from '@/constants/permissions'
import {
	COMPASS_DEFAULT_THEME,
	isCompassEntryState,
	isCompassEntryTheme,
	isCompassKind,
	isCompassTheme,
	type CompassEntryState,
	type CompassEntryTheme,
	type CompassKind,
	type CompassSort,
	type CompassStateFilter,
	type CompassTheme,
} from '@/helpers/compass/constants'
import {i18n} from '@/i18n'
import {contextMutationOptions} from './contextMutation'
import {fetchAllPages} from './fetchAllPages'
import {
	removeFromPages,
	toPaginated,
	type Paginated,
} from './pagination'

// These writes are explicit saves. An offline click must fail while retaining the draft,
// not silently queue a write that could run later after navigation or an account change.
function compassMutationOptions<TData, TInput, TOptimistic = undefined>(
	options: Parameters<typeof contextMutationOptions<TData, TInput, TOptimistic>>[0],
): ReturnType<typeof contextMutationOptions<TData, TInput, TOptimistic>> {
	return {...contextMutationOptions(options), networkMode: 'always' as const}
}

// What the API sends, typed structurally so the module does not depend on generated Go type names.
// Go's zero time stands for "never".
export type RawCompassSpace = {
	id?: number | null
	owner_id?: number | null
	team_id?: number | null
	title?: string | null
	motto?: string | null
	introduction?: string | null
	theme?: string | null
	revision?: number | null
	created?: string | null
	updated?: string | null
	max_permission?: number | null
	entry_count?: number | null
	pinned_count?: number | null
}

export type CompassSpace = {
	id: number
	owner_id: number
	// 0 for a personal space.
	team_id: number
	title: string
	motto: string
	introduction: string
	theme: CompassTheme
	revision: number
	created?: string
	updated?: string
	max_permission: number
	entry_count: number
	pinned_count: number
}

export type RawCompassEntry = {
	id?: number | null
	space_id?: number | null
	kind?: string | null
	title?: string | null
	subtitle?: string | null
	content?: string | null
	quote?: string | null
	category?: string | null
	tags?: string[] | null
	theme?: string | null
	pinned?: boolean | null
	state?: string | null
	revision?: number | null
	created?: string | null
	updated?: string | null
	created_by_id?: number | null
	updated_by_id?: number | null
	excerpt?: string | null
	content_bytes?: number | null
	max_permission?: number | null
}

/** A library row: everything but the body, which is only fetched when the entry is opened. */
export type CompassEntrySummary = {
	id: number
	space_id: number
	kind: CompassKind
	title: string
	subtitle: string
	quote: string
	category: string
	tags: string[]
	theme: CompassEntryTheme
	pinned: boolean
	state: CompassEntryState
	revision: number
	created?: string
	updated?: string
	created_by_id: number
	updated_by_id: number
	excerpt: string
	content_bytes: number
	max_permission: number
}

export type CompassEntry = CompassEntrySummary & {
	content: string
}

export type RawCompassRevision = {
	id?: number | null
	entry_id?: number | null
	revision?: number | null
	kind?: string | null
	title?: string | null
	state?: string | null
	updated_by_id?: number | null
	created?: string | null
	content_bytes?: number | null
}

export type CompassRevisionSummary = {
	id: number
	entry_id: number
	revision: number
	kind: CompassKind
	title: string
	state: CompassEntryState
	updated_by_id: number
	created?: string
	content_bytes: number
}

export type CompassRevision = CompassRevisionSummary & {
	subtitle: string
	content: string
	quote: string
	category: string
	tags: string[]
	theme: CompassEntryTheme
}

export type CompassTopic = {
	name: string
	count: number
}

export type CompassTopics = {
	categories: CompassTopic[]
	tags: CompassTopic[]
}

/** Library filters as sent to the server; defaults are left out so equal filters share one cache key. */
export type CompassEntryFilters = {
	q?: string
	kind?: CompassKind
	category?: string
	tag?: string
	state?: Exclude<CompassStateFilter, 'active'>
	pinned?: boolean
	sort?: Exclude<CompassSort, 'updated'>
}

/** The text a writer controls. Pin and state are metadata and travel separately. */
export type CompassEntryText = {
	kind: CompassKind
	title: string
	subtitle: string
	content: string
	quote: string
	category: string
	tags: string[]
	theme: CompassEntryTheme
}

export type CompassEntryWritable = CompassEntryText & {
	pinned: boolean
	state: CompassEntryState
}

export type CompassSpaceText = {
	title: string
	motto: string
	introduction: string
	theme: CompassTheme
}

export const compassKeys = {
	all: ['compass'] as const,
	spaces: ['compass', 'spaces'] as const,
	space: (spaceId: number) => ['compass', 'space', spaceId] as const,
	entryLists: (spaceId: number) => ['compass', 'entries', spaceId] as const,
	entryList: (spaceId: number, filters: CompassEntryFilters, page: number) =>
		['compass', 'entries', spaceId, filters, page] as const,
	entry: (entryId: number) => ['compass', 'entry', entryId] as const,
	revisions: (entryId: number) => ['compass', 'revisions', entryId] as const,
	revisionList: (entryId: number, page: number) => ['compass', 'revisions', entryId, 'list', page] as const,
	revision: (entryId: number, revision: number) => ['compass', 'revisions', entryId, 'detail', revision] as const,
	topics: (spaceId: number) => ['compass', 'topics', spaceId] as const,
}

const ZERO_TIME = /^0001-01-01/

function time(value: string | null | undefined): string | undefined {
	return value && !ZERO_TIME.test(value) ? value : undefined
}

// Unknown permission means read-only: a control the server then refuses is worse than none.
function permission(value: number | null | undefined): number {
	return value ?? PERMISSIONS.READ
}

// Tags are case-sensitive on the server: "Life" and "life" are two tags, and saving must keep both.
export function normalizeCompassTags(tags: readonly string[] | null | undefined): string[] {
	const seen = new Set<string>()
	const result: string[] = []
	for (const raw of tags ?? []) {
		const tag = raw.trim()
		if (tag === '' || seen.has(tag)) continue
		seen.add(tag)
		result.push(tag)
	}
	return result
}

export function normalizeCompassSpace(raw: RawCompassSpace | null | undefined): CompassSpace {
	return {
		id: raw?.id ?? 0,
		owner_id: raw?.owner_id ?? 0,
		team_id: raw?.team_id ?? 0,
		title: raw?.title ?? '',
		motto: raw?.motto ?? '',
		introduction: raw?.introduction ?? '',
		theme: isCompassTheme(raw?.theme) ? raw.theme : COMPASS_DEFAULT_THEME,
		revision: raw?.revision ?? 0,
		created: time(raw?.created),
		updated: time(raw?.updated),
		max_permission: permission(raw?.max_permission),
		entry_count: raw?.entry_count ?? 0,
		pinned_count: raw?.pinned_count ?? 0,
	}
}

export function normalizeCompassEntrySummary(raw: RawCompassEntry | null | undefined): CompassEntrySummary {
	return {
		id: raw?.id ?? 0,
		space_id: raw?.space_id ?? 0,
		kind: isCompassKind(raw?.kind) ? raw.kind : 'note',
		title: raw?.title ?? '',
		subtitle: raw?.subtitle ?? '',
		quote: raw?.quote ?? '',
		category: raw?.category ?? '',
		tags: normalizeCompassTags(raw?.tags),
		theme: isCompassEntryTheme(raw?.theme) ? raw.theme : 'inherit',
		pinned: raw?.pinned ?? false,
		state: isCompassEntryState(raw?.state) ? raw.state : 'active',
		revision: raw?.revision ?? 0,
		created: time(raw?.created),
		updated: time(raw?.updated),
		created_by_id: raw?.created_by_id ?? 0,
		updated_by_id: raw?.updated_by_id ?? 0,
		excerpt: raw?.excerpt ?? '',
		content_bytes: raw?.content_bytes ?? 0,
		max_permission: permission(raw?.max_permission),
	}
}

export function normalizeCompassEntry(raw: RawCompassEntry | null | undefined): CompassEntry {
	return {
		...normalizeCompassEntrySummary(raw),
		content: raw?.content ?? '',
	}
}

export function normalizeCompassRevisionSummary(raw: RawCompassRevision | null | undefined): CompassRevisionSummary {
	return {
		id: raw?.id ?? 0,
		entry_id: raw?.entry_id ?? 0,
		revision: raw?.revision ?? 0,
		kind: isCompassKind(raw?.kind) ? raw.kind : 'note',
		title: raw?.title ?? '',
		state: isCompassEntryState(raw?.state) ? raw.state : 'active',
		updated_by_id: raw?.updated_by_id ?? 0,
		created: time(raw?.created),
		content_bytes: raw?.content_bytes ?? 0,
	}
}

// A saved version comes back as a flat entry carrying that version's revision and fields.
export function normalizeCompassRevision(raw: RawCompassEntry | null | undefined, entryId: number): CompassRevision {
	const entry = normalizeCompassEntry(raw)
	return {
		id: entry.id,
		entry_id: entryId,
		revision: entry.revision,
		kind: entry.kind,
		title: entry.title,
		state: entry.state,
		updated_by_id: entry.updated_by_id,
		created: entry.updated ?? entry.created,
		content_bytes: entry.content_bytes,
		subtitle: entry.subtitle,
		content: entry.content,
		quote: entry.quote,
		category: entry.category,
		tags: entry.tags,
		theme: entry.theme,
	}
}

type RawTopic = {name?: string | null, count?: number | null}

function normalizeTopics(list: RawTopic[] | null | undefined): CompassTopic[] {
	return (list ?? [])
		.map(topic => ({name: topic.name ?? '', count: topic.count ?? 0}))
		.filter(topic => topic.name !== '')
}

export function normalizeCompassTopics(raw: {items?: RawTopic[] | null, tags?: RawTopic[] | null} | null | undefined): CompassTopics {
	return {
		categories: normalizeTopics(raw?.items),
		tags: normalizeTopics(raw?.tags),
	}
}

export function canWriteCompass(target: {max_permission: number} | undefined): boolean {
	return (target?.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.READ_WRITE
}

export function canAdminCompass(target: {max_permission: number} | undefined): boolean {
	return (target?.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.ADMIN
}

export function compassEntryText(entry: CompassEntryText): CompassEntryText {
	return {
		kind: entry.kind,
		title: entry.title,
		subtitle: entry.subtitle,
		content: entry.content,
		quote: entry.quote,
		category: entry.category,
		tags: [...entry.tags],
		theme: entry.theme,
	}
}

export function toCompassEntrySummary(entry: CompassEntry): CompassEntrySummary {
	const {content: _content, ...summary} = entry
	return summary
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every space the account can read. People keep a handful, so the switcher holds them all. */
export function compassSpacesQuery() {
	return queryOptions({
		queryKey: compassKeys.spaces,
		queryFn: async ({signal}) => (await fetchAllPages(async page =>
			(await compassSpacesList({query: {page}, signal})).data))
			.map(normalizeCompassSpace),
		meta: {handlesError: true},
	})
}

export function compassSpaceQuery(spaceId: number) {
	return queryOptions({
		queryKey: compassKeys.space(spaceId),
		queryFn: async ({signal}) => normalizeCompassSpace(
			(await compassSpacesRead({path: {space: spaceId}, signal})).data,
		),
		meta: {handlesError: true},
	})
}

export function compassEntriesQuery(spaceId: number, filters: CompassEntryFilters, page: number) {
	return queryOptions({
		queryKey: compassKeys.entryList(spaceId, filters, page),
		queryFn: async ({signal}): Promise<Paginated<CompassEntrySummary>> => {
			const {pinned, ...rest} = filters
			const {data} = await compassEntriesList({
				path: {space: spaceId},
				query: {
					...rest,
					// The API models the optional flag as a string enum.
					pinned: pinned === undefined ? undefined : pinned ? 'true' : 'false',
					page,
				},
				signal,
			})
			const result = toPaginated<RawCompassEntry>(data, page)
			return {
				...result,
				items: result.items.map(normalizeCompassEntrySummary),
			}
		},
		// Only within one space: another space's rows must never stand in while its own load.
		placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === spaceId ? previous : undefined,
		meta: {handlesError: true},
	})
}

export function compassEntryQuery(entryId: number) {
	return queryOptions({
		queryKey: compassKeys.entry(entryId),
		queryFn: async ({signal}) => normalizeCompassEntry(
			(await compassEntriesRead({path: {entry: entryId}, signal})).data,
		),
		meta: {handlesError: true},
	})
}

export function compassTopicsQuery(spaceId: number) {
	return queryOptions({
		queryKey: compassKeys.topics(spaceId),
		queryFn: async ({signal}) => normalizeCompassTopics(
			(await compassTopicsList({path: {space: spaceId}, signal})).data,
		),
		// The library works without the side rail; a failed read just hides it.
		meta: {handlesError: true},
	})
}

export function compassRevisionsQuery(entryId: number, page: number) {
	return queryOptions({
		queryKey: compassKeys.revisionList(entryId, page),
		queryFn: async ({signal}): Promise<Paginated<CompassRevisionSummary>> => {
			const {data} = await compassRevisionsList({
				path: {entry: entryId},
				query: {page},
				signal,
			})
			const result = toPaginated<RawCompassRevision>(data, page)
			return {
				...result,
				items: result.items.map(normalizeCompassRevisionSummary),
			}
		},
		placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === entryId ? previous : undefined,
		meta: {handlesError: true},
	})
}

export function compassRevisionQuery(entryId: number, revision: number) {
	return queryOptions({
		queryKey: compassKeys.revision(entryId, revision),
		queryFn: async ({signal}) => normalizeCompassRevision(
			(await compassRevisionsRead({
				path: {
					entry: entryId,
					revision,
				},
				signal,
			})).data,
			entryId,
		),
		// A saved version never changes.
		staleTime: Infinity,
		meta: {handlesError: true},
	})
}

/**
 * Reads every active and archived entry of a space with its body, one request per entry, for the
 * Markdown export. Bypasses the cache on purpose: a whole library of bodies must not stay in memory.
 */
export async function fetchCompassEntriesForExport(
	spaceId: number,
	onProgress: (done: number, total: number) => void,
	signal: AbortSignal,
): Promise<CompassEntry[]> {
	const summaries = (await fetchAllPages(async page => (await compassEntriesList({
		path: {space: spaceId},
		query: {
			state: 'all',
			page,
		},
		signal,
	})).data)).map(normalizeCompassEntrySummary)
	const entries: CompassEntry[] = []
	onProgress(0, summaries.length)
	for (const summary of summaries) {
		signal.throwIfAborted()
		entries.push(normalizeCompassEntry((await compassEntriesRead({path: {entry: summary.id}, signal})).data))
		onProgress(entries.length, summaries.length)
	}
	return entries
}

// ---------------------------------------------------------------------------
// Cache writes
// ---------------------------------------------------------------------------

// A write answer is the whole resource, but empty text fields are omitted from it: missing means
// empty, never "unchanged". Only the caller's permission and the counters fall back to the cached read.
function mergeSpace(client: QueryClient, saved: RawCompassSpace) {
	const next = normalizeCompassSpace(saved)
	if (next.id <= 0) return
	const merge = (current: CompassSpace): CompassSpace => ({
		...next,
		created: next.created ?? current.created,
		max_permission: saved.max_permission ?? current.max_permission,
		entry_count: saved.entry_count ?? current.entry_count,
		pinned_count: saved.pinned_count ?? current.pinned_count,
	})
	client.setQueryData<CompassSpace>(compassKeys.space(next.id), current => current ? merge(current) : current)
	client.setQueryData<CompassSpace[]>(compassKeys.spaces, current => current?.map(space => space.id === next.id
		? merge(space)
		: space))
}

function mergeEntry(client: QueryClient, saved: RawCompassEntry) {
	const next = normalizeCompassEntry(saved)
	if (next.id <= 0) return
	client.setQueryData<CompassEntry>(compassKeys.entry(next.id), current => current
		? {
			...next,
			max_permission: saved.max_permission ?? current.max_permission,
		}
		: current)
	if (next.space_id <= 0) return
	const summary = toCompassEntrySummary(next)
	client.setQueriesData<Paginated<CompassEntrySummary>>({queryKey: compassKeys.entryLists(next.space_id)}, current => current && ({
		...current,
		items: current.items.map(item => item.id === next.id
			? {
				...summary,
				max_permission: saved.max_permission ?? item.max_permission,
			}
			: item),
	}))
}

function seedEntry(client: QueryClient, saved: RawCompassEntry) {
	const entry = normalizeCompassEntry(saved)
	if (entry.id <= 0) return
	client.setQueryData<CompassEntry>(compassKeys.entry(entry.id), entry)
}

// Counts on the space, the topics rail and every list page of the space can move with any entry write.
async function invalidateSpaceContents(client: QueryClient, spaceId: number) {
	await Promise.all([
		client.invalidateQueries({queryKey: compassKeys.entryLists(spaceId)}),
		client.invalidateQueries({queryKey: compassKeys.topics(spaceId), exact: true}),
		client.invalidateQueries({queryKey: compassKeys.space(spaceId), exact: true}),
		client.invalidateQueries({queryKey: compassKeys.spaces, exact: true, refetchType: 'none'}),
	])
}

// ---------------------------------------------------------------------------
// Space mutations
// ---------------------------------------------------------------------------

export type CreateCompassSpaceInput = CompassSpaceText & {
	// 0 keeps the space personal; a team id shares it with that team's current members.
	team_id: number
}

export function createCompassSpaceMutationOptions() {
	return compassMutationOptions({
		mutationFn: async (input: CreateCompassSpaceInput) => normalizeCompassSpace((await compassSpacesCreate({
			body: {
				title: input.title,
				motto: input.motto,
				introduction: input.introduction,
				theme: input.theme,
				team_id: input.team_id,
			},
		})).data),
		onSuccess: (space, _input, client) => {
			client.setQueryData(compassKeys.space(space.id), space)
			client.setQueryData<CompassSpace[]>(compassKeys.spaces, current => current && [...current, space])
		},
		onSettled: (_input, client) => client.invalidateQueries({queryKey: compassKeys.spaces, exact: true}),
		successMessage: () => i18n.global.t('compass.space.created'),
	})
}

export function useCreateCompassSpaceMutation() {
	return useMutation(createCompassSpaceMutationOptions())
}

export type UpdateCompassSpaceInput = CompassSpaceText & {
	spaceId: number
	// The revision the form started from; the server answers 409 when someone saved in between.
	revision: number
}

/** Failures are not toasted: the settings form shows conflicts and lost permissions itself. */
export function updateCompassSpaceMutationOptions() {
	return compassMutationOptions({
		mutationFn: async (input: UpdateCompassSpaceInput) => (await compassSpacesUpdate({
			path: {space: input.spaceId},
			body: {
				title: input.title,
				motto: input.motto,
				introduction: input.introduction,
				theme: input.theme,
				revision: input.revision,
			},
		})).data,
		onSuccess: (saved, _input, client) => mergeSpace(client, saved),
		onSettled: async ({spaceId}, client) => {
			await Promise.all([
				client.invalidateQueries({queryKey: compassKeys.space(spaceId), exact: true}),
				client.invalidateQueries({queryKey: compassKeys.spaces, exact: true}),
			])
		},
		successMessage: () => i18n.global.t('compass.space.saved'),
		toastError: () => false,
	})
}

export function useUpdateCompassSpaceMutation() {
	return useMutation(updateCompassSpaceMutationOptions())
}

// ---------------------------------------------------------------------------
// Entry mutations
// ---------------------------------------------------------------------------

export type CreateCompassEntryInput = {
	spaceId: number
	entry: CompassEntryText & {pinned: boolean}
}

/** Failures are not toasted: the editor keeps the draft and explains what happened. */
export function createCompassEntryMutationOptions() {
	return compassMutationOptions({
		mutationFn: async ({spaceId, entry}: CreateCompassEntryInput) => normalizeCompassEntry((await compassEntriesCreate({
			path: {space: spaceId},
			body: {
				...compassEntryText(entry),
				pinned: entry.pinned,
				state: 'active',
			},
		})).data),
		onSuccess: (entry, _input, client) => seedEntry(client, entry),
		onSettled: ({spaceId}, client) => invalidateSpaceContents(client, spaceId),
		toastError: () => false,
	})
}

export function useCreateCompassEntryMutation() {
	return useMutation(createCompassEntryMutationOptions())
}

export type UpdateCompassEntryInput = {
	entryId: number
	spaceId: number
	entry: CompassEntryWritable
	revision: number
}

/** A full save from the editor. Failures are not toasted: the editor handles 409/404/403/400 in place. */
export function updateCompassEntryMutationOptions() {
	return compassMutationOptions({
		mutationFn: async ({entryId, entry, revision}: UpdateCompassEntryInput) => (await compassEntriesUpdate({
			path: {entry: entryId},
			body: {
				...compassEntryText(entry),
				pinned: entry.pinned,
				state: entry.state,
				revision,
			},
		})).data,
		onSuccess: (saved, _input, client) => mergeEntry(client, saved),
		onSettled: async ({entryId, spaceId}, client) => {
			await Promise.all([
				invalidateSpaceContents(client, spaceId),
				client.invalidateQueries({queryKey: compassKeys.revisions(entryId)}),
			])
		},
		toastError: () => false,
	})
}

export function useUpdateCompassEntryMutation() {
	return useMutation(updateCompassEntryMutationOptions())
}

export type CompassEntryMetaChange = {
	pinned?: boolean
	state?: CompassEntryState
}

export type SetCompassEntryMetaInput = {
	entryId: number
	spaceId: number
	change: CompassEntryMetaChange
}

function metaSuccessMessage({pinned, state}: CompassEntryMetaChange): string | undefined {
	const {t} = i18n.global
	if (state === 'trashed') return t('compass.entry.movedToTrash')
	if (state === 'archived') return t('compass.entry.archived')
	if (state === 'active') return t('compass.entry.restored')
	if (pinned === true) return t('compass.entry.pinned')
	if (pinned === false) return t('compass.entry.unpinned')
	return undefined
}

/**
 * Pin, archive, trash or restore. The change applies to the latest version, read right before the
 * write, so it never rolls back text someone else saved meanwhile; the text itself is sent unchanged.
 */
export function setCompassEntryMetaMutationOptions() {
	return compassMutationOptions({
		mutationFn: async ({entryId, change}: SetCompassEntryMetaInput, {request}) => {
			const latest = normalizeCompassEntry((await compassEntriesRead({path: {entry: entryId}})).data)
			// The write must go out under the account that read the entry.
			assertClientRequestContext(request)
			// The server unpins on trash anyway; saying so keeps the optimistic picture honest.
			const pinned = change.state === 'trashed' ? false : change.pinned ?? latest.pinned
			return (await compassEntriesUpdate({
				path: {entry: entryId},
				body: {
					...compassEntryText(latest),
					pinned,
					state: change.state ?? latest.state,
					revision: latest.revision,
				},
			})).data
		},
		onSuccess: (saved, _input, client) => mergeEntry(client, saved),
		onSettled: async ({entryId, spaceId}, client) => {
			await Promise.all([
				invalidateSpaceContents(client, spaceId),
				client.invalidateQueries({queryKey: compassKeys.entry(entryId), exact: true}),
				client.invalidateQueries({queryKey: compassKeys.revisions(entryId), refetchType: 'none'}),
			])
		},
		successMessage: (_saved, {change}) => metaSuccessMessage(change),
	})
}

export function useSetCompassEntryMetaMutation() {
	return useMutation(setCompassEntryMetaMutationOptions())
}

export type DeleteCompassEntryInput = {
	entryId: number
	spaceId: number
	// Only an entry already in the trash, at exactly this revision, can be deleted.
	revision: number
}

export function deleteCompassEntryMutationOptions() {
	return compassMutationOptions({
		mutationFn: async ({entryId, revision}: DeleteCompassEntryInput) => {
			await compassEntriesDelete({
				path: {entry: entryId},
				query: {revision},
			})
		},
		onSuccess: (_data, {entryId, spaceId}, client) => {
			removeFromPages<CompassEntrySummary>(client, compassKeys.entryLists(spaceId), entry => entry.id === entryId)
			client.removeQueries({queryKey: compassKeys.entry(entryId), exact: true})
			client.removeQueries({queryKey: compassKeys.revisions(entryId)})
		},
		onSettled: ({spaceId}, client) => invalidateSpaceContents(client, spaceId),
		successMessage: () => i18n.global.t('compass.entry.deleted'),
	})
}

export function useDeleteCompassEntryMutation() {
	return useMutation(deleteCompassEntryMutationOptions())
}

export type RestoreCompassRevisionInput = {
	entryId: number
	spaceId: number
	revision: number
	// The entry's current revision as shown; the server refuses with 409 if it moved on.
	expectedRevision: number
}

/** Failures are not toasted: the history page explains a conflict and reloads. */
export function restoreCompassRevisionMutationOptions() {
	return compassMutationOptions({
		mutationFn: async ({entryId, revision, expectedRevision}: RestoreCompassRevisionInput) => (await compassRevisionsRestore({
			path: {
				entry: entryId,
				revision,
			},
			body: {expected_revision: expectedRevision},
		})).data,
		onSuccess: (saved, _input, client) => mergeEntry(client, saved),
		onSettled: async ({entryId, spaceId}, client) => {
			await Promise.all([
				invalidateSpaceContents(client, spaceId),
				client.invalidateQueries({queryKey: compassKeys.entry(entryId), exact: true}),
				client.invalidateQueries({queryKey: compassKeys.revisions(entryId)}),
			])
		},
		successMessage: (_saved, {revision}) => i18n.global.t('compass.history.restored', {revision}),
		toastError: () => false,
	})
}

export function useRestoreCompassRevisionMutation() {
	return useMutation(restoreCompassRevisionMutationOptions())
}
