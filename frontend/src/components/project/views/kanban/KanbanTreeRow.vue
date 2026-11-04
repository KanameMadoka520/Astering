<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import type {TaskResponse} from '@/client/queries/tasks'
import {directSubtaskProgress, otherParents, type Trail} from '@/helpers/kanbanHierarchy'
import {getHexColor, getTaskIdentifier} from '@/helpers/task'
import {isLegacyRoutine, routineOf} from '@/helpers/taskRoutine'
import {formatDateLong, formatDisplayDate, formatISO} from '@/helpers/time/formatDate'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useTaskDoneToggle} from '@/composables/useTaskDoneToggle'
import BaseButton from '@/components/base/BaseButton.vue'
import ChecklistSummary from '@/components/tasks/partials/ChecklistSummary.vue'
import KanbanSubtaskProgress from './KanbanSubtaskProgress.vue'
import KanbanMoveSelect from './KanbanMoveSelect.vue'
import {useKanbanTree, useTaskLabel, useTaskRoute} from './kanbanTreeContext'

const props = defineProps<{
	task: TaskResponse
	bucketId: number
	trail: Trail | null
	/** Set on a group header: whether its children show, and how many cards of the group are in this column. */
	expanded?: boolean
	groupSize?: number
	childrenId?: string
}>()

const emit = defineEmits<{toggle: []}>()

const {t} = useI18n({useScope: 'global'})
const tree = useKanbanTree()
const label = useTaskLabel()
const taskRoute = useTaskRoute()
const doneToggle = useTaskDoneToggle()
const {now} = useGlobalNow()

const title = computed(() => label(props.task))
const color = computed(() => getHexColor(props.task.hex_color))
const complete = computed(() => doneToggle.isComplete(props.task))
const routine = computed(() => doneToggle.isRoutine(props.task))
const progress = computed(() => directSubtaskProgress(tree.index.value, props.task.id))
const others = computed(() => otherParents(tree.index.value, props.task.id))
const trailText = computed(() => [
	...(props.trail?.truncated ? ['…'] : []),
	...(props.trail?.items ?? []).map(label),
].join(' › '))
const due = computed(() => {
	const time = new Date(props.task.due_date ?? 0).getTime()
	return time > 0 ? {time, overdue: !routine.value && !props.task.done && time <= now.value.getTime()} : null
})
const checkLabel = computed(() => routine.value
	? t(routineOf(props.task) && isLegacyRoutine(routineOf(props.task)!)
		? 'task.routine.checkInLabel' : 'routineSchedule.completeTask', {task: title.value})
	: t(complete.value ? 'project.kanban.hierarchy.markUndone' : 'project.kanban.hierarchy.markDone', {title: title.value}))

const saving = ref(false)
async function toggleDone() {
	if (saving.value) return
	saving.value = true
	try {
		await doneToggle.toggle(props.task, tree.recurringDone)
	} catch {
		// The mutation reports the failure; the mark keeps following the cached task, which did not change.
	} finally {
		saving.value = false
	}
}
</script>

<template>
	<div
		class="kanban-tree-row"
		:class="{
			'is-done': complete,
			'is-group': expanded !== undefined,
			'has-accent': color,
		}"
		:style="color ? {'--kanban-tree-accent': color} : undefined"
		:data-tree-task="task.id"
		:data-tree-bucket="bucketId"
	>
		<BaseButton
			v-if="expanded !== undefined"
			class="kanban-tree-toggle"
			:aria-expanded="expanded"
			:aria-controls="childrenId"
			:aria-label="t(expanded ? 'task.hierarchy.collapse' : 'task.hierarchy.expand', {title})"
			@click="emit('toggle')"
		>
			<Icon :icon="expanded ? 'chevron-down' : 'chevron-right'" />
		</BaseButton>
		<button
			v-if="tree.canComplete(task)"
			type="button"
			role="checkbox"
			class="kanban-tree-check"
			:class="{'is-complete': complete}"
			:aria-checked="complete"
			:aria-label="checkLabel"
			:aria-busy="saving || undefined"
			@click="toggleDone"
		>
			<Icon :icon="complete ? 'circle-check' : ['far', 'circle']" />
		</button>
		<span
			v-else
			class="kanban-tree-check is-static"
			:class="{'is-complete': complete}"
			role="img"
			:aria-label="t(complete ? 'task.hierarchy.done' : 'task.hierarchy.pending')"
		>
			<Icon :icon="complete ? 'circle-check' : ['far', 'circle']" />
		</span>
		<div class="kanban-tree-row__main">
			<p
				v-if="tree.showParents?.value !== false && trail && trail.items.length"
				class="kanban-tree-trail"
				:title="trailText"
			>
				<Icon icon="level-up-alt" />
				<span aria-hidden="true">{{ trailText }}</span>
				<span class="is-sr-only">{{ t('project.kanban.hierarchy.trail', {path: trailText}) }}</span>
			</p>
			<RouterLink
				class="kanban-tree-row__title"
				:to="taskRoute(task.id)"
			>
				{{ title }}
			</RouterLink>
			<div class="kanban-tree-row__meta">
				<span class="kanban-tree-row__id">{{ getTaskIdentifier(task) }}</span>
				<span
					v-if="due"
					v-tooltip="formatDateLong(task.due_date)"
					class="kanban-tree-row__due"
					:class="{'is-overdue': due.overdue}"
				>
					<Icon :icon="['far', 'calendar-alt']" />
					<time :datetime="formatISO(task.due_date)">{{ formatDisplayDate(task.due_date) }}</time>
				</span>
				<ChecklistSummary
					:task="task"
					compact
				/>
				<KanbanSubtaskProgress
					v-if="progress && progress.total > 0"
					:progress="progress"
					compact
				/>
				<span
					v-if="groupSize"
					class="kanban-tree-here"
				>{{ t('project.kanban.hierarchy.here', {count: groupSize}, groupSize) }}</span>
				<span
					v-if="tree.showParents?.value !== false && others.length"
					class="kanban-tree-others"
					:title="t('project.kanban.hierarchy.otherParents', {titles: others.map(label).join(', ')})"
				>
					<Icon icon="code-branch" />
					<span aria-hidden="true">+{{ others.length }}</span>
					<span class="is-sr-only">{{ t('project.kanban.hierarchy.otherParents', {titles: others.map(label).join(', ')}) }}</span>
				</span>
			</div>
		</div>
		<!-- Stacked beside the text: leaf rows stay one target high, titles still wrap in full. -->
		<span class="kanban-tree-row__actions">
			<BaseButton
				v-if="progress && progress.total > 0 && tree.focusId.value !== task.id"
				v-tooltip="t('project.kanban.hierarchy.focus', {title})"
				class="kanban-tree-action"
				:data-focus-target="task.id"
				:aria-label="t('project.kanban.hierarchy.focus', {title})"
				@click="tree.focus(task.id)"
			>
				<Icon icon="crosshairs" />
			</BaseButton>
			<KanbanMoveSelect
				v-if="tree.canMove.value"
				:task="task"
				:bucket-id="bucketId"
			/>
		</span>
	</div>
</template>
