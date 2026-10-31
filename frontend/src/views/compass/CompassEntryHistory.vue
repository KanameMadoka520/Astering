<template>
	<CompassThemeScope
		:theme="theme"
		class="compass-history"
	>
		<template v-if="entry">
			<header class="compass-history__header">
				<RouterLink
					class="compass-history__back"
					:to="{name: 'compass.entry', params: {entryId: entry.id}}"
				>
					<Icon
						icon="arrow-left"
						class="compass-history__back-icon"
						aria-hidden="true"
					/>
					{{ t('compass.history.backToEntry') }}
				</RouterLink>
				<h1 class="compass-history__title">
					{{ t('compass.history.title') }}
				</h1>
				<p class="compass-history__subtitle">
					<CompassGlyph :kind="entry.kind" />
					<span>{{ entry.title }}</span>
				</p>
			</header>

			<div
				ref="layout"
				class="compass-history__layout"
				:class="{
					'is-split': isSplit,
					'has-selection': explicitRevision > 0,
				}"
			>
				<section
					class="compass-history__list"
					:aria-labelledby="listHeadingId"
				>
					<h2
						:id="listHeadingId"
						ref="listHeading"
						class="compass-history__list-title"
						tabindex="-1"
					>
						{{ t('compass.history.versions') }}
					</h2>
					<CompassRevisionList
						:entry-id="entry.id"
						:revisions="revisions"
						:current-revision="entry.revision"
						:current-title="entry.title"
						:selected="selectedRevision"
						:page="page"
						:total-pages="totalPages"
						:person-name="personName"
						:loading="revisionsPending"
						:failed="revisionsError && !revisionsData"
						:refreshing="revisionsFetching"
						@retry="refetchRevisions()"
					/>
				</section>

				<div class="compass-history__detail">
					<!-- Same route, other query: RouterLink would otherwise call this link the current page. -->
					<RouterLink
						class="compass-history__to-list"
						:to="listRoute"
						aria-current="false"
					>
						<Icon
							icon="arrow-left"
							class="compass-history__back-icon"
							aria-hidden="true"
						/>
						{{ t('compass.history.backToList') }}
					</RouterLink>
					<CompassRevisionView
						v-if="selectedRevision > 0 && (isSplit || explicitRevision > 0)"
						ref="revisionView"
						:entry="entry"
						:revision="selectedRevision"
						:space-theme="space?.theme"
						:person-name="personName"
						@stale="reloadAll"
					/>
				</div>
			</div>
		</template>

		<div
			v-else-if="notFound"
			class="compass-history__state"
		>
			<h1 class="compass-history__state-title">
				{{ t('compass.reader.notFound') }}
			</h1>
			<p>{{ t('compass.reader.notFoundHint') }}</p>
			<RouterLink
				class="compass-history__state-link"
				:to="{name: 'compass.index'}"
			>
				<Icon
					icon="compass"
					aria-hidden="true"
				/>
				{{ t('compass.reader.toCompass') }}
			</RouterLink>
		</div>

		<div
			v-else-if="loadFailed"
			class="compass-history__state"
			role="alert"
		>
			<h1 class="compass-history__state-title">
				{{ t('compass.reader.loadFailed') }}
			</h1>
			<p v-if="failure === 'network'">
				{{ t('compass.reader.offline') }}
			</p>
			<XButton
				variant="secondary"
				:shadow="false"
				icon="undo"
				:loading="entryFetching"
				:aria-disabled="entryFetching"
				@click="retryEntry"
			>
				{{ t('misc.retry') }}
			</XButton>
		</div>

		<div
			v-else
			class="compass-history__skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ t('misc.loading') }}</span>
			<span
				class="compass-history__skeleton-title"
				aria-hidden="true"
			/>
			<span
				v-for="row in 4"
				:key="row"
				class="compass-history__skeleton-row"
				aria-hidden="true"
			/>
		</div>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed, nextTick, useId, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, type LocationQueryValue, type RouteLocationRaw} from 'vue-router'
import {useElementSize} from '@vueuse/core'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassRevisionList from '@/components/compass/history/CompassRevisionList.vue'
import CompassRevisionView from '@/components/compass/history/CompassRevisionView.vue'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import {
	useCompassEntry,
	useCompassPeople,
	useCompassRevisions,
	useCompassSpace,
} from '@/composables/useCompass'
import {useTitle} from '@/composables/useTitle'
import {resolveCompassTheme} from '@/helpers/compass/constants'
import {classifyCompassFailure} from '@/helpers/compass/errors'

const props = defineProps<{
	entryId: number
}>()

const {t} = useI18n({useScope: 'global'})
const route = useRoute()

const {
	entry,
	error: entryError,
	isError: entryIsError,
	isFetching: entryFetching,
	refetch: refetchEntry,
} = useCompassEntry(() => props.entryId)
const {space} = useCompassSpace(() => entry.value?.space_id ?? 0)
const {personName} = useCompassPeople(space)

useTitle(() => entry.value
	? `${t('compass.history.title')} · ${entry.value.title}`
	: t('compass.history.title'))

const theme = computed(() => resolveCompassTheme(entry.value?.theme, space.value?.theme))

