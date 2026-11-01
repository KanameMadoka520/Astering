<template>
	<ProjectWrapper
		class="project-list"
		:is-loading-project="isLoadingProject"
		:project-id="projectId"
		:view-id
	>
		<template #header>
			<div class="filter-container">
				<SortPopup
					v-model="sortByParam"
				/>
				<FilterPopup
					v-if="!isSavedFilterProject(project)"
					v-model="params"
					:view-id="viewId"
					:project-id="projectId"
					@update:modelValue="loadTasks()"
				/>
			</div>
		</template>

		<template #default>
			<div
				:class="{'is-loading': showLoading, 'is-refreshing': showRefreshing}"
				class="loader-container is-max-width-desktop list-view"
				:aria-busy="showRefreshing || undefined"
			>
				<Card
					:padding="false"
					:has-content="false"
					class="has-overflow"
				>
					<AddTask
						v-if="!project?.is_archived && canWrite"
						ref="addTaskRef"
						class="list-view__add-task d-print-none"
						@tasksAdded="updateTaskList"
					/>

					<LoadError
						v-if="loadFailed"
						class="list-view__load-error"
						:message="$t('project.tasksLoadError')"
						:retry="loadTasks"
					/>
					<Nothing v-else-if="ctaVisible && loaded && tasks.length === 0 && !loading">
						{{ $t('project.list.empty') }}
						<XButton
							v-if="(project?.id ?? 0) > 0 && canWrite"
							variant="secondary"
							icon="plus"
							@click="focusNewTaskInput()"
						>
							{{ $t('project.list.newTaskCta') }}
						</XButton>
					</Nothing>

					<draggable
						v-if="tasks && tasks.length > 0"
						v-model="tasks"
						:group="{name: 'tasks', put: false}"
						:disabled="!canDragTasks || !isPositionSorting"
						item-key="id"
						tag="ul"
						:component-data="{
							class: {
								tasks: true,
								'dragging-disabled': !canDragTasks || !isPositionSorting
							},
							type: 'transition-group'
						}"
						:animation="reducedMotion ? 0 : 150"
						:handle="dragHandle"
						:delay-on-touch-only="!isTouchDevice"
						:delay="isTouchDevice ? 0 : 1000"
						ghost-class="task-ghost"
						@start="handleDragStart"
						@end="saveTaskPosition"
					>
						<template #item="{element: t, index}">
							<SingleTaskInProject
								:ref="(el) => setTaskRef(el as InstanceType<typeof SingleTaskInProject> | null, index)"
								:show-list-color="false"
								:can-mark-as-done="canWrite || isPseudoProject"
								:the-task="t"
								:all-tasks="allTasks"
								:hierarchy="hierarchy"
								@taskUpdated="updateTasks"
							>
								<span
									v-if="canDragTasks && isPositionSorting"
									class="icon handle"
								>
									<Icon icon="grip-lines" />
								</span>
							</SingleTaskInProject>
						</template>
					</draggable>

					<Pagination
						:total-pages="totalPages"
						:current-page="currentPage"
					/>
				</Card>
			</div>
		</template>
	</ProjectWrapper>
</template>


<script setup lang="ts">
import {useUpdateTaskPositionMutation} from '@/client/queries/taskMutations'
import {ref, computed, nextTick, onMounted, onBeforeUnmount, watch, toRef} from 'vue'
import {useMediaQuery} from '@vueuse/core'
import {draggableFor} from '@/components/base/Draggable'

import ProjectWrapper from '@/components/project/ProjectWrapper.vue'
import AddTask from '@/components/tasks/AddTask.vue'
import SingleTaskInProject from '@/components/tasks/partials/SingleTaskInProject.vue'
import FilterPopup from '@/components/project/partials/FilterPopup.vue'
import Nothing from '@/components/misc/Nothing.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Pagination from '@/components/misc/Pagination.vue'
import SortPopup from '@/components/project/partials/SortPopup.vue'

