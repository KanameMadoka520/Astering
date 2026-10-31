<template>
	<CompassThemeScope
		:theme="theme"
		class="compass-reader"
	>
		<template v-if="entry">
			<CompassReadingProgress :target="article" />

			<div class="compass-reader__bar d-print-none">
				<RouterLink
					class="compass-reader__back"
					:to="{name: 'compass.space', params: {spaceId: entry.space_id}}"
					:aria-label="t('compass.reader.backTo', {space: spaceTitle})"
				>
					<Icon
						icon="arrow-left"
						class="compass-reader__back-icon"
						aria-hidden="true"
					/>
					<span class="compass-reader__back-text">{{ spaceTitle }}</span>
				</RouterLink>
				<CompassEntryActions
					:entry="entry"
					:prefs="prefs"
					@updatePrefs="setPrefs"
				/>
			</div>

			<div
				ref="layout"
				class="compass-reader__layout"
				:class="{'is-wide': isWide}"
			>
				<div class="compass-reader__main">
					<CompassEntryStateBanner
						class="compass-reader__notice"
						:state="entry.state"
					/>
					<div
						v-if="staleFailure"
						class="compass-reader__notice d-print-none"
						role="status"
					>
						<Message variant="warning">
							<span class="compass-reader__stale">
								<span>{{ t('compass.reader.stale') }}</span>
								<XButton
									variant="tertiary"
									:shadow="false"
									icon="undo"
									:loading="isFetching"
									:aria-disabled="isFetching"
									@click="retry"
								>
									{{ t('misc.retry') }}
								</XButton>
							</span>
						</Message>
					</div>

					<article
						ref="article"
						class="compass-reader__article"
						:aria-labelledby="titleId"
					>
						<header class="compass-reader__header">
							<p class="compass-reader__kicker">
								<CompassKindLabel :kind="entry.kind" />
								<RouterLink
									v-if="entry.category"
									class="compass-reader__kicker-item compass-reader__category"
									:to="libraryLink({category: entry.category})"
								>
									{{ entry.category }}
								</RouterLink>
								<span
									v-if="entry.pinned"
									class="compass-reader__kicker-item compass-reader__pinned"
								>
									<CompassGlyph kind="guide" />
									{{ t('compass.reader.pinned') }}
								</span>
								<CompassStateBadge :state="entry.state" />
							</p>

							<h1
								:id="titleId"
								ref="title"
								class="compass-reader__title"
								tabindex="-1"
							>
								{{ entry.title }}
							</h1>
							<p
								v-if="entry.subtitle.trim()"
								class="compass-reader__subtitle"
							>
								{{ entry.subtitle.trim() }}
							</p>

							<blockquote
								v-if="quote"
								class="compass-reader__epigraph"
							>
								{{ quote }}
							</blockquote>

							<p class="compass-reader__meta">
								<i18n-t
									v-if="entry.updated"
									keypath="compass.reader.updated"
									tag="span"
									scope="global"
								>
									<template #date>
										<time
											:datetime="formatISO(entry.updated)"
											:title="formatDateLong(entry.updated)"
										>
											<span class="d-print-none">{{ formatDisplayDate(entry.updated) }}</span>
											<span class="compass-reader__print-date">{{ formatDateLong(entry.updated) }}</span>
										</time>
									</template>
								</i18n-t>
								<span>{{ t('compass.reader.version', {revision: entry.revision}) }}</span>
								<span v-if="readingMinutes > 0">
									{{ t('compass.reader.readingTime', {minutes: readingMinutes}) }}
								</span>
								<span v-if="updatedBy">{{ t('compass.reader.by', {person: updatedBy}) }}</span>
							</p>

							<ul
								v-if="entry.tags.length > 0"
								class="compass-reader__tags"
								:aria-label="t('compass.reader.tags')"
							>
								<li
									v-for="tag in entry.tags"
									:key="tag"
								>
									<RouterLink
										class="compass-reader__tag"
										:to="libraryLink({tag})"
									>
										#{{ tag }}
									</RouterLink>
								</li>
							</ul>
						</header>

						<div
							v-if="hasBody || !quote"
							class="compass-reader__ornament"
							aria-hidden="true"
						>
							<CompassGlyph
								kind="guide"
								class="is-side"
							/>
							<CompassGlyph kind="guide" />
							<CompassGlyph
								kind="guide"
								class="is-side"
							/>
						</div>

						<CompassToc
							v-if="!isWide && hasBody"
							layout="disclosure"
							:headings="prepared.headings"
						/>

						<CompassProse
							v-if="hasBody"
							class="compass-reader__body"
							:prepared="prepared"
							:space-id="entry.space_id"
							:font="prefs.font"
							:size="prefs.size"
						/>
						<div
							v-else-if="!quote"
							class="compass-reader__empty"
						>
							<p>{{ t('compass.reader.empty') }}</p>
							<RouterLink
								v-if="canEdit"
								class="compass-reader__empty-link d-print-none"
								:to="{name: 'compass.entry.edit', params: {entryId: entry.id}}"
							>
								<Icon
									icon="feather"
									aria-hidden="true"
								/>
								{{ t('compass.reader.startWriting') }}
							</RouterLink>
						</div>

						<footer class="compass-reader__footer">
							<p class="compass-reader__dates">
								<i18n-t
									v-if="entry.created && entry.updated && entry.updated !== entry.created"
									keypath="compass.reader.written"
									tag="span"
									scope="global"
								>
									<template #created>
										<time
											:datetime="formatISO(entry.created)"
											:title="formatDateLong(entry.created)"
										>
											<span class="d-print-none">{{ formatDisplayDate(entry.created) }}</span>
											<span class="compass-reader__print-date">{{ formatDateLong(entry.created) }}</span>
										</time>
									</template>
									<template #updated>
										<time
											:datetime="formatISO(entry.updated)"
											:title="formatDateLong(entry.updated)"
										>
											<span class="d-print-none">{{ formatDisplayDate(entry.updated) }}</span>
											<span class="compass-reader__print-date">{{ formatDateLong(entry.updated) }}</span>
										</time>
									</template>
								</i18n-t>
								<i18n-t
									v-else-if="entry.created"
									keypath="compass.reader.writtenOnly"
									tag="span"
									scope="global"
								>
									<template #created>
										<time
											:datetime="formatISO(entry.created)"
											:title="formatDateLong(entry.created)"
										>
											<span class="d-print-none">{{ formatDisplayDate(entry.created) }}</span>
											<span class="compass-reader__print-date">{{ formatDateLong(entry.created) }}</span>
										</time>
									</template>
								</i18n-t>
							</p>
							<RouterLink
								class="compass-reader__history d-print-none"
								:to="{name: 'compass.entry.history', params: {entryId: entry.id}}"
							>
								<Icon
									icon="history"
									aria-hidden="true"
								/>
								{{ t('compass.history.title') }}
							</RouterLink>
						</footer>
					</article>
				</div>

				<div
					v-if="isWide"
					class="compass-reader__rail"
				>
					<CompassToc
						v-if="hasBody"
						layout="rail"
						:headings="prepared.headings"
					/>
				</div>
			</div>
		</template>

		<div
			v-else-if="notFound"
			class="compass-reader__state"
		>
			<CompassGlyph
				kind="guide"
				class="compass-reader__state-glyph"
			/>
			<h1 class="compass-reader__state-title">
				{{ t('compass.reader.notFound') }}
			</h1>
			<p class="compass-reader__state-text">
				{{ t('compass.reader.notFoundHint') }}
			</p>
			<RouterLink
				class="compass-reader__state-link"
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
			class="compass-reader__state"
			role="alert"
		>
			<h1 class="compass-reader__state-title">
				{{ t('compass.reader.loadFailed') }}
			</h1>
			<p
				v-if="failure === 'network'"
				class="compass-reader__state-text"
			>
				{{ t('compass.reader.offline') }}
			</p>
			<XButton
				variant="secondary"
				:shadow="false"
				icon="undo"
				:loading="isFetching"
				:aria-disabled="isFetching"
				@click="retry"
			>
				{{ t('misc.retry') }}
			</XButton>
		</div>

		<div
			v-else
			class="compass-reader__skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ t('misc.loading') }}</span>
			<div aria-hidden="true">
				<span class="compass-reader__skeleton-kicker" />
				<span class="compass-reader__skeleton-title" />
				<span
					v-for="line in 6"
					:key="line"
					class="compass-reader__skeleton-line"
				/>
			</div>
		</div>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed, useId, useTemplateRef} from 'vue'
