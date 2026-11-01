<template>
	<ProjectWrapper
		class="project-gantt"
		:is-loading-project="isLoadingProject"
		:project-id
		:view-id
	>
		<template #header>
			<div class="filter-container gantt-options">
				<div class="gantt-options__range">
					<label
						class="is-sr-only"
						:for="rangeInputId"
					>{{ $t('misc.dateRange') }}</label>
					<DateRangeInput
						:id="rangeInputId"
						v-model="dateRange"
						:placeholder="$t('misc.dateRange')"
					/>
				</div>
				<XButton
					v-if="!hasDefaultFilters"
					variant="tertiary"
					:shadow="false"
					icon="undo"
					@click="setDefaultFilters"
				>
					{{ $t('tcymc.reset') }}
				</XButton>
				<FancyCheckbox
					v-model="filters.showTasksWithoutDates"
					class="gantt-options__no-dates"
				>
					{{ $t('task.show.noDates') }}
				</FancyCheckbox>
			</div>
		</template>

		<template #default>
			<div class="gantt-chart-container">
				<Card
					:has-content="false"
					:padding="false"
					class="has-overflow"
				>
					<LoadError
						v-if="loadFailed"
						class="gantt-load-error"
						:message="$t('project.tasksLoadError')"
						:retry="loadTasks"
					/>
					<GanttChart
						:filters="filters"
						:tasks="tasks"
						:is-loading="isLoading"
						:default-task-start-date="defaultTaskStartDate"
						:default-task-end-date="defaultTaskEndDate"
						@update:task="updateTask"
					/>
					<TaskForm
						v-if="canWrite"
						class="gantt-task-form"
						@createTask="addGanttTask"
					/>
				</Card>
			</div>
		</template>
	</ProjectWrapper>
</template>

<script setup lang="ts">
import {computed, toRefs, useId} from 'vue'
import type {RouteLocationNormalized} from 'vue-router'

import {useCurrentProject} from '@/composables/useCurrentProject'

import DateRangeInput from '@/components/input/DateRangeInput.vue'
import ProjectWrapper from '@/components/project/ProjectWrapper.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import TaskForm from '@/components/tasks/TaskForm.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

import GanttChart from '@/components/gantt/GanttChart.vue'
import {useGanttFilters} from '../../../views/project/helpers/useGanttFilters'
import {PERMISSIONS} from '@/constants/permissions'

import type {DateISO} from '@/types/DateISO'
import type {Task as ITask} from '@/client/generated'

const props = defineProps<{
	isLoadingProject: boolean,
	projectId: number,
	route: RouteLocationNormalized
	viewId: number
}>()


const {currentProject} = useCurrentProject()
const canWrite = computed(() =>
	typeof currentProject.value?.max_permission === 'number' &&
	currentProject.value.max_permission > PERMISSIONS.READ,
)

const rangeInputId = useId()

const {route, projectId, viewId} = toRefs(props)
const {
	filters,
	hasDefaultFilters,
	setDefaultFilters,
	tasks,
	isLoading,
	loadFailed,
	loadTasks,
	addTask,
	updateTask,
} = useGanttFilters(route, projectId, viewId)

const DEFAULT_DATE_RANGE_DAYS = 7

const today = new Date()
const defaultTaskStartDate: DateISO = new Date(today.setHours(0, 0, 0, 0)).toISOString()
const defaultTaskEndDate: DateISO = new Date(new Date(
	today.getFullYear(),
	today.getMonth(),
	today.getDate() + DEFAULT_DATE_RANGE_DAYS,
).setHours(23, 59, 0, 0)).toISOString()

async function addGanttTask(title: ITask['title']) {
	return await addTask({
		title,
		project_id: filters.value.projectId,
		start_date: defaultTaskStartDate,
		end_date: defaultTaskEndDate,
	})
}

const dateRange = computed({
	get: () => ({
		start: new Date(filters.value.dateFrom),
		end: new Date(filters.value.dateTo),
	}),
	set({start, end}: {start: Date, end: Date}) {
		Object.assign(filters.value, {dateFrom: start.toISOString(), dateTo: end.toISOString()})
	},
})
</script>

<style lang="scss" scoped>
.gantt-chart-container {
	position: relative;
	padding-block-end: var(--space-4);
}

.gantt-load-error {
	margin: var(--space-3);
}

.gantt-options {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-2) var(--space-3);
}

.gantt-options__range {
	min-inline-size: 0;

	:deep(.date-range-input__trigger) {
		min-block-size: var(--control-height);
		block-size: auto;
		padding-block: 0;
		font-size: var(--text-md);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
}

.gantt-options__no-dates {
	font-size: var(--text-md);
	white-space: nowrap;
}

.gantt-chart-container .gantt-task-form {
	padding: var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
}
</style>
