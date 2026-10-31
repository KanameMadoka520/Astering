<template>
	<section
		v-if="lights.length > 0"
		class="compass-lights"
		aria-labelledby="compass-lights-title"
	>
		<header class="compass-lights__header">
			<h2
				id="compass-lights-title"
				class="compass-lights__title"
			>
				{{ t('compass.lights.title') }}
			</h2>
			<p class="compass-lights__description">
				{{ t('compass.lights.description') }}
			</p>
		</header>

		<ol class="compass-lights__list">
			<li
				v-for="light in lights"
				:key="light.id"
				class="compass-lights__item"
			>
				<RouterLink
					class="compass-lights__link"
					:to="{name: 'compass.entry', params: {entryId: light.id}}"
				>
					<span class="compass-lights__meta">
						<CompassGlyph
							kind="guide"
							class="compass-lights__guide"
						/>
						<CompassKindLabel :kind="light.kind" />
						<template v-if="light.category">
							<span
								class="compass-lights__dot"
								aria-hidden="true"
							>·</span>
							<span class="compass-lights__category">{{ light.category }}</span>
						</template>
					</span>
					<span
						v-if="lineFor(light)"
						class="compass-lights__line"
					>{{ lineFor(light) }}</span>
					<span
						class="compass-lights__name"
						:class="{'is-main': !lineFor(light)}"
					>{{ light.title }}</span>
				</RouterLink>
			</li>
		</ol>

		<RouterLink
			v-if="total > lights.length"
			class="compass-lights__all d-print-none"
			:to="allLightsLocation"
		>
			{{ t('compass.lights.seeAll', {n: total}) }}
		</RouterLink>
	</section>

	<section
		v-else-if="failed && space.pinned_count > 0"
		class="compass-lights"
		aria-labelledby="compass-lights-title"
	>
		<h2
			id="compass-lights-title"
			class="compass-lights__title"
		>
			{{ t('compass.lights.title') }}
		</h2>
		<LoadError :retry="() => refetch()" />
	</section>

	<p
		v-else-if="showHint"
		class="compass-lights-hint d-print-none"
	>
		<CompassGlyph
			kind="guide"
			class="compass-lights__guide"
		/>
		{{ t('compass.lights.hint') }}
	</p>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {RouteLocationRaw} from 'vue-router'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassKindLabel from '@/components/compass/base/CompassKindLabel.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {
	canWriteCompass,
	type CompassEntryFilters,
	type CompassEntrySummary,
	type CompassSpace,
} from '@/client/queries/compass'
import {useCompassEntries} from '@/composables/useCompass'
import {
	compassLibraryStateToQuery,
	DEFAULT_COMPASS_LIBRARY_STATE,
} from '@/helpers/compass/libraryQuery'

const props = defineProps<{
	space: CompassSpace
}>()

const MAX_LIGHTS = 6
// Same filters the library sends for "pinned only", so both share one cached page.
const PINNED: CompassEntryFilters = {pinned: true}

const {t} = useI18n({useScope: 'global'})
const {data, entries, total, isError, refetch} = useCompassEntries(() => props.space.id, PINNED, 1)

const lights = computed(() => entries.value.slice(0, MAX_LIGHTS))
const failed = computed(() => isError.value && data.value === undefined)
const showHint = computed(() => data.value !== undefined &&
	props.space.entry_count > 0 &&
	canWriteCompass(props.space))

const allLightsLocation = computed<RouteLocationRaw>(() => ({
	name: 'compass.space',
	params: {spaceId: props.space.id},
	query: compassLibraryStateToQuery({
		...DEFAULT_COMPASS_LIBRARY_STATE,
		pinned: true,
	}),
	hash: '#compass-library',
}))

// A light speaks with its epigraph first; the title follows in small type.
function lineFor(entry: CompassEntrySummary): string {
	return entry.quote.trim() || entry.subtitle.trim() || entry.excerpt.trim()
}
</script>

<style lang="scss" scoped>
.compass-lights {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
}

.compass-lights__header {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-4);
}

.compass-lights__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-xl);
	font-weight: 600;
}

.compass-lights__description {
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-lights__list {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(16rem, 100%), 1fr));
	gap: var(--space-2) var(--space-6);
	margin: 0;
	padding: 0;
	list-style: none;

	@media screen and (max-width: $tablet - 1px) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.compass-lights__item {
	display: flex;
	min-inline-size: 0;
	border-block-start: 1px solid var(--compass-accent);
}

.compass-lights__link {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-4) var(--space-2) var(--space-5);
	border-end-start-radius: var(--radius-sm);
	border-end-end-radius: var(--radius-sm);
	color: inherit;
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-lights__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-lights__guide {
	--compass-glyph-size: .875rem;
}

.compass-lights__dot {
	color: var(--compass-ink-faint);
}

.compass-lights__category {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-lights__line {
	display: -webkit-box;
	overflow: hidden;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	line-height: 1.55;
	white-space: pre-line;
	overflow-wrap: anywhere;
	-webkit-line-clamp: 5;
	-webkit-box-orient: vertical;
}

.compass-lights__name {
	margin-block-start: auto;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;

	&.is-main {
		margin-block-start: 0;
		color: var(--compass-ink);
		font-family: var(--compass-serif);
		font-size: 1.2rem;
		line-height: 1.45;
	}
}

.compass-lights__all {
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: .22em;

	&:hover {
		text-decoration-thickness: 2px;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-lights-hint {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-md);
}

@media print {
	.compass-lights__item {
		break-inside: avoid;
	}
}
</style>