import {useI18n} from 'vue-i18n'
import type {RouteLocationRaw} from 'vue-router'
import {useElementSize} from '@vueuse/core'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassKindLabel from '@/components/compass/base/CompassKindLabel.vue'
import CompassProse from '@/components/compass/base/CompassProse.vue'
import CompassStateBadge from '@/components/compass/base/CompassStateBadge.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassEntryActions from '@/components/compass/reader/CompassEntryActions.vue'
import CompassEntryStateBanner from '@/components/compass/reader/CompassEntryStateBanner.vue'
import CompassReadingProgress from '@/components/compass/reader/CompassReadingProgress.vue'
import CompassToc from '@/components/compass/reader/CompassToc.vue'
import {provideCompassEntryCommands} from '@/components/compass/reader/useCompassEntryCommands'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import Message from '@/components/misc/Message.vue'
import {canWriteCompass} from '@/client/queries/compass'
import {
	useCompassEntry,
	useCompassPeople,
	useCompassSpace,
} from '@/composables/useCompass'
import {useCompassReadingPrefs} from '@/composables/useCompassReadingPrefs'
import {useTitle} from '@/composables/useTitle'
import {resolveCompassTheme} from '@/helpers/compass/constants'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {
	DEFAULT_COMPASS_LIBRARY_STATE,
	compassLibraryStateToQuery,
	withCompassLibraryChange,
} from '@/helpers/compass/libraryQuery'
import {
	compassPlainText,
	estimateCompassReadingMinutes,
	prepareCompassHtml,
} from '@/helpers/compass/readerHtml'
import {
	formatDateLong,
	formatDisplayDate,
	formatISO,
} from '@/helpers/time/formatDate'