function positiveInteger(value: LocationQueryValue | LocationQueryValue[] | undefined): number {
	const first = Array.isArray(value) ? value[0] : value
	const parsed = Number(first)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

// 0 when the URL names no version: the current one is shown, and phones show the list.
const explicitRevision = computed(() => positiveInteger(route.query.revision))
const page = computed(() => positiveInteger(route.query.page) || 1)
const selectedRevision = computed(() => explicitRevision.value || entry.value?.revision || 0)

const {
	revisions,
	totalPages,
	data: revisionsData,
	isPending: revisionsPending,
	isError: revisionsError,
	isFetching: revisionsFetching,
	refetch: refetchRevisions,
} = useCompassRevisions(() => props.entryId, page)

const failure = computed(() => entryIsError.value ? classifyCompassFailure(entryError.value) : null)
const notFound = computed(() => props.entryId <= 0 || failure.value === 'missing' || failure.value === 'forbidden')
const loadFailed = computed(() => failure.value !== null && failure.value !== 'aborted')

function retryEntry() {
	if (entryFetching.value) return
	refetchEntry()
}

// After a conflict the shown version numbers are stale; both the entry and its list catch up.
function reloadAll() {
	refetchEntry()
	refetchRevisions()
}

const listRoute = computed<RouteLocationRaw>(() => ({
	name: 'compass.entry.history',
	params: {entryId: props.entryId},
	query: page.value > 1 ? {page: page.value} : {},
}))

const listHeadingId = useId()
const listHeading = useTemplateRef<HTMLElement>('listHeading')
const revisionView = useTemplateRef<InstanceType<typeof CompassRevisionView>>('revisionView')
const layout = useTemplateRef<HTMLElement>('layout')

// List beside the snapshot once both fit: a 20rem list next to a readable page.
const SPLIT_LAYOUT_REM = 56
const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
const {width: layoutWidth} = useElementSize(layout)
const isSplit = computed(() => layoutWidth.value >= SPLIT_LAYOUT_REM * rootFontSize)

// One pane at a time on narrow screens: the link that was used is hidden now, so focus follows the pane.
watch(explicitRevision, async (now, before) => {
	if (isSplit.value || now === before) return
	await nextTick()
	if (now > 0) revisionView.value?.focusHeading()
	else listHeading.value?.focus()
})
</script>

<style lang="scss" scoped>
.compass-history {
	max-inline-size: var(--page-max-width);
	margin-inline: auto;
	padding-block-end: var(--space-10);
}

.compass-history__header {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-2);
	margin-block-end: var(--space-8);
	padding-block-end: var(--space-5);
	border-block-end: 1px solid var(--compass-rule);
}

.compass-history__back,
.compass-history__to-list {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: max(var(--control-height), var(--target-min));
	border-radius: $radius;
	color: var(--compass-ink-soft);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	text-decoration: none;

	&:hover {
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-history__back-icon {
	flex: none;

	[dir='rtl'] & {
		transform: scaleX(-1);
	}
}

.compass-history__title {
	margin: 0;
	color: var(--compass-ink);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.compass-history__subtitle {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	max-inline-size: var(--compass-measure);
	margin: 0;
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	line-height: 1.45;
	overflow-wrap: anywhere;

	svg {
		--compass-glyph-size: 1rem;

		align-self: center;
	}
}

// ---------------------------------------------------------------------------
// Layout: list and snapshot side by side when they fit, one pane at a time otherwise
// ---------------------------------------------------------------------------

.compass-history__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-8);

	&.is-split {
		grid-template-columns: 20rem minmax(0, 1fr);
		align-items: start;

		.compass-history__list {
			position: sticky;
			inset-block-start: calc(var(--header-height) + var(--space-6));
			max-block-size: calc(100dvh - var(--header-height) - var(--space-6) * 2);
			overflow-y: auto;
			overscroll-behavior: contain;
		}

		.compass-history__to-list {
			display: none;
		}
	}

	&:not(.is-split) {
		&.has-selection .compass-history__list {
			display: none;
		}

		&:not(.has-selection) .compass-history__detail {
			display: none;
		}
	}
}

.compass-history__list {
	min-inline-size: 0;
}

.compass-history__list-title {
	margin: 0 0 var(--space-3);
	padding-inline: var(--space-3);
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .08em;
	text-transform: uppercase;

	&:focus {
		outline: none;
	}
}

.compass-history__detail {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	min-inline-size: 0;
	max-inline-size: calc(var(--compass-measure) + var(--space-8) * 2);
}

.compass-history__to-list {
	align-self: flex-start;
}

// ---------------------------------------------------------------------------
// Not found, failure, first load
// ---------------------------------------------------------------------------

.compass-history__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	max-inline-size: var(--compass-measure);
	margin: var(--space-10) auto 0;
	color: var(--compass-ink-soft);
	text-align: center;

	p {
		margin: 0;
	}
}

.compass-history__state-title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-2xl);
	font-weight: 600;
	line-height: 1.3;
	text-wrap: balance;
}

.compass-history__state-link {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: none;

	&:hover {
		text-decoration: underline;
		text-underline-offset: .2em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-history__skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-inline-size: 40rem;

	> span:not(.is-sr-only) {
		display: block;
		border-radius: var(--radius-xs);
		background: var(--surface-active);
	}
}

.compass-history__skeleton-title {
	inline-size: 14rem;
	max-inline-size: 70%;
	block-size: 1.75rem;
	margin-block-end: var(--space-4);
}

.compass-history__skeleton-row {
	inline-size: 100%;
	block-size: 2.75rem;
}

@media print {
	.compass-history__back,
	.compass-history__list,
	.compass-history__to-list {
		display: none;
	}

	.compass-history__layout,
	.compass-history__layout.is-split {
		display: block;
	}
}
</style>
