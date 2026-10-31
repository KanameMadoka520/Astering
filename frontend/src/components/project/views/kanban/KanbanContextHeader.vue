<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Task} from '@/client/generated'
import {directSubtaskProgress, type Trail} from '@/helpers/kanbanHierarchy'
import BaseButton from '@/components/base/BaseButton.vue'
import KanbanSubtaskProgress from './KanbanSubtaskProgress.vue'
import {useKanbanTree, useTaskLabel, useTaskRoute} from './kanbanTreeContext'

const props = defineProps<{
	parent: Task
	trail: Trail
	bucketId: number
	expanded: boolean
	groupSize: number
	/** Only while expanded: the list it controls exists then. */
	childrenId?: string
}>()

const emit = defineEmits<{toggle: []}>()

const {t} = useI18n({useScope: 'global'})
const tree = useKanbanTree()
const label = useTaskLabel()
const taskRoute = useTaskRoute()

const id = computed(() => props.parent.id!)
const title = computed(() => label(props.parent))
const progress = computed(() => directSubtaskProgress(tree.index.value, id.value))
const trailText = computed(() => [
	...(props.trail.truncated ? ['…'] : []),
	...props.trail.items.map(label),
].join(' › '))
const location = computed(() => {
	const buckets = tree.index.value.loaded.get(id.value)?.buckets
	if (!buckets) return {text: t('project.kanban.hierarchy.contextNotLoaded'), hint: t('project.kanban.hierarchy.contextNotLoadedHint')}
	if (buckets.includes(props.bucketId)) return {text: t('project.kanban.hierarchy.contextHere'), hint: null}
	const bucket = tree.buckets.value.find(item => item.id === buckets[0])
	return {text: t('project.kanban.hierarchy.contextIn', {bucket: bucket?.title ?? ''}), hint: null}
})
</script>

<template>
	<div
		class="kanban-tree-context"
		:class="{'is-done': parent.done}"
	>
		<BaseButton
			class="kanban-tree-toggle"
			:aria-expanded="expanded"
			:aria-controls="childrenId"
			:aria-label="t(expanded ? 'task.hierarchy.collapse' : 'task.hierarchy.expand', {title})"
			@click="emit('toggle')"
		>
			<Icon :icon="expanded ? 'chevron-down' : 'chevron-right'" />
		</BaseButton>
		<div class="kanban-tree-context__main">
			<p
				class="kanban-tree-context__where"
				:title="location.hint ?? undefined"
			>
				<span class="kanban-tree-context__tag">{{ t('project.kanban.hierarchy.context') }}</span>
				<span>{{ location.text }}</span>
				<span
					v-if="location.hint"
					class="is-sr-only"
				>{{ location.hint }}</span>
			</p>
			<p
				v-if="trail.items.length"
				class="kanban-tree-trail"
				:title="trailText"
			>
				<Icon icon="level-up-alt" />
				<span aria-hidden="true">{{ trailText }}</span>
				<span class="is-sr-only">{{ t('project.kanban.hierarchy.trail', {path: trailText}) }}</span>
			</p>
			<RouterLink
				class="kanban-tree-context__title"
				:to="taskRoute(id)"
			>
				<Icon
					v-if="parent.done"
					icon="circle-check"
					:aria-label="t('task.hierarchy.done')"
				/>
				{{ title }}
			</RouterLink>
			<div class="kanban-tree-row__meta">
				<KanbanSubtaskProgress :progress="progress" />
				<span class="kanban-tree-here">{{ t('project.kanban.hierarchy.here', {count: groupSize}, groupSize) }}</span>
			</div>
		</div>
		<span class="kanban-tree-row__actions">
			<BaseButton
				v-if="tree.focusId.value !== id"
				v-tooltip="t('project.kanban.hierarchy.focus', {title})"
				class="kanban-tree-action"
				:data-focus-target="id"
				:aria-label="t('project.kanban.hierarchy.focus', {title})"
				@click="tree.focus(id)"
			>
				<Icon icon="crosshairs" />
			</BaseButton>
		</span>
	</div>
</template>