const props = defineProps<{
	entryId: number
}>()

const {t} = useI18n({useScope: 'global'})

const {
	entry,
	error,
	isError,
	isFetching,
	refetch,
} = useCompassEntry(() => props.entryId)
const {space} = useCompassSpace(() => entry.value?.space_id ?? 0)
const {personName} = useCompassPeople(space)
const {prefs, setPrefs} = useCompassReadingPrefs()

useTitle(() => entry.value?.title || t('compass.title'))

const theme = computed(() => resolveCompassTheme(entry.value?.theme, space.value?.theme))
const spaceTitle = computed(() => space.value?.title || t('compass.title'))
const titleId = useId()

const failure = computed(() => isError.value ? classifyCompassFailure(error.value) : null)
const notFound = computed(() => props.entryId <= 0 || failure.value === 'missing' || failure.value === 'forbidden')
// An aborted read belongs to an account that is gone; the next one is already on its way.
const loadFailed = computed(() => failure.value !== null && failure.value !== 'aborted')
const staleFailure = computed(() => entry.value !== undefined && loadFailed.value)

function retry() {
	if (isFetching.value) return
	refetch()
}

// Keyed on the text itself, so a refetch that brings the same body does not re-sanitize megabytes.
const content = computed(() => entry.value?.content ?? '')
const prepared = computed(() => prepareCompassHtml(content.value))
const plainText = computed(() => compassPlainText(content.value))
// An entry of pictures alone still has a body to show.
const hasBody = computed(() => prepared.value.images.length > 0 || plainText.value.trim() !== '')
const readingMinutes = computed(() => estimateCompassReadingMinutes(plainText.value))
const quote = computed(() => entry.value?.quote.trim() ?? '')

const canEdit = computed(() => canWriteCompass(entry.value) && entry.value?.state !== 'trashed')
// In a personal space every version is the owner's; only shared spaces say who saved.
const updatedBy = computed(() => (space.value?.team_id ?? 0) > 0 && entry.value
	? personName(entry.value.updated_by_id)
	: '')

function libraryLink(change: {
	tag?: string
	category?: string
}): RouteLocationRaw {
	return {
		name: 'compass.space',
		params: {spaceId: entry.value?.space_id ?? 0},
		query: compassLibraryStateToQuery(withCompassLibraryChange(DEFAULT_COMPASS_LIBRARY_STATE, change)),
	}
}

const article = useTemplateRef<HTMLElement>('article')
const title = useTemplateRef<HTMLElement>('title')
const layout = useTemplateRef<HTMLElement>('layout')

provideCompassEntryCommands(entry, () => title.value?.focus())

// The rail needs room beside a full measure; measured on the page itself, since the sidebar takes its share.
const WIDE_LAYOUT_REM = 54
const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
const {width: layoutWidth} = useElementSize(layout)
const isWide = computed(() => layoutWidth.value >= WIDE_LAYOUT_REM * rootFontSize)
</script>

