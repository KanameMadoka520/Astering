<template>
	<details
		v-if="layout === 'disclosure'"
		class="compass-topics compass-topics--disclosure"
		:open="open"
		@toggle="open = ($event.target as HTMLDetailsElement).open"
	>
		<summary class="compass-topics__summary">
			<span>{{ t('compass.topics.summary') }}</span>
			<span
				v-if="selectionLabel"
				class="compass-topics__selection"
			>{{ selectionLabel }}</span>
			<Icon
				icon="chevron-down"
				class="compass-topics__chevron"
			/>
		</summary>
		<div class="compass-topics__body">
			<CompassTopicLists
				:categories="categories"
				:tags="tags"
				:selected-category="selectedCategory"
				:selected-tag="selectedTag"
				@toggleCategory="emit('toggleCategory', $event)"
				@toggleTag="emit('toggleTag', $event)"
			/>
		</div>
	</details>

	<aside
		v-else
		class="compass-topics compass-topics--rail"
		:aria-label="t('compass.topics.summary')"
	>
		<CompassTopicLists
			:categories="categories"
			:tags="tags"
			:selected-category="selectedCategory"
			:selected-tag="selectedTag"
			@toggleCategory="emit('toggleCategory', $event)"
			@toggleTag="emit('toggleTag', $event)"
		/>
	</aside>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import CompassTopicLists from './CompassTopicLists.vue'
import type {CompassTopic} from '@/client/queries/compass'

const props = defineProps<{
	layout: 'rail' | 'disclosure'
	categories: CompassTopic[]
	tags: CompassTopic[]
	selectedCategory: string
	selectedTag: string
}>()

const emit = defineEmits<{
	toggleCategory: [name: string]
	toggleTag: [name: string]
}>()

const {t} = useI18n({useScope: 'global'})

// Folded on phones; it opens by itself only when a category or tag is chosen, and stays as the reader leaves it.
const open = ref(false)
watch(() => props.selectedCategory !== '' || props.selectedTag !== '', active => {
	if (active) open.value = true
}, {immediate: true})

const selectionLabel = computed(() => [
	props.selectedCategory,
	props.selectedTag === '' ? '' : `#${props.selectedTag}`,
].filter(part => part !== '').join(' · '))
</script>

<style lang="scss" scoped>
.compass-topics--rail {
	position: sticky;
	inset-block-start: calc(var(--header-height) + var(--space-4));
	max-block-size: calc(100dvh - var(--header-height) - var(--space-8));
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-inline-start: var(--space-5);
	border-inline-start: 1px solid var(--compass-rule);
}

.compass-topics--disclosure {
	border-block: 1px solid var(--compass-rule);
}

.compass-topics__summary {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	padding: var(--space-2) var(--space-1);
	color: var(--compass-ink);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	list-style: none;
	cursor: pointer;

	&::-webkit-details-marker {
		display: none;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-topics__selection {
	min-inline-size: 0;
	overflow: hidden;
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.compass-topics__chevron {
	flex: none;
	inline-size: .75em;
	margin-inline-start: auto;
	color: var(--compass-ink-faint);
	transition: transform var(--motion-fast) var(--ease-standard);

	[open] > .compass-topics__summary & {
		transform: rotate(180deg);
	}
}

.compass-topics__body {
	padding: var(--space-2) var(--space-1) var(--space-4);
}
</style>
