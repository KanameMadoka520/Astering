<template>
	<section
		ref="root"
		class="compass-library"
		:class="{'has-rail': showRail}"
		aria-labelledby="compass-library-title"
	>
		<!-- Hash target: the router scrolls to it with window.scrollTo, which ignores scroll-padding, so it
			sits a header's height above the section and the heading lands in view. -->
		<span
			id="compass-library"
			class="compass-library__anchor"
			aria-hidden="true"
		/>

		<div class="compass-library__main">
			<header class="compass-library__header">
				<h2
					id="compass-library-title"
					ref="heading"
					class="compass-library__title"
					tabindex="-1"
				>
					{{ t('compass.library.title') }}
				</h2>
				<p
					class="compass-library__summary"
					role="status"
					aria-live="polite"
				>
					{{ summary }}
				</p>
			</header>

			<div class="compass-library__toolbar d-print-none">
				<label class="compass-library__search">
					<span class="is-sr-only">{{ t('compass.library.search') }}</span>
					<Icon
						icon="search"
						class="compass-library__search-icon"
					/>
					<input
						ref="searchInput"
						v-model="search"
						type="search"
						class="compass-library__field compass-library__search-field"
						:placeholder="t('compass.library.searchPlaceholder')"
						maxlength="200"
						enterkeyhint="search"
						autocomplete="off"
						@input="scheduleSearch"
						@keydown.enter="searchNow"
						@keydown.esc="clearSearch"
					>
				</label>

				<SegmentedControl
					class="compass-library__kinds"
					:model-value="state.kind"
					:options="kindOptions"
					:label="t('compass.library.kindLabel')"
					@update:modelValue="change({kind: $event})"
				/>

				<div class="compass-library__selects">
					<label class="compass-library__select">
						<span class="compass-library__select-label">{{ t('compass.library.show') }}</span>
						<select
							class="compass-library__field"
							:value="state.state"
							@change="selectState"
						>
							<option
								v-for="option in COMPASS_STATE_FILTERS"
								:key="option"
								:value="option"
							>
								{{ t(`compass.library.states.${option}`) }}
							</option>
						</select>
					</label>
					<label class="compass-library__select">
						<span class="compass-library__select-label">{{ t('compass.library.sort') }}</span>
						<select
							class="compass-library__field"
							:value="state.sort"
							@change="selectSort"
						>
							<option
								v-for="option in COMPASS_SORTS"
								:key="option"
								:value="option"
							>
								{{ t(`compass.library.sorts.${option}`) }}
							</option>
						</select>
					</label>
				</div>
			</div>

			<CompassTopics
				v-if="hasTopics && !isWide"
				class="d-print-none"
				layout="disclosure"
				:categories="categories"
				:tags="tags"
				:selected-category="state.category"
				:selected-tag="state.tag"
				@toggleCategory="toggleCategory"
				@toggleTag="toggleTag"
			/>

			<div
				v-if="chips.length > 0"
				ref="chipRow"
				class="compass-library__chips d-print-none"
			>
				<ul
					class="compass-library__chip-list"
					:aria-label="t('compass.library.filters')"
				>
					<li
						v-for="chip in chips"
						:key="chip.key"
						class="compass-library__chip"
					>
						<span class="compass-library__chip-label">{{ chip.label }}</span>
						<button
							type="button"
							class="compass-library__chip-remove"
							:aria-label="t('compass.library.removeFilter', {filter: chip.label})"
							:title="t('compass.library.removeFilter', {filter: chip.label})"
							@click="removeChip(chip.key)"
						>
							<Icon icon="times" />
						</button>
					</li>
				</ul>
				<button
					type="button"
					class="compass-library__clear"
					@click="clearFilters"
				>
					{{ t('compass.library.clearAll') }}
				</button>
			</div>

			<p
				v-if="state.state === 'trashed'"
				class="compass-library__trash-note"
			>
				<Icon
					icon="trash-alt"
					class="compass-library__trash-icon"
				/>
				<span>{{ t('compass.library.trashNote') }}</span>
			</p>

			<LoadError
				v-if="isError && data === undefined"
				:retry="() => refetch()"
			/>

			<div
				v-else-if="data === undefined"
				class="compass-library__skeleton"
				role="status"
			>
				<span class="is-sr-only">{{ t('compass.library.loading') }}</span>
				<div
					v-for="row in 4"
					:key="row"
					class="compass-library__skeleton-row"
					aria-hidden="true"
				>
					<span class="compass-library__skeleton-line is-meta" />
					<span class="compass-library__skeleton-line is-title" />
					<span class="compass-library__skeleton-line" />
				</div>
			</div>

			<div
				v-else
				class="compass-library__results"
				:class="{'is-stale': isPlaceholderData}"
				:aria-busy="isPlaceholderData"
			>
				<ol
					v-if="entries.length > 0"
					class="compass-library__list"
				>
					<CompassEntryRow
						v-for="entry in entries"
						:key="entry.id"
						:entry="entry"
						:term="state.q"
						:date-field="state.sort === 'created' ? 'created' : 'updated'"
						:restoring="restoringIds.has(entry.id)"
						@restore="restore"
						@delete="deleteTarget = $event"
					/>
				</ol>

				<CompassInvitations
					v-else-if="emptyKind === 'library' && canWrite"
					:space-id="space.id"
				/>

				<div
					v-else
					class="compass-library__empty"
				>
					<p>{{ emptyText }}</p>
					<button
						v-if="emptyKind === 'filtered'"
						type="button"
						class="compass-library__clear"
						@click="clearFilters"
					>
						{{ t('compass.library.clearFilters') }}
					</button>
					<button
						v-else-if="emptyKind === 'archivedOnly'"
						type="button"
						class="compass-library__clear"
						@click="change({state: 'archived'})"
					>
						{{ t('compass.library.showArchive') }}
					</button>
				</div>

				<Pagination
					v-if="totalPages > 1"
					class="compass-library__pagination d-print-none"
					:total-pages="totalPages"
					:current-page="state.page"
				/>
			</div>
		</div>

		<CompassTopics
			v-if="hasTopics && isWide"
			class="compass-library__rail d-print-none"
			layout="rail"
			:categories="categories"
			:tags="tags"
			:selected-category="state.category"
			:selected-tag="state.tag"
			@toggleCategory="toggleCategory"
			@toggleTag="toggleTag"
		/>

		<CompassPermanentDeleteDialog
			:enabled="deleteTarget !== null"
			:entry-title="deleteTarget?.title ?? ''"
			:loading="deleteEntry.isPending.value"
			@close="deleteTarget = null"
			@confirm="confirmDelete"
		/>
	</section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter, type RouteLocationRaw} from 'vue-router'