import {useTaskList} from '@/composables/useTaskList'
import {useTaskDragToProject} from '@/composables/useTaskDragToProject'
import {useCurrentProject} from '@/composables/useCurrentProject'
import {buildTaskHierarchy} from '@/helpers/taskHierarchy'
import {PERMISSIONS as Permissions} from '@/constants/permissions'
import {calculateItemPosition} from '@/helpers/calculateItemPosition'
import type {TaskResponse} from '@/client/queries/tasks'
import {isSavedFilterProject} from '@/client/queries/projects'

import {useBaseStore} from '@/stores/base'
import {useTaskDragState} from '@/composables/useTaskDragState'
import {useDelayedLoading} from '@/composables/useDelayedLoading'


const props = defineProps<{
	isLoadingProject: boolean,
	projectId: number,
	viewId: number,
}>()

const draggable = draggableFor<TaskResponse>()

const projectId = toRef(props, 'projectId')

defineOptions({name: 'List'})

const ctaVisible = ref(false)

const drag = ref(false)

const {
	tasks: allTasks,
	loading,
	loadFailed,
	loaded,
	totalPages,
	currentPage,
	loadTasks,
	params,
	sortByParam,
} = useTaskList(
	() => projectId.value,
	() => props.viewId,
	{position: 'asc'},
	() => projectId.value === -1
		? ['comment_count', 'is_unread']
		: ['subtasks', 'comment_count', 'is_unread'],
)
// The spinner overlay is for a first load only; a background refetch keeps the rows usable.
const showLoading = useDelayedLoading(() => loading.value && allTasks.value.length === 0)
const showRefreshing = useDelayedLoading(() => loading.value && allTasks.value.length > 0)

const positionMutation = useUpdateTaskPositionMutation()

const dragTasks = ref<TaskResponse[] | null>(null)
const hierarchy = computed(() => buildTaskHierarchy(allTasks.value))
const tasks = computed({
	get: () => dragTasks.value ?? hierarchy.value.roots,
	set: value => { dragTasks.value = value },
})
watch([projectId, () => props.viewId], () => { dragTasks.value = null })

const isPositionSorting = computed(() => 'position' in sortByParam.value)

const baseStore = useBaseStore()
const {setDraggedTask} = useTaskDragState()
const {handleTaskDropToProject} = useTaskDragToProject()
const {currentProject: project} = useCurrentProject()

const canWrite = computed(() => {
	return typeof project.value?.max_permission === 'number' &&
		project.value.max_permission > Permissions.READ &&
		project.value.id > 0
})

const isPseudoProject = computed(() => isSavedFilterProject(project.value) || project.value?.id === -1)

onMounted(async () => {
	await nextTick()
	ctaVisible.value = true
})

const canDragTasks = computed(() => canWrite.value || isSavedFilterProject(project.value))

const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

const isTouchDevice = ref(false)
if (typeof window !== 'undefined') {
	isTouchDevice.value = !window.matchMedia('(hover: hover) and (pointer: fine)').matches
}
const dragHandle = computed(() => isTouchDevice.value ? '.handle' : undefined)

const addTaskRef = ref<typeof AddTask | null>(null)

function focusNewTaskInput() {
	addTaskRef.value?.focusTaskInput()
}

function updateTaskList() {
	baseStore.setHasTasks(true)
}

function updateTasks() {
	if (projectId.value < 0) void loadTasks()
}

function handleDragStart(e: { item: HTMLElement }) {
	drag.value = true
	dragTasks.value = [...tasks.value]
	const taskId = parseInt(e.item.dataset.taskId ?? '', 10)
	const task = tasks.value.find(t => t.id === taskId)

	if (task) {
		setDraggedTask(task)
	}
}