<style lang="scss" scoped>
.compass-reader__print-date {
	display: none;

	@media print {
		display: inline;
	}
}

.compass-reader {
	max-inline-size: var(--page-max-width);
	margin-inline: auto;
	padding-block-end: var(--space-10);
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

.compass-reader__bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-4);
	margin-block-end: var(--space-8);
	padding-block-end: var(--space-3);
	border-block-end: 1px solid var(--compass-rule);
}

.compass-reader__back {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	max-inline-size: 100%;
	min-block-size: max(var(--control-height), var(--target-min));
	padding-inline-end: var(--space-2);
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

.compass-reader__back-icon {
	flex: none;

	[dir='rtl'] & {
		transform: scaleX(-1);
	}
}

.compass-reader__back-text {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

// ---------------------------------------------------------------------------
// Layout: one column, plus a contents rail once there is room for it beside a full measure
// ---------------------------------------------------------------------------

.compass-reader__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);

	&.is-wide {
		grid-template-columns: minmax(0, 1fr) minmax(0, var(--compass-measure)) minmax(11rem, 1fr);
		column-gap: var(--space-8);

		.compass-reader__main {
			grid-row: 1;
			grid-column: 2;
		}
	}
}

.compass-reader__main {
	inline-size: 100%;
	max-inline-size: var(--compass-measure);
	min-inline-size: 0;
	margin-inline: auto;
}

.compass-reader__rail {
	grid-row: 1;
	grid-column: 3;
	min-inline-size: 0;
	max-inline-size: 16rem;
	padding-block-start: var(--space-2);
}

.compass-reader__notice {
	margin-block-end: var(--space-6);
}

.compass-reader__stale {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
}

// ---------------------------------------------------------------------------
// Article header
// ---------------------------------------------------------------------------

// Dots drawn, not typed: a separator character would be read aloud between every item.
// stylelint-disable-next-line at-rule-no-unknown -- Sass mixin shared by the article metadata rows.
@mixin dotted-sequence {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);

	> :deep(* + *:not(.compass-state-badge))::before {
		content: '';
		display: inline-block;
		inline-size: 3px;
		block-size: 3px;
		margin-inline-end: var(--space-3);
		border-radius: var(--radius-full);
		background: currentColor;
		opacity: .55;
		vertical-align: middle;
	}
}

.compass-reader__kicker {
	@include dotted-sequence;

	margin: 0 0 var(--space-4);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-reader__kicker-item {
	display: inline-flex;
	align-items: center;
	gap: .35em;
}

.compass-reader__category {
	color: var(--compass-ink-soft);
	font-weight: var(--weight-medium);
	text-decoration: none;

	&:hover {
		color: var(--compass-accent);
		text-decoration: underline;
		text-underline-offset: .2em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-reader__pinned {
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
}

.compass-reader__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.9rem, 3.6vw, 2.75rem);
	font-weight: 600;
	line-height: 1.2;
	letter-spacing: -.005em;
	text-wrap: balance;
	overflow-wrap: break-word;

	// Focus lands here only by script (after a banner's button disappears); the page is the context.
	&:focus {
		outline: none;
	}
}

.compass-reader__subtitle {
	margin: var(--space-3) 0 0;
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	line-height: 1.55;
	text-wrap: pretty;
}

// The epigraph: the line the whole entry stands behind.
.compass-reader__epigraph {
	position: relative;
	margin: var(--space-8) 0 var(--space-6);
	padding-block: .15em;
	padding-inline: 1.25em 0;
	border-inline-start: 2px solid var(--compass-accent);
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.35rem;
	line-height: 1.75;
	letter-spacing: .01em;
	white-space: pre-line;
	text-wrap: pretty;
	hanging-punctuation: first;

	// A small star caps the rule, the way a guide star tops a meridian.
	&::before {
		content: '';
		position: absolute;
		inset-block-start: -4px;
		inset-inline-start: -4px;
		inline-size: 6px;
		block-size: 6px;
		background: var(--compass-accent);
		transform: rotate(45deg);
	}

	@include mobile {
		font-size: 1.2rem;
		padding-inline-start: 1em;
	}
}

.compass-reader__meta {
	@include dotted-sequence;

	margin: var(--space-5) 0 0;
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.compass-reader__tags {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-3) 0 0;
	padding: 0;
	list-style: none;
}

.compass-reader__tag {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-size: var(--text-sm);
	text-decoration: none;
	overflow-wrap: anywhere;

	&:hover {
		text-decoration: underline;
		text-underline-offset: .2em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

// ---------------------------------------------------------------------------
// Ornament, body, empty state, footer
// ---------------------------------------------------------------------------

.compass-reader__ornament {
	--compass-glyph-size: .85rem;

	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-3);
	margin-block: var(--space-8);
	color: var(--compass-accent);

	&::before,
	&::after {
		content: '';
		inline-size: 3.5rem;
		block-size: 1px;
		background: var(--compass-rule-strong);
	}

	.is-side {
		--compass-glyph-size: .5rem;

		opacity: .7;
	}
}

.compass-reader__body {
	// Headings get focus from the contents; they are targets, not controls.
	:deep(:where(h1, h2, h3, h4)[tabindex='-1']:focus) {
		outline: none;
	}
}

.compass-reader__empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	padding-block: var(--space-6);
	color: var(--compass-ink-faint);
	font-family: var(--compass-serif);
	font-size: 1.1rem;
	text-align: center;

	p {
		margin: 0;
	}
}

.compass-reader__empty-link,
.compass-reader__history,
.compass-reader__state-link {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-family: var(--compass-sans);
	font-size: var(--text-md);
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

.compass-reader__footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-4);
	margin-block-start: var(--space-10);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--compass-rule);
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
}