import {useMediaQuery} from '@vueuse/core'
import CompassPermanentDeleteDialog from '@/components/compass/base/CompassPermanentDeleteDialog.vue'
import SegmentedControl, {type SegmentedOption} from '@/components/input/SegmentedControl.vue'
import Icon from '@/components/misc/Icon'
import Pagination from '@/components/misc/Pagination.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import CompassEntryRow from './CompassEntryRow.vue'
import CompassInvitations from './CompassInvitations.vue'
import CompassTopics from './CompassTopics.vue'
import {
	canWriteCompass,
	useDeleteCompassEntryMutation,
	useSetCompassEntryMetaMutation,
	type CompassEntrySummary,
	type CompassSpace,
} from '@/client/queries/compass'
import {clampPage} from '@/client/queries/pagination'
import {useCompassEntries, useCompassTopics} from '@/composables/useCompass'
import {
	COMPASS_KINDS,
	COMPASS_SORTS,
	COMPASS_STATE_FILTERS,
	isCompassSort,
	isCompassStateFilter,
	type CompassKind,
} from '@/helpers/compass/constants'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {
	compassEntryFiltersFor,
	compassLibraryStateToQuery,
	parseCompassLibraryQuery,
	withCompassLibraryChange,
	type CompassLibraryState,
} from '@/helpers/compass/libraryQuery'