async function saveTaskPosition(e: { originalEvent?: MouseEvent, to: HTMLElement, from: HTMLElement, item: HTMLElement, newIndex: number }) {
	drag.value = false
	try {

		// Check if dropped on a sidebar project
		const {moved} = await handleTaskDropToProject(e, (task) => {
			tasks.value = tasks.value.filter(t => t.id !== task.id)
		})

		if (moved) {
			return
		}

		// If dropped outside this list
		if (e.to !== e.from) {
			return
		}

		// e.newIndex is a DOM index: it counts elements still leaving the transition group, so it can
		// point past the last task. The list is already reordered here, so resolve the task by its id.
		const movedTaskId = parseInt(e.item.dataset.taskId ?? '', 10)
		const newIndex = tasks.value.findIndex(t => t.id === movedTaskId)

		if (newIndex === -1) {
			return
		}

		const taskBefore = tasks.value[newIndex - 1] ?? null
		const taskAfter = tasks.value[newIndex + 1] ?? null

		const position = calculateItemPosition(
			taskBefore !== null ? taskBefore.position : null,
			taskAfter !== null ? taskAfter.position : null,
		)

		await positionMutation.mutateAsync({
			position,
			project_view_id: props.viewId,
			taskId: movedTaskId,
		})
	} catch { /* Mutation reports the error. */ } finally {
		dragTasks.value = null
	}
}

const taskRefs = ref<(InstanceType<typeof SingleTaskInProject> | null)[]>([])
const focusedIndex = ref(-1)

function setTaskRef(el: InstanceType<typeof SingleTaskInProject> | null, index: number) {
	if (el === null) {
		delete taskRefs.value[index]
	} else {
		taskRefs.value[index] = el
	}
}

function focusTask(index: number) {
	if (index < 0 || index >= tasks.value.length) {
		return
	}

	const taskRef = taskRefs.value[index]

	focusedIndex.value = index
	taskRef?.focus()
}

function handleListNavigation(e: KeyboardEvent) {
	if (e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable="true"]'))) {
		return
	}

	if (e.code === 'KeyJ') {
		e.preventDefault()
		focusTask(Math.min(focusedIndex.value + 1, tasks.value.length - 1))
		return
	}

	if (e.code === 'KeyK') {
		e.preventDefault()
		if (focusedIndex.value === -1) {
			focusTask(tasks.value.length - 1)
			return
		}

		if (focusedIndex.value === 0) {
			addTaskRef.value?.focusTaskInput()
			focusedIndex.value = -1
			return
		}

		focusTask(Math.max(focusedIndex.value - 1, 0))
		return
	}

	if (e.code === 'Enter') {
		if (e.isComposing) {
			return
		}

		// Links and buttons activate natively on Enter; leave them alone
		if (e.target instanceof HTMLElement && e.target.closest('a, button, [role="button"]')) {
			return
		}

		// Only act when a row was focused via J/K roving navigation
		if (focusedIndex.value < 0) {
			return
		}

		e.preventDefault()
		taskRefs.value[focusedIndex.value]?.click(e)
	}
}

onMounted(() => {
	document.addEventListener('keydown', handleListNavigation)
})

onBeforeUnmount(() => {
	document.removeEventListener('keydown', handleListNavigation)
})
</script>

<style lang="scss" scoped>
.filter-container {
	display: flex;
	align-items: center;
	gap: var(--space-2);

	:deep(.popup) {
		max-inline-size: min(20rem, calc(100vw - 2 * var(--space-4)));
	}
}

.tasks {
	padding: var(--space-1) var(--space-2) var(--space-2);
}

.task-ghost {
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);

	* {
		opacity: 0;
	}
}

.list-view__add-task {
	padding: var(--space-3) var(--space-3) 0;
}

.list-view__load-error {
	margin: var(--space-3);
}

.link-share-view .card {
	border: none;
	box-shadow: none;
}

:deep(.single-task .handle) {
	cursor: grab;
	margin-inline-end: var(--space-1);
	color: var(--text-tertiary);
}

@media (hover: hover) and (pointer: fine) {
	:deep(.single-task .handle) {
		display: none;
	}
}

:deep(.tasks:not(.dragging-disabled) .single-task) {
	cursor: grab;
	-webkit-touch-callout: none;
	user-select: none;
	touch-action: manipulation;

	&:active {
		cursor: grabbing;
	}
}

.list-view {
	padding-block-end: var(--space-4);
	transition: opacity var(--motion-fast) var(--ease-standard);

	&.is-refreshing {
		opacity: .85;
	}

	:deep(.card) {
		margin-block-end: 0;
	}
}
</style>