.compass-reader__dates {
	margin: 0;
}

.compass-reader__history {
	font-size: var(--text-sm);
}

// ---------------------------------------------------------------------------
// Not found, failure, first load
// ---------------------------------------------------------------------------

.compass-reader__state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	max-inline-size: var(--compass-measure);
	margin: var(--space-10) auto 0;
	text-align: center;
}

.compass-reader__state-glyph {
	--compass-glyph-size: 1.5rem;
}

.compass-reader__state-title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-2xl);
	font-weight: 600;
	line-height: 1.3;
	text-wrap: balance;
}

.compass-reader__state-text {
	margin: 0;
	color: var(--compass-ink-soft);
}

.compass-reader__skeleton {
	max-inline-size: var(--compass-measure);
	margin: var(--space-10) auto 0;

	> div {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	> div > span {
		display: block;
		border-radius: var(--radius-xs);
		background: var(--surface-active);
	}
}

.compass-reader__skeleton-kicker {
	inline-size: 9rem;
	block-size: .75rem;
}

.compass-reader__skeleton-title {
	inline-size: 72%;
	block-size: 2.25rem;
	margin-block: var(--space-2) var(--space-6);
}

.compass-reader__skeleton-line {
	inline-size: 100%;
	block-size: .9rem;

	&:nth-child(3n) {
		inline-size: 92%;
	}

	&:last-child {
		inline-size: 58%;
	}
}

// ---------------------------------------------------------------------------
// Print: the article alone, black serif on white
// ---------------------------------------------------------------------------

@media print {
	// The app shell reserves room for its fixed header, which does not print.
	:global(.app-content:has(.compass-reader)) {
		padding: 0 !important;
	}

	.compass-reader {
		max-inline-size: none;
		padding: 0;
		color: #000000;
		background: #ffffff;
	}

	.compass-reader__layout,
	.compass-reader__layout.is-wide {
		display: block;
	}

	.compass-reader__main {
		max-inline-size: none;
	}

	.compass-reader__kicker,
	.compass-reader__meta,
	.compass-reader__footer {
		color: #333333;
	}

	.compass-reader__category,
	.compass-reader__pinned,
	.compass-reader__tag {
		color: #000000;
		text-decoration: none;
	}

	.compass-reader__title {
		color: #000000;
		font-size: 24pt;
		break-after: avoid;
	}

	.compass-reader__subtitle {
		color: #222222;
		font-size: 13pt;
		break-after: avoid;
	}

	.compass-reader__epigraph {
		border-inline-start-color: #555555;
		color: #000000;
		font-size: 13.5pt;
		break-inside: avoid;
	}

	.compass-reader__ornament {
		margin-block: 14pt;
		color: #555555;
	}

	.compass-reader__body.compass-prose--sans {
		font-family: var(--compass-serif);
	}

	.compass-reader__footer {
		border-block-start-color: #999999;
	}
}
</style>