const props = defineProps<{
	space: CompassSpace
}>()

type LibraryChange = Partial<Omit<CompassLibraryState, 'page'>>
type ChipKey = 'category' | 'tag' | 'pinned' | 'q'
type EmptyKind = 'filtered' | 'library' | 'archivedOnly' | 'archive' | 'all' | 'trash'

const LIBRARY_HASH = '#compass-library'
const SEARCH_DELAY = 300

const {t, locale} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const isWide = useMediaQuery('(min-width: 1024px)')

const root = useTemplateRef<HTMLElement>('root')
const heading = useTemplateRef<HTMLElement>('heading')
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const chipRow = useTemplateRef<HTMLElement>('chipRow')

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

// Frozen while another route is on its way in, so leaving never fires a query for that route's parameters.
const state = ref<CompassLibraryState>(parseCompassLibraryQuery(route.query))
watch(() => route.query, query => {
	if (route.name !== 'compass.space') return
	state.value = parseCompassLibraryQuery(query)
})

// The router scrolls to the top on every navigation; the hash brings the library back into view instead.
function locationFor(next: CompassLibraryState): RouteLocationRaw {
	return {
		name: 'compass.space',
		params: {spaceId: props.space.id},
		query: compassLibraryStateToQuery(next),
		hash: LIBRARY_HASH,
	}
}

function change(patch: LibraryChange) {
	return router.push(locationFor(withCompassLibraryChange(state.value, patch)))
}

// Page links come from the shared Pagination, which cannot carry the hash. The frame callback runs after
// the router's own scroll to the top. Switching to another space keeps that scroll to the top.
watch([() => props.space.id, () => state.value.page], ([spaceId, page], [previousSpaceId, previousPage]) => {
	if (spaceId !== previousSpaceId || page === previousPage) return
	// scrollIntoView honours the page's scroll-padding for the fixed header.
	requestAnimationFrame(() => root.value?.scrollIntoView({block: 'start'}))
})

const filters = computed(() => compassEntryFiltersFor(state.value))
const {
	data,
	entries,
	totalPages,
	isError,
	isPlaceholderData,
	refetch,
} = useCompassEntries(() => props.space.id, filters, () => state.value.page)

watch([data, isPlaceholderData], ([current, placeholder]) => {
	const page = state.value.page
	const clamped = clampPage(page, {
		data: current,
		isPlaceholderData: placeholder,
	})
	if (clamped === page) return
	void router.replace(locationFor({
		...state.value,
		page: clamped,
	}))
}, {immediate: true})

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Initial local input snapshot; the route watcher below reconciles later changes.
// eslint-disable-next-line vue/no-ref-object-reactivity-loss
const search = ref(state.value.q)
// The value this view last sent; when it comes back through the route it must not overwrite newer typing.
// eslint-disable-next-line vue/no-ref-object-reactivity-loss
let sentQuery = state.value.q
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(() => state.value.q, q => {
	if (q === sentQuery) return
	sentQuery = q
	clearTimeout(searchTimer)
	search.value = q
})

function scheduleSearch() {
	clearTimeout(searchTimer)
	searchTimer = setTimeout(commitSearch, SEARCH_DELAY)
}

function commitSearch() {
	clearTimeout(searchTimer)
	const q = search.value.trim()
	if (q === state.value.q) return
	sentQuery = q
	void router.replace(locationFor(withCompassLibraryChange(state.value, {q})))
}

// Enter and Escape while an input method is composing pick or drop a candidate; they are not meant for the search.
function searchNow(event: KeyboardEvent) {
	if (event.isComposing) return
	event.preventDefault()
	commitSearch()
}

