<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import type {TaskResponse} from '@/client/queries/tasks'
import type {KanbanTreeNode as TreeNode} from '@/helpers/kanbanHierarchy'
import XButton from '@/components/input/Button.vue'
import KanbanTreeNode from './KanbanTreeNode.vue'

defineProps<{
	bucketId: number
	nodes: TreeNode<TaskResponse>[]
	/** Loaded cards of this column hidden because they are outside the focused family. */
	hidden: number
	focused: boolean
	loaded: number
	count: number
	loading: boolean
}>()

const emit = defineEmits<{loadMore: []}>()

const {t} = useI18n({useScope: 'global'})
</script>

<template>
	<div class="kanban-tree-column">
		<ul
			v-if="nodes.length"
			class="kanban-tree"
		>
			<KanbanTreeNode
				v-for="node in nodes"
				:key="node.key"
				:node="node"
				:bucket-id="bucketId"
			/>
		</ul>
		<p
			v-else-if="focused"
			class="kanban-tree-note"
		>
			{{ t('project.kanban.hierarchy.noFocusCards') }}
		</p>
		<p
			v-if="focused && hidden > 0"
			class="kanban-tree-note"
		>
			{{ t('project.kanban.hierarchy.hiddenByFocus', {count: hidden}, hidden) }}
		</p>
		<div
			v-if="loaded < count"
			class="kanban-tree-more"
		>
			<span>{{ t('project.kanban.hierarchy.loaded', {loaded, count}) }}</span>
			<XButton
				variant="secondary"
				:shadow="false"
				:loading="loading"
				@click="!loading && emit('loadMore')"
			>
				{{ loading ? t('project.kanban.hierarchy.loadingMore') : t('project.kanban.hierarchy.loadMore') }}
			</XButton>
		</div>
	</div>
</template>

<style lang="scss">
// Not scoped: rows and headers are separate components that share this outline.
.kanban-tree-column {
	// Phones get the larger target size from the coarse-pointer tokens.
	--kanban-tree-target: max(var(--control-height-sm), var(--target-min));

	padding: var(--space-1) var(--space-2) var(--space-2);
}

.kanban-tree,
.kanban-tree-children {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}

// Cards nested under a parent card hang off a guide line below it.
.kanban-tree-node.is-task > .kanban-tree-children {
	margin-block-start: var(--space-1);
	margin-inline-start: var(--space-3);
	padding-inline-start: var(--space-2);
	border-inline-start: 1px solid var(--border-default);
}

// Deeper levels keep their guide line but stop indenting, so a narrow column never squeezes titles.
.kanban-tree-children .kanban-tree-children .kanban-tree-children {
	margin-inline-start: 0;
	padding-inline-start: var(--space-1);
}

// A context header is a section label, not a card: its members keep the column's full width.
.kanban-tree > .kanban-tree-node.is-context:not(:first-child) {
	margin-block-start: var(--space-2);
}

.kanban-tree-row,
.kanban-tree-context {
	display: flex;
	align-items: flex-start;
	gap: var(--space-1);
	min-inline-size: 0;
}

.kanban-tree-row {
	padding: var(--space-1);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--kanban-tree-accent, var(--border-subtle));
	border-radius: var(--radius-sm);
	background: var(--surface);
	color: var(--text-primary);

	&:hover {
		border-color: var(--border-default);
		border-inline-start-color: var(--kanban-tree-accent, var(--border-default));
	}

	&.is-group {
		box-shadow: var(--elevation-1);

		.kanban-tree-row__title {
			font-weight: var(--weight-semibold);
		}
	}

	&.is-done .kanban-tree-row__title {
		color: var(--text-secondary);
		text-decoration: line-through;
		text-decoration-color: var(--text-tertiary);
	}
}

.kanban-tree-context {
	padding: var(--space-1) var(--space-1) var(--space-1) 0;
	border-block-start: 1px solid var(--border-default);
	color: var(--text-primary);

	.kanban-tree-node.is-context:first-child > & {
		border-block-start-color: transparent;
	}
}

.kanban-tree-row__main,
.kanban-tree-context__main {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	gap: 2px;
	min-inline-size: 0;
	padding-block: 2px;
}

// Never clamped: sibling titles often share a long prefix and differ only at the end.
.kanban-tree-row__title,
.kanban-tree-context__title {
	align-self: flex-start;
	color: inherit;
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;
	text-decoration: none;

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: 1px;
	}
}

.kanban-tree-context__title {
	font-weight: var(--weight-semibold);

	svg {
		margin-inline-end: var(--space-1);
		color: var(--success);
	}
}

.kanban-tree-context.is-done .kanban-tree-context__title {
	color: var(--text-secondary);
}

.kanban-tree-context__where {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	line-height: var(--leading-normal);
}

// Dashed like the board's drop ghost: a reference to a card, not a card.
.kanban-tree-context__tag {
	padding: 0 var(--space-1);
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-weight: var(--weight-semibold);
}

.kanban-tree-trail {
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	min-inline-size: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	svg {
		flex-shrink: 0;
		font-size: var(--text-2xs);
	}
}

.kanban-tree-row__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 2px var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);

	.checklist-summary {
		padding: 0;
		font-size: var(--text-xs);
	}
}

.kanban-tree-row__id {
	font-variant-numeric: tabular-nums;
}

.kanban-tree-row__due {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	white-space: nowrap;

	&.is-overdue {
		color: var(--danger-text);
	}
}

.kanban-tree-here,
.kanban-tree-others {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	white-space: nowrap;
}

.kanban-tree-row__actions {
	display: flex;
	flex-direction: column;
	flex-shrink: 0;
	align-items: center;

	&:empty {
		display: none;
	}
}

.kanban-tree-toggle,
.kanban-tree-check,
.kanban-tree-action {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: var(--kanban-tree-target);
	block-size: var(--kanban-tree-target);
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: 0;
	}
}

.kanban-tree-check {
	padding: 0;
	border: 0;
	background: transparent;
	font-size: var(--text-md);
	cursor: pointer;

	&.is-complete {
		color: var(--success);
	}

	&[aria-busy] {
		opacity: .5;
	}

	&.is-static {
		cursor: default;

		&:hover {
			background: transparent;
		}
	}
}

[dir='rtl'] .kanban-tree-toggle .fa-chevron-right {
	transform: scaleX(-1);
}

.kanban-tree-note {
	margin-block: var(--space-2) 0;
	padding-inline: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.kanban-tree-more {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-1) var(--space-2);
	margin-block-start: var(--space-2);
	padding-inline: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}
</style>
