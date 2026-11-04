<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Task} from '@/client/generated'
import BaseButton from '@/components/base/BaseButton.vue'
const props = withDefaults(defineProps<{task: Task; inlineTree?: boolean; expanded?: boolean; showParents?: boolean}>(), {inlineTree: false, expanded: true, showParents: true})
defineEmits<{toggle: []}>()
const {t} = useI18n({useScope: 'global'})
function unique(tasks: Task[]) { return [...new Map(tasks.filter(task => task.id !== undefined && task.id !== props.task.id).map(task => [task.id, task])).values()] }
const parents = computed(() => props.showParents ? unique(props.task.related_tasks?.parenttask ?? []) : [])
const children = computed(() => unique(props.task.related_tasks?.subtask ?? []))
const label = computed(() => t('task.hierarchy.children', {done: children.value.filter(child => child.done).length, total: children.value.length}))
</script>

<template>
	<div
		v-if="parents.length || children.length"
		class="task-hierarchy-summary"
		@click.stop
		@keydown.stop
		@keyup.stop
	>
		<RouterLink
			v-for="parent in parents"
			:key="parent.id"
			class="parent-task-link"
			:to="{name: 'task.detail', params: {id: parent.id}}"
			:title="t('task.hierarchy.parent', {title: parent.title})"
		>
			<Icon icon="level-up-alt" />{{ t('task.hierarchy.parent', {title: parent.title}) }}
		</RouterLink>
		<BaseButton
			v-if="children.length && inlineTree"
			class="subtasks-toggle"
			:aria-expanded="expanded"
			:aria-label="t(expanded ? 'task.hierarchy.collapse' : 'task.hierarchy.expand', {title: task.title})"
			:title="t('task.hierarchy.directOnly')"
			@click="$emit('toggle')"
		>
			<Icon :icon="expanded ? 'chevron-down' : 'chevron-right'" />{{ label }}
		</BaseButton>
		<details
			v-else-if="children.length"
			class="subtasks-preview"
		>
			<summary :title="t('task.hierarchy.directOnly')">
				<Icon icon="sitemap" />{{ label }}
			</summary>
			<ul>
				<li
					v-for="child in children"
					:key="child.id"
				>
					<Icon
						:icon="child.done ? 'check' : 'minus'"
						:aria-label="t(child.done ? 'task.hierarchy.done' : 'task.hierarchy.pending')"
					/>
					<RouterLink
						:to="{name: 'task.detail', params: {id: child.id}}"
						:class="{'child-done': child.done}"
					>
						{{ child.title }}
					</RouterLink>
				</li>
			</ul>
		</details>
	</div>
</template>

<style scoped lang="scss">
.task-hierarchy-summary {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	gap: var(--space-1) var(--space-2);
	font-size: var(--text-xs);
	font-weight: var(--weight-regular);
	line-height: var(--leading-normal);
	margin-block: var(--space-1);
	min-inline-size: 0;
}
.parent-task-link, .subtasks-toggle, .subtasks-preview summary {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--target-min);
	padding: 0 var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	max-inline-size: 100%;
	overflow-wrap: anywhere;
	cursor: pointer;

	&:hover {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
		color: var(--text-primary);
	}
}
.parent-task-link svg, .subtasks-toggle svg, .subtasks-preview summary svg {
	flex-shrink: 0;
	color: var(--text-tertiary);
}
.subtasks-preview { max-inline-size: 100%; }
.subtasks-preview ul {
	margin-block: var(--space-1) 0;
	margin-inline: var(--space-2) 0;
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--border-default);
	list-style: none;
}
.subtasks-preview li {
	display: flex;
	gap: var(--space-2);
	align-items: baseline;
	margin-block: var(--space-1);
}
.subtasks-preview a { overflow-wrap: anywhere; }
.child-done {
	text-decoration: line-through;
	color: var(--text-tertiary);
}
</style>