function clearSearch(event: KeyboardEvent) {
	if (event.isComposing || search.value === '') return
	event.preventDefault()
	search.value = ''
	commitSearch()
}

onBeforeUnmount(() => clearTimeout(searchTimer))

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const kindOptions = computed<SegmentedOption<CompassKind | ''>[]>(() => [
	{
		value: '',
		label: t('compass.library.allKinds'),
	},
	...COMPASS_KINDS.map(kind => ({
		value: kind,
		label: t(`compass.kindPlural.${kind}`),
	})),
])

function selectState(event: Event) {
	const value = (event.target as HTMLSelectElement).value
	if (isCompassStateFilter(value)) void change({state: value})
}

function selectSort(event: Event) {
	const value = (event.target as HTMLSelectElement).value
	if (isCompassSort(value)) void change({sort: value})
}

function toggleCategory(name: string) {
	void change({category: state.value.category === name ? '' : name})
}

function toggleTag(name: string) {
	void change({tag: state.value.tag === name ? '' : name})
}

const hasFilters = computed(() => {
	const {q, kind, category, tag, pinned} = state.value
	return q !== '' || kind !== '' || category !== '' || tag !== '' || pinned
})

const chips = computed(() => {
	const {q, category, tag, pinned} = state.value
	const list: {key: ChipKey, label: string}[] = []
	if (category !== '') {
		list.push({
			key: 'category',
			label: t('compass.library.chip.category', {name: category}),
		})
	}
	if (tag !== '') {
		list.push({
			key: 'tag',
			label: t('compass.library.chip.tag', {name: tag}),
		})
	}
	if (pinned) {
		list.push({
			key: 'pinned',
			label: t('compass.library.chip.pinned'),
		})
	}
	if (q !== '') {
		list.push({
			key: 'q',
			label: t('compass.library.chip.q', {q}),
		})
	}
	return list
})

// A removed chip takes its button along; focus moves on to what remains of the row, or to the search.
async function moveFocusAfterFilterChange() {
	await nextTick()
	const target = chipRow.value?.querySelector<HTMLElement>('button') ?? searchInput.value
	target?.focus()
}

function withoutChip(key: ChipKey): LibraryChange {
	switch (key) {
		case 'category':
			return {category: ''}
		case 'tag':
			return {tag: ''}
		case 'pinned':
			return {pinned: false}
		case 'q':
			return {q: ''}
	}
}

async function removeChip(key: ChipKey) {
	if (key === 'q') {
		clearTimeout(searchTimer)
		search.value = ''
	}
	await change(withoutChip(key))
	await moveFocusAfterFilterChange()
}

