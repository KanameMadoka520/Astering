<template>
	<li
		class="compass-entry-row"
		:class="{
			'has-actions': canRestore || canDelete,
			'is-trashed': entry.state === 'trashed',
		}"
	>
		<RouterLink
			:id="`compass-entry-row-${entry.id}`"
			class="compass-entry-row__link"
			:to="{name: 'compass.entry', params: {entryId: entry.id}}"
		>
			<span class="compass-entry-row__meta">
				<CompassKindLabel :kind="entry.kind" />
				<template v-if="entry.category">
					<span
						class="compass-entry-row__dot"
						aria-hidden="true"
					>·</span>
					<span class="compass-entry-row__category">{{ entry.category }}</span>
				</template>
				<span
					v-if="entry.pinned"
					class="compass-entry-row__guide"
				>
					<CompassGlyph
						kind="guide"
						class="compass-entry-row__guide-glyph"
					/>
					{{ t('compass.row.guide') }}
				</span>
				<CompassStateBadge :state="entry.state" />
				<span
					v-if="date"
					class="compass-entry-row__date"
				>
					<span class="is-sr-only">{{ dateLabel }}</span>
					<time
						:datetime="date"
						:title="formatDateLong(date)"
					>{{ formatDisplayDate(date) }}</time>
				</span>
			</span>
			<span class="compass-entry-row__title">
				<CompassHighlight
					:text="entry.title"
					:term="term"
				/>
			</span>
			<span
				v-if="summary"
				class="compass-entry-row__summary"
			>
				<CompassHighlight
					:text="summary"
					:term="term"
				/>
			</span>
			<span
				v-if="entry.tags.length > 0"
				class="compass-entry-row__tags"
			>
				<span
					v-for="tag in shownTags"
					:key="tag"
					class="compass-entry-row__tag"
				>#{{ tag }}</span>
				<span
					v-if="hiddenTags > 0"
					class="compass-entry-row__tag"
				>{{ t('compass.row.moreTags', {n: hiddenTags}) }}</span>
			</span>
		</RouterLink>

		<div
			v-if="canRestore || canDelete"
			class="compass-entry-row__actions"
		>
			<XButton
				v-if="canRestore"
				variant="secondary"
				icon="undo"
				class="is-small"
				:shadow="false"
				:loading="restoring"
				:aria-label="t('compass.row.restoreLabel', {title: entry.title})"
				@click="requestRestore"
			>
				{{ t('compass.row.restore') }}
			</XButton>
			<XButton
				v-if="canDelete"
				variant="tertiary"
				icon="trash-alt"
				class="is-small"
				danger
				:aria-label="t('compass.row.deleteLabel', {title: entry.title})"
				@click="emit('delete', entry)"
			>
				{{ t('compass.delete.title') }}
			</XButton>
		</div>
	</li>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassKindLabel from '@/components/compass/base/CompassKindLabel.vue'
import CompassStateBadge from '@/components/compass/base/CompassStateBadge.vue'
import XButton from '@/components/input/Button.vue'
import CompassHighlight from './CompassHighlight.vue'
import {
	canAdminCompass,
	canWriteCompass,
	type CompassEntrySummary,
} from '@/client/queries/compass'
import {formatDateLong, formatDisplayDate} from '@/helpers/time/formatDate'

const props = withDefaults(defineProps<{
	entry: CompassEntrySummary
	// The library search, marked in the title and summary.
	term?: string
	dateField?: 'updated' | 'created'
	restoring?: boolean
}>(), {
	term: '',
	dateField: 'updated',
	restoring: false,
})

const emit = defineEmits<{
	restore: [entry: CompassEntrySummary]
	delete: [entry: CompassEntrySummary]
}>()

const MAX_TAGS = 6

const {t} = useI18n({useScope: 'global'})

const date = computed(() => props.entry[props.dateField])
const dateLabel = computed(() => props.dateField === 'created' ? t('compass.row.created') : t('compass.row.updated'))
const summary = computed(() => props.entry.subtitle.trim() || props.entry.excerpt.trim())
const shownTags = computed(() => props.entry.tags.slice(0, MAX_TAGS))
const hiddenTags = computed(() => Math.max(0, props.entry.tags.length - MAX_TAGS))

const canRestore = computed(() => props.entry.state !== 'active' && canWriteCompass(props.entry))
const canDelete = computed(() => props.entry.state === 'trashed' && canAdminCompass(props.entry))

function requestRestore() {
	if (props.restoring) return
	emit('restore', props.entry)
}
</script>

<style lang="scss" scoped>
.compass-entry-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	align-items: center;
	gap: 0 var(--space-4);
	border-block-end: 1px solid var(--compass-rule);

	&.has-actions {
		@media screen and (min-width: $tablet) {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
}

.compass-entry-row__link {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
	padding: var(--space-4) var(--space-3);
	border-radius: var(--radius-sm);
	color: inherit;
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;

		outline-offset: -2px;
	}

	@media screen and (max-width: $tablet - 1px) {
		padding-inline: var(--space-1);
	}
}

.compass-entry-row__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-entry-row__dot {
	color: var(--compass-ink-faint);
}

.compass-entry-row__category {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-entry-row__guide {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
}

.compass-entry-row__guide-glyph {
	--compass-glyph-size: .8rem;
}

.compass-entry-row__date {
	margin-inline-start: auto;
	color: var(--compass-ink-faint);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.compass-entry-row__title {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	font-weight: 600;
	line-height: 1.35;
	overflow-wrap: anywhere;

	.is-trashed & {
		color: var(--compass-ink-soft);
	}
}

.compass-entry-row__summary {
	display: -webkit-box;
	max-inline-size: 48rem;
	overflow: hidden;
	color: var(--compass-ink-soft);
	line-height: 1.6;
	overflow-wrap: anywhere;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.compass-entry-row__tags {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
}

.compass-entry-row__tag {
	overflow-wrap: anywhere;
}

.compass-entry-row__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: 0 var(--space-3) var(--space-4);

	@media screen and (min-width: $tablet) {
		justify-content: flex-end;
		padding: var(--space-3);
	}

	@media screen and (max-width: $tablet - 1px) {
		padding-inline: var(--space-1);
	}
}
</style>
