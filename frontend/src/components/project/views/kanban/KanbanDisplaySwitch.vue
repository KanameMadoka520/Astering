<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import type {KanbanDisplayMode} from '@/composables/useKanbanDisplayPreferences'
import BaseButton from '@/components/base/BaseButton.vue'

defineProps<{
	mode: KanbanDisplayMode
	/** Whether any group is collapsed now; the one button then expands them all. */
	anyCollapsed: boolean
	canCollapse: boolean
}>()

const emit = defineEmits<{
	'update:mode': [mode: KanbanDisplayMode]
	collapseAll: []
	expandAll: []
}>()

const {t} = useI18n({useScope: 'global'})
</script>

<template>
	<div class="kanban-display">
		<div
			class="kanban-display__switch"
			role="group"
			:aria-label="t('project.kanban.hierarchy.display')"
		>
			<BaseButton
				v-tooltip="t('project.kanban.hierarchy.cardsHint')"
				class="kanban-display__option"
				:class="{'is-active': mode === 'cards'}"
				:aria-pressed="mode === 'cards'"
				@click="emit('update:mode', 'cards')"
			>
				<Icon icon="th" />
				{{ t('project.kanban.hierarchy.cards') }}
			</BaseButton>
			<BaseButton
				v-tooltip="t('project.kanban.hierarchy.groupsHint')"
				class="kanban-display__option"
				:class="{'is-active': mode === 'groups'}"
				:aria-pressed="mode === 'groups'"
				aria-describedby="kanban-display-groups-hint"
				@click="emit('update:mode', 'groups')"
			>
				<Icon icon="layer-group" />
				{{ t('project.kanban.hierarchy.groups') }}
			</BaseButton>
			<span
				id="kanban-display-groups-hint"
				class="is-sr-only"
			>{{ t('project.kanban.hierarchy.groupsHint') }}</span>
		</div>
		<BaseButton
			v-if="mode === 'groups' && canCollapse"
			v-tooltip="t(anyCollapsed ? 'project.kanban.hierarchy.expandAll' : 'project.kanban.hierarchy.collapseAll')"
			class="kanban-display__all"
			:aria-label="t(anyCollapsed ? 'project.kanban.hierarchy.expandAll' : 'project.kanban.hierarchy.collapseAll')"
			@click="anyCollapsed ? emit('expandAll') : emit('collapseAll')"
		>
			<Icon :icon="anyCollapsed ? 'chevron-down' : 'angles-up'" />
		</BaseButton>
	</div>
</template>

<style scoped lang="scss">
.kanban-display {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.kanban-display__switch {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	min-block-size: var(--control-height);
	padding: 2px;
	border: 1px solid var(--border-subtle);
	border-radius: $radius;
	background: var(--surface);
	box-shadow: var(--elevation-1);
	font-size: var(--text-sm);
}

.kanban-display__option {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: calc(var(--control-height) - 6px);
	padding-inline: var(--space-2);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-weight: var(--weight-medium);
	white-space: nowrap;

	svg {
		font-size: var(--text-xs);
	}

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: 0;
	}

	&.is-active {
		background-color: var(--surface-selected);
		color: var(--accent-text);
		font-weight: var(--weight-semibold);
	}
}

.kanban-display__all {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height);
	block-size: var(--control-height);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: 0;
	}
}
</style>
