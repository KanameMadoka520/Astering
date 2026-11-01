<template>
	<ProjectWrapper
		class="project-table"
		:is-loading-project="isLoadingProject"
		:project-id="projectId"
		:view-id
	>
		<template #header>
			<div class="filter-container">
				<Popup
					placement="bottom-start"
					:anchor="columnsTriggerEl"
					sheet-on-mobile
					:sheet-title="$t('project.table.columns')"
				>
					<template #trigger="{toggle, isOpen}">
						<XButton
							ref="columnsTrigger"
							icon="th"
							variant="secondary"
							aria-haspopup="dialog"
							:aria-expanded="isOpen"
							@click.prevent.stop="toggle()"
						>
							{{ $t('project.table.columns') }}
						</XButton>
					</template>
					<template #content>
						<Card class="columns-filter">
							<FancyCheckbox v-model="activeColumns.index">
								#
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.done">
								{{ $t('task.attributes.done') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.project">
								{{ $t('task.attributes.project') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.title">
								{{ $t('task.attributes.title') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.priority">
								{{ $t('task.attributes.priority') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.labels">
								{{ $t('task.attributes.labels') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.assignees">
								{{ $t('task.attributes.assignees') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.commentCount">
								{{ $t('task.attributes.commentCount') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.dueDate">
								{{ $t('task.attributes.dueDate') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.startDate">
								{{ $t('task.attributes.startDate') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.endDate">
								{{ $t('task.attributes.endDate') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.percentDone">
								{{ $t('task.attributes.percentDone') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.doneAt">
								{{ $t('task.attributes.doneAt') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.created">
								{{ $t('task.attributes.created') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.updated">
								{{ $t('task.attributes.updated') }}
							</FancyCheckbox>
							<FancyCheckbox v-model="activeColumns.createdBy">
								{{ $t('task.attributes.createdBy') }}
							</FancyCheckbox>
							<template #footer>
								<XButton
									variant="tertiary"
									:shadow="false"
									class="is-small"
									@click="resetColumns"
								>
									{{ $t('tcymc.reset') }}
								</XButton>
							</template>
						</Card>
					</template>
				</Popup>
				<FilterPopup
					v-if="!isSavedFilterProject({id: projectId})"
					v-model="params"
					:view-id="viewId"
					:project-id="projectId"
					@update:modelValue="taskList.loadTasks()"
				/>
			</div>
		</template>

		<template #default>
			<div
				:class="{'is-loading': loading, 'is-refreshing': refreshing}"
				class="loader-container project-table-body"
				:aria-busy="refreshing || undefined"
			>
				<Card
					:padding="false"
					:has-content="false"
					class="project-table-card"
				>
					<LoadError
						v-if="loadFailed"
						class="project-table-load-error"
						:message="$t('project.tasksLoadError')"
						:retry="taskList.loadTasks"
					/>
					<div
						class="project-table-scroll"
						tabindex="0"
						role="region"
						:aria-label="$t('project.table.title')"
					>
						<table class="table has-actions is-hoverable is-fullwidth mbe-0">
							<thead>
								<tr>
									<th
										v-if="activeColumns.index"
										:aria-sort="ariaSort('index')"
									>
										<Sort
											:order="sortBy.index"
											label="#"
											@click="sort('index', $event)"
										>
											#
										</Sort>
									</th>
									<th
										v-if="activeColumns.done"
										:aria-sort="ariaSort('done')"
									>
										<Sort
											:order="sortBy.done"
											:label="$t('task.attributes.done')"
											@click="sort('done', $event)"
										>
											{{ $t('task.attributes.done') }}
										</Sort>
									</th>
									<th v-if="activeColumns.project">
										{{ $t('task.attributes.project') }}
									</th>
									<th
										v-if="activeColumns.title"
										:aria-sort="ariaSort('title')"
									>
										<Sort
											:order="sortBy.title"
											:label="$t('task.attributes.title')"
											@click="sort('title', $event)"
										>
											{{ $t('task.attributes.title') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.priority"
										:aria-sort="ariaSort('priority')"
									>
										<Sort
											:order="sortBy.priority"
											:label="$t('task.attributes.priority')"
											@click="sort('priority', $event)"
										>
											{{ $t('task.attributes.priority') }}
										</Sort>
									</th>
									<th v-if="activeColumns.labels">
										{{ $t('task.attributes.labels') }}
									</th>
									<th v-if="activeColumns.assignees">
										{{ $t('task.attributes.assignees') }}
									</th>
									<th
										v-if="activeColumns.dueDate"
										:aria-sort="ariaSort('due_date')"
									>
										<Sort
											:order="sortBy.due_date"
											:label="$t('task.attributes.dueDate')"
											@click="sort('due_date', $event)"
										>
											{{ $t('task.attributes.dueDate') }}
										</Sort>
									</th>
									<th v-if="activeColumns.commentCount">
										{{ $t('task.attributes.commentCount') }}
									</th>
									<th
										v-if="activeColumns.startDate"
										:aria-sort="ariaSort('start_date')"
									>
										<Sort
											:order="sortBy.start_date"
											:label="$t('task.attributes.startDate')"
											@click="sort('start_date', $event)"
										>
											{{ $t('task.attributes.startDate') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.endDate"
										:aria-sort="ariaSort('end_date')"
									>
										<Sort
											:order="sortBy.end_date"
											:label="$t('task.attributes.endDate')"
											@click="sort('end_date', $event)"
										>
											{{ $t('task.attributes.endDate') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.percentDone"
										:aria-sort="ariaSort('percent_done')"
									>
										<Sort
											:order="sortBy.percent_done"
											:label="$t('task.attributes.percentDone')"
											@click="sort('percent_done', $event)"
										>
											{{ $t('task.attributes.percentDone') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.doneAt"
										:aria-sort="ariaSort('done_at')"
									>
										<Sort
											:order="sortBy.done_at"
											:label="$t('task.attributes.doneAt')"
											@click="sort('done_at', $event)"
										>
											{{ $t('task.attributes.doneAt') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.created"
										:aria-sort="ariaSort('created')"
									>
										<Sort
											:order="sortBy.created"
											:label="$t('task.attributes.created')"
											@click="sort('created', $event)"
										>
											{{ $t('task.attributes.created') }}
										</Sort>
									</th>
									<th
										v-if="activeColumns.updated"
										:aria-sort="ariaSort('updated')"
									>
										<Sort
											:order="sortBy.updated"
											:label="$t('task.attributes.updated')"
											@click="sort('updated', $event)"
										>
											{{ $t('task.attributes.updated') }}
										</Sort>
									</th>
									<th v-if="activeColumns.createdBy">
										{{ $t('task.attributes.createdBy') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="t in tasks"
									:key="t.id"
								>
									<td v-if="activeColumns.index">
										<RouterLink :to="taskDetailRoutes[t.id]">
											{{ getTaskIdentifier(t) }}
										</RouterLink>
									</td>
									<td v-if="activeColumns.done">
										<!-- A routine's state is today's check-in; its done flag stays false. -->
										<RoutineStatusChip
											v-if="isRoutineTask(t)"
											:task="t"
										/>
										<Done
											v-else
											:is-done="t.done"
											variant="small"
										/>
									</td>
									<td v-if="activeColumns.project">
										<RouterLink
											v-if="projectList.projects[t.project_id]"
											:to="{ name: 'project.index', params: { projectId: t.project_id } }"
										>
											{{ projectList.projects[t.project_id].title }}
										</RouterLink>
									</td>
									<td v-if="activeColumns.title">
										<TaskGlanceTooltip :task="t">
											<RouterLink :to="taskDetailRoutes[t.id]">
												{{ t.title }}
											</RouterLink>
										</TaskGlanceTooltip>
										<TaskHierarchySummary :task="t" />
									</td>
									<td v-if="activeColumns.priority">
										<PriorityLabel
											:priority="t.priority"
											:show-all="true"
										/>
									</td>
									<td v-if="activeColumns.labels">
										<Labels :labels="t.labels" />
									</td>
									<td v-if="activeColumns.assignees">
										<AssigneeList
											v-if="t.assignees.length > 0"
											:assignees="t.assignees"
											:avatar-size="24"
											:inline="true"
										/>
									</td>
									<DateTableCell
										v-if="activeColumns.dueDate"
										:date="t.due_date"
									/>
									<td v-if="activeColumns.commentCount">
										<CommentCount :task="t" />
									</td>
									<DateTableCell
										v-if="activeColumns.startDate"
										:date="t.start_date"
									/>
									<DateTableCell
										v-if="activeColumns.endDate"
										:date="t.end_date"
									/>
									<td v-if="activeColumns.percentDone">
										{{ Math.round(t.percent_done * 100) }}%
									</td>
									<DateTableCell
										v-if="activeColumns.doneAt"
										:date="t.done_at"
									/>
									<DateTableCell
										v-if="activeColumns.created"
										:date="t.created"
									/>
									<DateTableCell
										v-if="activeColumns.updated"
										:date="t.updated"
									/>
									<td v-if="activeColumns.createdBy">
										<User
											:avatar-size="24"
											:show-username="false"
											:user="t.created_by ?? {}"
										/>
									</td>
								</tr>
								<tr v-if="loaded && tasks.length === 0">
									<td
										:colspan="visibleColumnCount"
										class="project-table-empty"
									>
										{{ $t('project.table.empty') }}
									</td>
								</tr>
							</tbody>
						</table>
					</div>

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
import {computed, ref, type ComponentPublicInstance, type Ref, watch} from 'vue'

import {useStorage} from '@vueuse/core'

import ProjectWrapper from '@/components/project/ProjectWrapper.vue'
import Done from '@/components/misc/Done.vue'
import User from '@/components/misc/User.vue'
import PriorityLabel from '@/components/tasks/partials/PriorityLabel.vue'
import Labels from '@/components/tasks/partials/Labels.vue'
import TaskGlanceTooltip from '@/components/tasks/partials/TaskGlanceTooltip.vue'
import TaskHierarchySummary from '@/components/tasks/partials/TaskHierarchySummary.vue'
import DateTableCell from '@/components/tasks/partials/DateTableCell.vue'
import CommentCount from '@/components/tasks/partials/CommentCount.vue'
import RoutineStatusChip from '@/components/tasks/partials/RoutineStatusChip.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import Sort from '@/components/tasks/partials/Sort.vue'
import FilterPopup from '@/components/project/partials/FilterPopup.vue'
import Pagination from '@/components/misc/Pagination.vue'
import Popup from '@/components/misc/Popup.vue'

import type {SortBy} from '@/composables/useTaskList'
import {useTaskList} from '@/composables/useTaskList'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {TaskResponse} from '@/client/queries/tasks'
import {useTableSort} from '@/composables/useTableSort'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import AssigneeList from '@/components/tasks/partials/AssigneeList.vue'
import {getTaskIdentifier} from '@/helpers/task'
import {isRoutineTask} from '@/helpers/taskRoutine'
import { camelCase } from 'change-case'
import {isSavedFilterProject} from '@/client/queries/projects'
import {useProjects} from '@/composables/useProjects'

const props = defineProps<{
	isLoadingProject: boolean,
	projectId: number,
	viewId: number,
}>()

const projectList = useProjects()

const columnsTrigger = ref<ComponentPublicInstance | null>(null)
const columnsTriggerEl = computed<HTMLElement | null>(() => (columnsTrigger.value?.$el as HTMLElement) ?? null)

const ACTIVE_COLUMNS_DEFAULT = {
	index: true,
	done: true,
	project: false,
	title: true,
	priority: false,
	labels: true,
	assignees: true,
	dueDate: true,
	startDate: false,
	endDate: false,
	percentDone: false,
	created: false,
	updated: false,
	createdBy: false,
	doneAt: false,
	commentCount: false,
}

const SORT_BY_DEFAULT: SortBy = {
	index: 'desc',
}

const activeColumns = useStorage('tableViewColumns', {...ACTIVE_COLUMNS_DEFAULT})

function resetColumns() {
	activeColumns.value = {...ACTIVE_COLUMNS_DEFAULT}
}
const sortBy = useStorage<SortBy>('tableViewSortBy', {...SORT_BY_DEFAULT})

const taskList = useTaskList(
	() => props.projectId, 
	() => props.viewId, 
	sortBy.value,
	() => ['comment_count', 'is_unread'],
)

const {
	params,
	totalPages,
	currentPage,
	sortByParam,
} = taskList
const tasks: Ref<TaskResponse[]> = taskList.tasks
const {loadFailed, loaded} = taskList
const visibleColumnCount = computed(() => Math.max(1, Object.values(activeColumns.value).filter(Boolean).length))
// The spinner overlay is for a first load only; a background refetch keeps the rows usable.
const loading = useDelayedLoading(() => taskList.loading.value && tasks.value.length === 0)
const refreshing = useDelayedLoading(() => taskList.loading.value && tasks.value.length > 0)

watch(
	() => activeColumns.value,
	() => setActiveColumnsSortParam(),
	{deep: true},
)

const {sort, ariaSort} = useTableSort<keyof SortBy>(sortBy, setActiveColumnsSortParam)

function setActiveColumnsSortParam() {
	sortByParam.value = (Object.keys(sortBy.value) as (keyof SortBy)[])
		.filter(prop => activeColumns.value[camelCase(prop) as keyof typeof activeColumns.value])
		.reduce<SortBy>((obj, key) => {
			obj[key] = sortBy.value[key]
			return obj
		}, {})
}

// TODO: re-enable opening task detail in modal
// const router = useRouter()
const taskDetailRoutes = computed(() => Object.fromEntries(
	tasks.value.map(({id}) => ([
		id,
		{
			name: 'task.detail',
			params: {id},
			// state: { backdropView: router.currentRoute.value.fullPath },
		},
	])),
))
</script>

<style lang="scss" scoped>
.project-table-body {
	transition: opacity var(--motion-fast) var(--ease-standard);

	&.is-refreshing {
		opacity: .85;
	}
}

.project-table-load-error {
	margin: var(--space-3);
}

.project-table-empty {
	padding: var(--space-4);
	color: var(--text-secondary);
	text-align: center;
}

// The table scrolls inside its own region, so the sticky header stays in view and phones never scroll the page sideways.
.project-table-scroll {
	max-block-size: max(20rem, calc(100dvh - var(--header-height) - 10rem));
	overflow: auto;
	overscroll-behavior-inline: contain;

	&:focus-visible {
		@include focus-ring;
		outline-offset: -2px;
	}
}

.table {
	background: transparent;
	font-size: var(--text-md);

	th,
	td {
		padding: var(--space-2) var(--space-3);
		border-color: var(--border-subtle);
		vertical-align: middle;
	}

	thead th {
		position: sticky;
		inset-block-start: 0;
		z-index: var(--layer-sticky);
		border-block-end-width: 0;
		background: var(--surface);
		box-shadow: inset 0 -1px 0 var(--border-default);
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
	}

	tbody tr:hover {
		background-color: var(--surface-hover);
	}

	tbody tr:last-child td {
		border-block-end-width: 0;
	}

	.user {
		margin: 0;
	}
}

.columns-filter {
	margin: 0;
	min-inline-size: min(15rem, calc(100vw - 2 * var(--space-4)));

	:deep(.card-content) {
		max-block-size: min(24rem, 60dvh);
		overflow-y: auto;
	}

	:deep(.card-content .content) {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: 0 var(--space-3);
	}

	:deep(.card-footer) {
		justify-content: flex-end;
	}
}

.link-share-view .card {
	border: none;
	box-shadow: none;
}
</style>