async function clearFilters() {
	clearTimeout(searchTimer)
	search.value = ''
	await change({
		q: '',
		kind: '',
		category: '',
		tag: '',
		pinned: false,
	})
	await moveFocusAfterFilterChange()
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

const topics = useCompassTopics(() => props.space.id)
const categories = topics.categories
const tags = topics.tags
// The library works without the rail, so a failed read just hides it.
const hasTopics = computed(() => !(topics.isError.value && topics.data.value === undefined) &&
	(categories.value.length > 0 || tags.value.length > 0))
const showRail = computed(() => hasTopics.value && isWide.value)

// ---------------------------------------------------------------------------
// Summary and empty states
// ---------------------------------------------------------------------------

const canWrite = computed(() => canWriteCompass(props.space))

// Rows from the previous filter stay on screen while the next ones load. Their count must not be
// announced against the new filter, so the sentence only changes when a real answer arrives.
const summary = ref('')
watch([data, isPlaceholderData, locale], ([current, placeholder]) => {
	if (placeholder) return
	if (current === undefined) {
		summary.value = ''
		return
	}
	const n = current.total
	summary.value = state.value.q === ''
		? t(`compass.library.count.${state.value.state}`, {n}, n)
		: t('compass.library.matches', {
			n,
			q: state.value.q,
		}, n)
}, {immediate: true})

const emptyKind = computed<EmptyKind>(() => {
	if (hasFilters.value) return 'filtered'
	switch (state.value.state) {
		case 'trashed':
			return 'trash'
		case 'archived':
			return 'archive'
		case 'all':
			return 'all'
		default:
			// The space counts archived writing too; an empty shelf then means everything was put away.
			return props.space.entry_count > 0 ? 'archivedOnly' : 'library'
	}
})

const emptyText = computed(() => {
	switch (emptyKind.value) {
		case 'filtered':
			return t('compass.library.noMatch')
		case 'trash':
			return t('compass.library.trashEmpty')
		case 'archive':
			return t('compass.library.archiveEmpty')
		case 'archivedOnly':
			return t('compass.library.archivedOnly')
		default:
			return t('compass.library.empty')
	}
})

// ---------------------------------------------------------------------------
// Restore and permanent delete
// ---------------------------------------------------------------------------

const setMeta = useSetCompassEntryMetaMutation()
const deleteEntry = useDeleteCompassEntryMutation()

const restoringIds = ref<ReadonlySet<number>>(new Set())
// Kept apart from everything else: only the dialog may open or close it.
const deleteTarget = ref<CompassEntrySummary | null>(null)

let focusTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(focusTimer))

// The row that held focus may be gone after a restore or delete; the heading is the stable place to land.
function focusHeadingIfLost() {
	const active = document.activeElement
	if (active && active !== document.body) return
	heading.value?.focus()
}

async function restore(entry: CompassEntrySummary) {
	if (restoringIds.value.has(entry.id)) return
	restoringIds.value = new Set([...restoringIds.value, entry.id])
	try {
		await setMeta.mutateAsync({
			entryId: entry.id,
			spaceId: entry.space_id,
			change: {state: 'active'},
		})
	} catch {
		// Toasted by the mutation.
		return
	} finally {
		const next = new Set(restoringIds.value)
		next.delete(entry.id)
		restoringIds.value = next
	}
	await nextTick()
	focusHeadingIfLost()
}

async function confirmDelete() {
	const target = deleteTarget.value
	if (target === null || deleteEntry.isPending.value) return
	try {
		await deleteEntry.mutateAsync({
			entryId: target.id,
			spaceId: target.space_id,
			revision: target.revision,
		})
	} catch (cause) {
		// Toasted by the mutation. A newer version, a vanished or restored entry, or lost admin rights make
		// this dialog's target stale; confirming again could only fail the same way.
		const failure = classifyCompassFailure(cause)
		const stale = failure === 'conflict' || failure === 'missing' ||
			failure === 'invalidState' || failure === 'forbidden'
		if (stale && deleteTarget.value?.id === target.id) {
			deleteTarget.value = null
		}
		return
	}
	if (deleteTarget.value?.id !== target.id) return
	deleteTarget.value = null
	// The dialog hands focus back to the deleted row's button only after its closing fade.
	clearTimeout(focusTimer)
	focusTimer = setTimeout(focusHeadingIfLost, 250)
}
</script>

<style lang="scss" scoped>
.compass-library {
	position: relative;
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-6) clamp(var(--space-6), 3vw, var(--space-10));
	align-items: start;

	&.has-rail {
		grid-template-columns: minmax(0, 1fr) clamp(12rem, 24%, 16rem);
	}
}

.compass-library__anchor {
	position: absolute;
	inset-block-start: calc(-1 * (var(--header-height) + var(--space-4)));
	inset-inline-start: 0;
	inline-size: 1px;
	block-size: 1px;
	pointer-events: none;
}

.compass-library__main {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	min-inline-size: 0;
}

.compass-library__header {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--space-1) var(--space-4);
}

.compass-library__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-xl);
	font-weight: 600;

	&:focus-visible {
		@include focus-ring;
	}

	&:focus:not(:focus-visible) {
		outline: none;
	}
}

