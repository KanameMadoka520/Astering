<template>
	<div class="compass-topic-lists">
		<section
			v-if="categories.length > 0"
			class="compass-topic-lists__group"
			:aria-labelledby="`${id}-categories`"
		>
			<h3
				:id="`${id}-categories`"
				class="compass-topic-lists__heading"
			>
				{{ t('compass.topics.categories') }}
			</h3>
			<ul class="compass-topic-lists__categories">
				<li
					v-for="category in shownCategories"
					:key="category.name"
				>
					<button
						type="button"
						class="compass-topic-lists__category"
						:aria-pressed="category.name === selectedCategory"
						@click="emit('toggleCategory', category.name)"
					>
						<span class="compass-topic-lists__name">{{ category.name }}</span>
						<span
							class="compass-topic-lists__count"
							aria-hidden="true"
						>{{ category.count }}</span>
						<span class="is-sr-only">{{ countLabel(category.count) }}</span>
					</button>
				</li>
			</ul>
			<button
				v-if="categories.length > CATEGORY_LIMIT"
				type="button"
				class="compass-topic-lists__more"
				:aria-expanded="allCategories"
				@click="allCategories = !allCategories"
			>
				{{ moreLabel(allCategories, categories.length) }}
			</button>
		</section>

		<section
			v-if="tags.length > 0"
			class="compass-topic-lists__group"
			:aria-labelledby="`${id}-tags`"
		>
			<h3
				:id="`${id}-tags`"
				class="compass-topic-lists__heading"
			>
				{{ t('compass.topics.tags') }}
			</h3>
			<ul class="compass-topic-lists__tags">
				<li
					v-for="tag in shownTags"
					:key="tag.name"
				>
					<button
						type="button"
						class="compass-topic-lists__tag"
						:aria-pressed="tag.name === selectedTag"
						@click="emit('toggleTag', tag.name)"
					>
						<span class="compass-topic-lists__name">#{{ tag.name }}</span>
						<span
							class="compass-topic-lists__count"
							aria-hidden="true"
						>{{ tag.count }}</span>
						<span class="is-sr-only">{{ countLabel(tag.count) }}</span>
					</button>
				</li>
			</ul>
			<button
				v-if="tags.length > TAG_LIMIT"
				type="button"
				class="compass-topic-lists__more"
				:aria-expanded="allTags"
				@click="allTags = !allTags"
			>
				{{ moreLabel(allTags, tags.length) }}
			</button>
		</section>
	</div>
</template>

<script setup lang="ts">
import {computed, ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import type {CompassTopic} from '@/client/queries/compass'

const props = defineProps<{
	categories: CompassTopic[]
	tags: CompassTopic[]
	selectedCategory: string
	selectedTag: string
}>()

const emit = defineEmits<{
	toggleCategory: [name: string]
	toggleTag: [name: string]
}>()

// A long-lived library collects many topics; the rail shows the most used first and folds the rest.
const CATEGORY_LIMIT = 12
const TAG_LIMIT = 20

const {t} = useI18n({useScope: 'global'})
const id = useId()

const allCategories = ref(false)
const allTags = ref(false)

// Most used first, so the fold keeps what matters; the chosen one stays visible even past the fold.
function visible(list: CompassTopic[], limit: number, showAll: boolean, selected: string): CompassTopic[] {
	const sorted = [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	if (showAll || sorted.length <= limit) return sorted
	const head = sorted.slice(0, limit)
	const chosen = sorted.find(topic => topic.name === selected)
	return chosen && !head.includes(chosen) ? [...head, chosen] : head
}

const shownCategories = computed(() => visible(
	props.categories,
	CATEGORY_LIMIT,
	allCategories.value,
	props.selectedCategory,
))
const shownTags = computed(() => visible(
	props.tags,
	TAG_LIMIT,
	allTags.value,
	props.selectedTag,
))

function countLabel(count: number): string {
	return t('compass.topics.count', {n: count}, count)
}

function moreLabel(showingAll: boolean, count: number): string {
	return showingAll ? t('compass.topics.showFewer') : t('compass.topics.showAll', {n: count})
}
</script>

<style lang="scss" scoped>
.compass-topic-lists {
	display: flex;
	flex-direction: column;
	gap: var(--space-5);
}

.compass-topic-lists__group {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-2);
}

.compass-topic-lists__heading {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .06em;
	text-transform: uppercase;
}

.compass-topic-lists__categories {
	display: flex;
	flex-direction: column;
	align-self: stretch;
	gap: 1px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-topic-lists__tags {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-topic-lists__category,
.compass-topic-lists__tag {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 2rem;
	border: 1px solid transparent;
	background: none;
	color: var(--compass-ink);
	font: inherit;
	font-size: var(--text-md);
	text-align: start;
	cursor: pointer;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}

	&[aria-pressed='true'] {
		border-color: var(--compass-accent);
		background-color: var(--compass-accent-tint);
		color: var(--compass-accent);
		font-weight: var(--weight-semibold);
	}

	@media (pointer: coarse) {
		min-block-size: var(--target-min);
	}
}

.compass-topic-lists__category {
	inline-size: 100%;
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);

	.compass-topic-lists__count {
		margin-inline-start: auto;
	}
}

.compass-topic-lists__tag {
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-full);
	font-size: var(--text-sm);
}

.compass-topic-lists__name {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-topic-lists__count {
	flex: none;
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	[aria-pressed='true'] > & {
		color: inherit;
	}
}

.compass-topic-lists__more {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	padding: 0 var(--space-2);
	border: 0;
	background: none;
	color: var(--compass-accent);
	font: inherit;
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
		text-underline-offset: .22em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}
</style>
