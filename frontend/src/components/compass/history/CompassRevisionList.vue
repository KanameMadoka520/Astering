<template>
	<div
		class="compass-revisions"
		:aria-busy="refreshing || undefined"
	>
		<div
			v-if="loading"
			class="compass-revisions__skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ t('misc.loading') }}</span>
			<span
				v-for="row in 5"
				:key="row"
				class="compass-revisions__skeleton-row"
				aria-hidden="true"
			>
				<span />
				<span />
			</span>
		</div>

		<LoadError
			v-else-if="failed"
			:message="t('compass.history.listFailed')"
			:retry="retry"
		/>

		<p
			v-else-if="revisions.length === 0"
			class="compass-revisions__state"
		>
			{{ t('compass.history.listEmpty') }}
		</p>

		<template v-else>
			<ol class="compass-revisions__list">
				<li
					v-for="item in revisions"
					:key="item.revision"
				>
					<!-- Explicit aria-current: RouterLink ignores the query and would mark every version current. -->
					<RouterLink
						class="compass-revision"
						:class="{'is-selected': item.revision === selected}"
						:to="linkFor(item.revision)"
						:aria-current="item.revision === selected ? 'true' : 'false'"
					>
						<span class="compass-revision__head">
							<CompassGlyph
								class="compass-revision__glyph"
								:kind="item.kind"
							/>
							<span class="is-sr-only">{{ t(`compass.kind.${item.kind}`) }}</span>
							<span class="compass-revision__number">
								{{ t('compass.history.version', {revision: item.revision}) }}
							</span>
							<span
								v-if="item.revision === currentRevision"
								class="compass-revision__current"
							>
								{{ t('compass.history.current') }}
							</span>
							<CompassStateBadge :state="item.state" />
						</span>
						<span
							v-if="item.title !== currentTitle"
							class="compass-revision__title"
						>
							{{ t('compass.history.titleThen', {title: item.title}) }}
						</span>
						<span class="compass-revision__meta">
							<time
								v-if="item.created"
								:datetime="formatISO(item.created)"
								:title="formatDateLong(item.created)"
							>{{ formatDisplayDate(item.created) }}</time>
							<span v-if="personName(item.updated_by_id)">
								{{ t('compass.history.by', {person: personName(item.updated_by_id)}) }}
							</span>
							<span>{{ sizeOf(item.content_bytes) }}</span>
						</span>
					</RouterLink>
				</li>
			</ol>
			<Pagination
				class="compass-revisions__pagination"
				:total-pages="totalPages"
				:current-page="page"
			/>
		</template>
	</div>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {RouteLocationRaw} from 'vue-router'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassStateBadge from '@/components/compass/base/CompassStateBadge.vue'
import Pagination from '@/components/misc/Pagination.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {CompassRevisionSummary} from '@/client/queries/compass'
import {
	formatDateLong,
	formatDisplayDate,
	formatISO,
} from '@/helpers/time/formatDate'

const props = defineProps<{
	entryId: number
	revisions: CompassRevisionSummary[]
	// The entry's revision and title now, to mark the current version and older titles.
	currentRevision: number
	currentTitle: string
	selected: number
	page: number
	totalPages: number
	personName: (userId: number) => string
	// Nothing to show yet.
	loading: boolean
	// The read failed and there is no earlier page to keep showing.
	failed: boolean
	refreshing: boolean
}>()

const emit = defineEmits<{
	retry: []
}>()

const {t, locale} = useI18n({useScope: 'global'})

const kibFormat = computed(() => new Intl.NumberFormat(locale.value, {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
}))

function sizeOf(bytes: number): string {
	return t('compass.history.size', {size: kibFormat.value.format(bytes / 1024)})
}

function linkFor(revision: number): RouteLocationRaw {
	return {
		name: 'compass.entry.history',
		params: {entryId: props.entryId},
		query: props.page > 1
			? {
				revision,
				page: props.page,
			}
			: {revision},
	}
}

function retry() {
	if (props.refreshing) return
	emit('retry')
}
</script>

<style lang="scss" scoped>
.compass-revisions {
	transition: opacity var(--motion-fast) var(--ease-standard);

	&[aria-busy='true'] {
		opacity: .7;
	}
}

.compass-revisions__list {
	display: flex;
	flex-direction: column;
	gap: 1px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-revision {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 2px solid transparent;
	border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	color: var(--compass-ink);
	text-decoration: none;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	[dir='rtl'] & {
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}

	&:hover {
		background-color: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}

	// The marker and weight carry the selection; the tint is only a second cue.
	&.is-selected {
		border-inline-start-color: var(--compass-accent);
		background-color: var(--compass-accent-tint);

		.compass-revision__number {
			font-weight: var(--weight-bold);
		}
	}
}

.compass-revision__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
}

.compass-revision__glyph {
	--compass-glyph-size: 1rem;
}

.compass-revision__number {
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	font-variant-numeric: tabular-nums;
}

.compass-revision__current {
	padding: .05rem var(--space-2);
	border: 1px solid var(--compass-accent);
	border-radius: var(--radius-full);
	color: var(--compass-accent);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

.compass-revision__title {
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: var(--text-md);
	line-height: 1.45;
	overflow-wrap: anywhere;
}

.compass-revision__meta {
	display: flex;
	flex-wrap: wrap;
	gap: 0 var(--space-3);
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.compass-revisions__pagination {
	margin-block-start: var(--space-3);
}

.compass-revisions__state {
	margin: 0;
	padding: var(--space-4) var(--space-3);
	color: var(--compass-ink-soft);
}

.compass-revisions__skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	padding: var(--space-2) var(--space-3);
}

.compass-revisions__skeleton-row {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);

	> span {
		display: block;
		block-size: .8rem;
		border-radius: var(--radius-xs);
		background: var(--surface-active);
	}

	> span:first-child {
		inline-size: 45%;
	}

	> span:last-child {
		inline-size: 75%;
		block-size: .6rem;
	}
}
</style>