.compass-library__summary {
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.compass-library__toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
}

.compass-library__search {
	position: relative;
	display: flex;
	flex: 1 1 100%;
	min-inline-size: 0;
}

.compass-library__search-icon {
	position: absolute;
	inset-block: 0;
	inset-inline-start: .75rem;
	margin-block: auto;
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	pointer-events: none;
}

.compass-library__field {
	inline-size: 100%;
	min-inline-size: 0;
	min-block-size: var(--control-height);
	padding: .3rem .7rem;
	border: 1px solid var(--input-border-color);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-md);

	&:hover {
		border-color: var(--input-hover-border-color);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}

	@media (pointer: coarse) {
		min-block-size: var(--target-min);
	}
}

.compass-library__search-field {
	padding-inline-start: 2.1rem;
}

.compass-library__kinds {
	flex: 1 1 auto;
	min-inline-size: 0;
}

.compass-library__selects {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2) var(--space-3);
}

.compass-library__select {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;

	.compass-library__field {
		inline-size: auto;
		max-inline-size: 100%;
	}
}

.compass-library__select-label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	white-space: nowrap;
}

.compass-library__chips {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
}

.compass-library__chip-list {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-library__chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	max-inline-size: 100%;
	padding-block: .125rem;
	padding-inline: var(--space-3) .125rem;
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-full);
	background: var(--compass-accent-tint);
	color: var(--compass-ink);
	font-size: var(--text-sm);
}

.compass-library__chip-label {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-library__chip-remove {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	inline-size: 1.75rem;
	block-size: 1.75rem;
	padding: 0;
	border: 0;
	border-radius: var(--radius-full);
	background: none;
	color: var(--compass-ink-soft);
	cursor: pointer;

	&:hover {
		background-color: var(--surface-hover);
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}

	@media (pointer: coarse) {
		inline-size: var(--target-min);
		block-size: var(--target-min);
	}
}

.compass-library__clear {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	padding: 0 var(--space-1);
	border: 0;
	background: none;
	color: var(--compass-accent);
	font: inherit;
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: .22em;
	cursor: pointer;

	&:hover {
		text-decoration-thickness: 2px;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-library__trash-note {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 2px solid var(--compass-rule-strong);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.compass-library__trash-icon {
	flex: none;
	inline-size: .875em;
}

.compass-library__results {
	transition: opacity var(--motion-base) var(--ease-standard);

	&.is-stale {
		opacity: .6;
	}
}

.compass-library__list {
	margin: 0;
	padding: 0;
	list-style: none;
	border-block-start: 1px solid var(--compass-rule);
}

.compass-library__empty {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	padding: var(--space-6) var(--space-1);
	border-block: 1px solid var(--compass-rule);
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: 1.1rem;
}

.compass-library__pagination {
	margin-block-start: var(--space-2);
}

.compass-library__skeleton {
	border-block-start: 1px solid var(--compass-rule);
}

.compass-library__skeleton-row {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-4) var(--space-3);
	border-block-end: 1px solid var(--compass-rule);
}

.compass-library__skeleton-line {
	display: block;
	inline-size: 60%;
	max-inline-size: 36rem;
	block-size: .75rem;
	border-radius: var(--radius-xs);
	background: var(--surface-active);
	animation: compass-library-pulse 1.6s var(--ease-standard) infinite alternate;

	&.is-meta {
		inline-size: 30%;
		max-inline-size: 12rem;
		block-size: .625rem;
	}

	&.is-title {
		inline-size: 45%;
		max-inline-size: 24rem;
		block-size: 1.125rem;
	}

	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
}

@keyframes compass-library-pulse {
	from {
		opacity: 1;
	}

	to {
		opacity: .5;
	}
}

.compass-library__rail {
	grid-column: 2;
	grid-row: 1;
}
</style>
