<script setup lang="ts">
import {computed, onMounted, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {TaskResponse} from '@/client/queries/tasks'
import {directSubtaskProgress, hierarchyTrail, type HierarchyIndex} from '@/helpers/kanbanHierarchy'
import KanbanSubtaskProgress from './KanbanSubtaskProgress.vue'
import {useTaskLabel, useTaskRoute} from './kanbanTreeContext'

const props = defineProps<{
	/** The whole board, not the focused one: the trail shows where the focused task sits. */
	index: HierarchyIndex<TaskResponse>
	focusId: number
	shown: number
	loaded: number
	canLoadMore: boolean
	loading: boolean
}>()

const emit = defineEmits<{exit: [], loadMore: []}>()

const MISSING_SHOWN = 12

const {t} = useI18n({useScope: 'global'})
const label = useTaskLabel()
const taskRoute = useTaskRoute()

const task = computed(() => props.index.known.get(props.focusId) ?? {id: props.focusId})
const trail = computed(() => hierarchyTrail(props.index, props.focusId))
const trailText = computed(() => [
	...(trail.value.truncated ? ['…'] : []),
	...trail.value.items.map(label),
].join(' › '))
const progress = computed(() => directSubtaskProgress(props.index, props.focusId))
// Known from relation summaries only: listed as references, never as cards.
const missing = computed(() => (props.index.children.get(props.focusId) ?? [])
	.filter(id => !props.index.loaded.has(id))
	.map(id => props.index.known.get(id) ?? {id}))

// The focus button that opened this bar is gone from the column, so keyboard focus moves here.
const heading = useTemplateRef<HTMLElement>('heading')
const focusHeading = () => heading.value?.focus({preventScroll: true})
onMounted(focusHeading)
watch(() => props.focusId, focusHeading, {flush: 'post'})
</script>

<template>
	<section
		class="kanban-focus-bar"
		:aria-labelledby="`kanban-focus-${focusId}`"
	>
		<Icon
			icon="crosshairs"
			class="kanban-focus-bar__icon"
		/>
		<div class="kanban-focus-bar__main">
			<p
				v-if="trail.items.length"
				class="kanban-tree-trail"
			>
				<Icon icon="level-up-alt" />
				<span aria-hidden="true">{{ trailText }}</span>
				<span class="is-sr-only">{{ t('project.kanban.hierarchy.trail', {path: trailText}) }}</span>
			</p>
			<h2
				:id="`kanban-focus-${focusId}`"
				ref="heading"
				class="kanban-focus-bar__title"
				tabindex="-1"
			>
				<span class="kanban-focus-bar__label">{{ t('project.kanban.hierarchy.focusing') }}</span>
				<RouterLink
					:to="taskRoute(focusId)"
				>
					{{ label(task) }}
				</RouterLink>
			</h2>
			<p class="kanban-focus-bar__meta">
				<KanbanSubtaskProgress :progress="progress" />
				<span>{{ t('project.kanban.hierarchy.focusShown', {shown, loaded}) }}</span>
			</p>
			<p class="kanban-focus-bar__hint">
				{{ t('project.kanban.hierarchy.focusHint') }}
			</p>
			<details
				v-if="missing.length"
				class="kanban-focus-bar__missing"
			>
				<summary>{{ t('project.kanban.hierarchy.missingChildren', {count: missing.length}, missing.length) }}</summary>
				<ul>
					<li
						v-for="child in missing.slice(0, MISSING_SHOWN)"
						:key="child.id"
					>
						<Icon
							:icon="child.done ? 'circle-check' : ['far', 'circle']"
							:class="{'is-done': child.done}"
							:aria-label="t(child.done ? 'task.hierarchy.done' : 'task.hierarchy.pending')"
						/>
						<RouterLink
							:to="taskRoute(child.id)"
						>
							{{ label(child) }}
						</RouterLink>
					</li>
				</ul>
				<p v-if="missing.length > MISSING_SHOWN">
					{{ t('project.kanban.hierarchy.missingMore', {count: missing.length - MISSING_SHOWN}) }}
				</p>
			</details>
		</div>
		<div class="kanban-focus-bar__actions">
			<XButton
				v-if="canLoadMore"
				variant="secondary"
				:shadow="false"
				:loading="loading"
				@click="!loading && emit('loadMore')"
			>
				{{ t('project.kanban.hierarchy.loadMoreAll') }}
			</XButton>
			<XButton
				variant="secondary"
				:shadow="false"
				icon="times"
				@click="emit('exit')"
			>
				{{ t('project.kanban.hierarchy.exitFocus') }}
			</XButton>
		</div>
	</section>
</template>

<style scoped lang="scss">
.kanban-focus-bar {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	gap: var(--space-2) var(--space-3);
	margin-block-end: var(--space-3);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--accent-text);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.kanban-focus-bar__icon {
	flex-shrink: 0;
	margin-block-start: var(--space-1);
	color: var(--accent-text);
}

.kanban-focus-bar__main {
	display: flex;
	flex: 1 1 16rem;
	flex-direction: column;
	gap: 2px;
	min-inline-size: 0;
}

.kanban-focus-bar__title {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-2);
	margin: 0;
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;

	&:focus-visible {
		@include focus-ring;
	}

	a {
		color: var(--text-primary);
	}
}

.kanban-focus-bar__label {
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
}

.kanban-focus-bar__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.kanban-focus-bar__hint {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.kanban-focus-bar__missing {
	margin-block-start: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);

	summary {
		inline-size: fit-content;
		min-block-size: var(--target-min);
		align-content: center;
		cursor: pointer;
	}

	ul {
		margin: var(--space-1) 0 0;
		padding-inline-start: var(--space-3);
		border-inline-start: 1px dashed var(--border-strong);
		list-style: none;
	}

	li {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin-block: 2px;
		overflow-wrap: anywhere;
	}

	svg {
		flex-shrink: 0;
		color: var(--text-tertiary);

		&.is-done {
			color: var(--success);
		}
	}
}

.kanban-focus-bar__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-inline-start: auto;
}
</style>
