<template>
	<ProjectWrapper
		class="project-kanban"
		:is-loading-project="isLoadingProject"
		:project-id="projectId"
		:view-id
	>
		<template #header>
			<KanbanDisplaySwitch
				:mode="displayMode"
				:any-collapsed="anyGroupCollapsed"
				:can-collapse="groupKeys.length > 0"
				@update:mode="setDisplayMode"
				@collapseAll="setGroupsCollapsed(groupKeys, true)"
				@expandAll="setGroupsCollapsed([...collapsedGroups], false)"
			/>
			<div class="filter-container">
				<FilterPopup
					v-if="!isSavedFilterProject(project)"
					v-model="params"
					:view-id="viewId"
					:project-id="projectId"
					@update:modelValue="updateFilters"
				/>
			</div>
		</template>

		<template #default>
			<div
				class="kanban-view"
				@keydown.esc="exitFocusByKey"
			>
				<KanbanFocusBar
					v-if="grouped && focusId !== null"
					:index="hierarchy"
					:focus-id="focusId"
					:shown="focusShown"
					:loaded="loadedCount"
					:can-load-more="anyBucketHasMore"
					:loading="loadingEverywhere"
					@exit="exitFocus"
					@loadMore="loadMoreEverywhere"
				/>
				<div
					ref="boardRef"
					:class="{ 'is-loading': showInitialLoading, 'is-dragging': drag || dragBucket }"
					class="kanban kanban-bucket-container loader-container"
					:style="boardOffset === null ? undefined : {'--kanban-offset': `${boardOffset}px`}"
				>
					<BucketDraggable
						v-bind="dragOptions"
						:handle="grouped ? '.bucket-header' : undefined"
						:model-value="buckets"
						group="buckets"
						:disabled="!canWrite || newTaskInputFocused"
						tag="ul"
						:item-key="({id}: BucketResponse) => `bucket${id}`"
						:component-data="bucketDraggableComponentData"
						@update:modelValue="updateBuckets"
						@end="updateBucketPosition"
						@start="() => dragBucket = true"
					>
						<template #item="{element: bucket, index: bucketIndex }">
							<li
								class="bucket"
								:class="{
									'is-collapsed': collapsedBuckets[bucket.id],
									'is-done-bucket': isDoneBucket(bucket),
								}"
								:data-bucket-id="bucket.id"
							>
								<div
									class="bucket-header"
									@click="() => unCollapseBucket(bucket)"
								>
									<BaseButton
										v-if="collapsedBuckets[bucket.id]"
										class="bucket-expand"
										:aria-expanded="false"
										:aria-label="$t('project.kanban.expandBucket', {title: bucket.title})"
										@click.stop="() => unCollapseBucket(bucket)"
									>
										<Icon
											icon="angle-right"
											class="bucket-expand__icon"
										/>
									</BaseButton>
									<span
										v-if="isDoneBucket(bucket)"
										v-tooltip="$t('project.kanban.doneBucketHint')"
										class="bucket-done-cue"
										role="img"
										:aria-label="$t('project.kanban.doneBucket')"
									>
										<Icon icon="check-double" />
									</span>
									<h2
										:key="`title-${titleResetKey}`"
										:ref="(el) => setBucketTitleRef(bucket.id, el as HTMLElement | null)"
										class="title input"
										:contenteditable="(bucketTitleEditable && canWrite && !collapsedBuckets[bucket.id]) ? true : undefined"
										:spellcheck="false"
										@keydown.enter.prevent.stop="!$event.isComposing && ($event.target as HTMLElement).blur()"
										@keydown.esc.prevent.stop="cancelBucketTitleEdit"
										@blur="saveBucketTitle(bucket.id, ($event.target as HTMLElement).textContent as string)"
										@click="focusBucketTitle"
									>
										{{ bucket.title }}
									</h2>
									<span
										v-if="bucket.limit > 0 || alwaysShowBucketTaskCount"
										:class="{'is-max': isBucketFull(bucket)}"
										class="limit"
									>
										<Icon
											v-if="isBucketFull(bucket)"
											icon="exclamation-circle"
											class="limit__icon"
										/>
										{{ bucket.limit > 0 ? `${bucket.count}/${bucket.limit}` : bucket.count }}
										<span
											v-if="isBucketFull(bucket)"
											class="is-sr-only"
										>{{ $t('project.kanban.limitFull') }}</span>
									</span>
									<Dropdown
										v-if="canWrite"
										class="is-right options"
										trigger-icon="ellipsis-v"
										:trigger-label="$t('project.kanban.bucketOptions')"
										@click.stop
										@close="() => showSetLimitInput = false"
									>
										<template #default="{close}">
											<div
												v-if="showSetLimitInput"
												class="field has-addons"
											>
												<div class="control">
													<input
														v-focus.always
														:value="bucket.limit"
														class="input"
														type="number"
														min="0"
														:aria-label="$t('project.kanban.limitLabel')"
														@keyup.esc="() => showSetLimitInput = false"
														@keyup.enter="() => {setBucketLimit(bucket.id, true); showSetLimitInput = false}"
														@input="event => updateLimitDraft(bucket.id, (event.target as HTMLInputElement).value)"
													>
												</div>
												<div class="control">
													<XButton
														v-cy="'setBucketLimit'"
														:aria-label="$t('misc.save')"
														:disabled="bucket.limit < 0"
														:icon="['far', 'save']"
														:shadow="false"
														@click="() => {setBucketLimit(bucket.id, true); showSetLimitInput = false}"
													/>
												</div>
											</div>
											<DropdownItem
												v-else
												@click.stop="showSetLimitInput = true"
											>
												{{
													$t('project.kanban.limit', {limit: bucket.limit > 0 ? bucket.limit : $t('misc.notSet')})
												}}
											</DropdownItem>
											<DropdownItem
												v-if="!collapsedBuckets[bucket.id]"
												icon="pen"
												@click.stop="() => startRenameBucket(bucket.id, close)"
											>
												{{ $t('project.kanban.rename') }}
											</DropdownItem>
											<DropdownItem
												v-tooltip="$t('project.kanban.doneBucketHintExtended')"
												:icon-class="{'has-text-success': bucket.id === view?.done_bucket_id}"
												icon="check-double"
												@click.stop="toggleDoneBucket(bucket)"
											>
												{{ $t('project.kanban.doneBucket') }}
											</DropdownItem>
											<DropdownItem
												v-tooltip="$t('project.kanban.defaultBucketHint')"
												:icon-class="{'has-text-primary': bucket.id === view?.default_bucket_id}"
												icon="th"
												@click.stop="toggleDefaultBucket(bucket)"
											>
												{{ $t('project.kanban.defaultBucket') }}
											</DropdownItem>
											<DropdownItem
												v-if="collapsedBuckets[bucket.id]"
												icon="angle-right"
												@click.stop="() => {unCollapseBucket(bucket); close()}"
											>
												{{ $t('project.kanban.expand') }}
											</DropdownItem>
											<DropdownItem
												v-else
												icon="angles-up"
												@click.stop="() => {collapseBucket(bucket); close()}"
											>
												{{ $t('project.kanban.collapse') }}
											</DropdownItem>
											<DropdownItem
												v-tooltip="buckets.length <= 1 ? $t('project.kanban.deleteLast') : ''"
												class="has-text-danger"
												:class="{'is-disabled': buckets.length <= 1}"
												icon-class="has-text-danger"
												icon="trash-alt"
												@click.stop="() => deleteBucketModal(bucket.id)"
											>
												{{ $t('misc.delete') }}
											</DropdownItem>
										</template>
									</Dropdown>
								</div>

								<!-- Groups reuse the column's scroller, paging and footer, but nothing in them is draggable. -->
								<TaskDraggable
									v-bind="dragOptions"
									:handle="taskDragHandle"
									:delay="isTouchDevice ? 300 : 1000"
									:model-value="grouped ? [] : bucket.tasks"
									:group="{name: 'tasks', put: !grouped && shouldAcceptDrop(bucket) && !dragBucket}"
									:disabled="!canWrite || grouped"
									:data-bucket-index="bucketIndex"
									tag="ul"
									:item-key="(task: TaskResponse) => `bucket${bucket.id}-task${task.id}`"
									:component-data="getTaskDraggableTaskComponentData(bucket)"
									@update:modelValue="(tasks) => updateTasks(bucket.id, tasks)"
									@start="handleTaskDragStart"
									@end="updateTaskPosition"
								>
									<template
										v-if="grouped"
										#header
									>
										<li
											key="kanban-tree"
											class="kanban-tree-host"
										>
											<KanbanColumnTree
												:bucket-id="bucket.id"
												:nodes="columnTrees.get(bucket.id)?.nodes ?? []"
												:hidden="columnTrees.get(bucket.id)?.hidden ?? 0"
												:focused="focusId !== null"
												:loaded="bucket.tasks.length"
												:count="bucket.count"
												:loading="loadingBucket === bucket.id"
												@loadMore="loadMoreInBucket(bucket.id)"
											/>
										</li>
									</template>
									<template #footer>
										<li
											v-if="canCreateTasks"
											class="bucket-footer"
										>
											<div
												v-if="showNewTaskInput === bucket.id"
												class="field"
											>
												<div
													class="control"
													:class="{'is-loading': showTaskLoading}"
												>
													<input
														v-model="newTaskText"
														v-focus.always
														class="input"
														:disabled="initialLoading || taskLoading || undefined"
														:placeholder="$t('project.kanban.addTaskPlaceholder')"
														:aria-label="$t('project.kanban.addTask')"
														type="text"
														@focusout="toggleShowNewTaskInput(bucket.id)"
														@focusin="() => newTaskInputFocused = true"
														@keyup.enter="addTaskToBucket(bucket.id)"
														@keyup.esc="toggleShowNewTaskInput(bucket.id)"
													>
												</div>
												<p
													v-if="newTaskError[bucket.id] && newTaskText === ''"
													class="help is-danger"
												>
													{{ $t('project.create.addTitleRequired') }}
												</p>
											</div>
											<template v-else>
												<XButton
													class="is-fullwidth"
													:shadow="false"
													icon="plus"
													variant="secondary"
													:disabled="isBucketFull(bucket)"
													@click="toggleShowNewTaskInput(bucket.id)"
												>
													{{
														bucket.tasks.length === 0 ? $t('project.kanban.addTask') : $t('project.kanban.addAnotherTask')
													}}
												</XButton>
												<p
													v-if="isBucketFull(bucket)"
													class="bucket-limit-note"
												>
													{{ $t('project.kanban.limitReachedShort') }}
												</p>
											</template>
										</li>
									</template>

									<template #item="{element: task}">
										<li
											class="task-item"
											:data-task-id="task.id"
										>
											<span
												v-if="canWrite && isTouchDevice"
												class="handle"
												@click="openTask(task)"
												@touchstart.passive="onHandleTouchStart"
												@touchmove.passive="onHandleTouchMove"
											/>
											<KanbanCard
												class="kanban-card"
												:task="task"
												:project-id="projectId"
												@taskCompletedRecurring="handleRecurringTaskCompletion"
											/>
										</li>
									</template>
								</TaskDraggable>
							</li>
						</template>
					</BucketDraggable>

					<div
						v-if="canWrite && !initialLoading && buckets.length > 0"
						class="bucket new-bucket"
					>
						<input
							v-if="showNewBucketInput"
							v-model="newBucketTitle"
							v-focus.always
							:class="{'is-loading': showInitialLoading}"
							:disabled="showInitialLoading || undefined"
							class="input"
							:placeholder="$t('project.kanban.addBucketPlaceholder')"
							:aria-label="$t('project.kanban.addBucket')"
							type="text"
							@blur="() => showNewBucketInput = false"
							@keyup.enter="createNewBucket"
							@keyup.esc="($event.target as HTMLInputElement).blur()"
						>
						<XButton
							v-else
							:shadow="false"
							class="is-transparent is-fullwidth"
							variant="secondary"
							icon="plus"
							@click="() => showNewBucketInput = true"
						>
							{{ $t('project.kanban.addBucket') }}
						</XButton>
					</div>
				</div>

				<Modal
					danger
					:enabled="showBucketDeleteModal"
					:confirm-label="$t('project.kanban.deleteBucketConfirm')"
					@close="showBucketDeleteModal = false"
					@submit="deleteBucket"
				>
					<template #header>
						<span>{{ $t('project.kanban.deleteHeaderBucket') }}</span>
					</template>

					<template #text>
						<p>
							{{ $t('project.kanban.deleteBucketText1') }}<br>
							{{ $t('project.kanban.deleteBucketText2') }}
						</p>
					</template>
				</Modal>
			</div>
		</template>
	</ProjectWrapper>
</template>

<script setup lang="ts">
import {useKanban} from '@/composables/useKanban'
import {bucketHasMore, kanbanKeys, type BucketResponse} from '@/client/queries/kanban'
import {removeTaskFromBoard} from '@/client/queries/taskCache'
import {useUpdateTaskPositionMutation, useMoveTaskMutation} from '@/client/queries/taskMutations'
import {
	useCreateBucketMutation,
	useDeleteBucketMutation,
	useUpdateBucketMutation,
	useLoadBucketPageMutation,
} from '@/client/queries/kanbanMutations'
import {computed, nextTick, onActivated, onBeforeUnmount, ref, watch, toRef} from 'vue'
import {useEventListener, useMediaQuery, useResizeObserver} from '@vueuse/core'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {useRouter} from 'vue-router'
import {useRouteQuery} from '@vueuse/router'
import {useI18n} from 'vue-i18n'
import {draggableFor} from '@/components/base/Draggable'
import type {SortableEvent} from 'sortablejs'

import {PERMISSIONS as Permissions} from '@/constants/permissions'

import {useQuickAddTask} from '@/composables/useQuickAddTask'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useTaskDragState} from '@/composables/useTaskDragState'
import {useAuthStore} from '@/stores/auth'

import ProjectWrapper from '@/components/project/ProjectWrapper.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import FilterPopup from '@/components/project/partials/FilterPopup.vue'
import KanbanCard from '@/components/tasks/partials/KanbanCard.vue'
import KanbanColumnTree from '@/components/project/views/kanban/KanbanColumnTree.vue'
import KanbanDisplaySwitch from '@/components/project/views/kanban/KanbanDisplaySwitch.vue'
import KanbanFocusBar from '@/components/project/views/kanban/KanbanFocusBar.vue'
import {useKanbanGrouping} from '@/components/project/views/kanban/useKanbanGrouping'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'

import {
	type CollapsedBuckets,
	getCollapsedBucketState,
	saveCollapsedBucketState,
} from '@/helpers/saveCollapsedBucketState'
import {calculateItemPosition} from '@/helpers/calculateItemPosition'
import {isRoutineTask} from '@/helpers/taskRoutine'
import {error, success, translatedError} from '@/message'

import {getSavedFilterIdFromProjectId, isSavedFilterProject} from '@/client/queries/projects'
import {savedFilterQuery} from '@/client/queries/savedFilters'
import {useCurrentProject} from '@/composables/useCurrentProject'
import {useProjects} from '@/composables/useProjects'
import {useTaskDragToProject} from '@/composables/useTaskDragToProject'
import type {TaskFilterParams, TaskResponse} from '@/client/queries/tasks'
import type {ProjectView, Task} from '@/client/generated'
import {createProjectViewUpdate, useUpdateProjectViewMutation} from '@/client/queries/projectViews'

const props = defineProps<{
	isLoadingProject: boolean,
	projectId: number,
	viewId: number,
}>()
const BucketDraggable = draggableFor<BucketResponse>()
const TaskDraggable = draggableFor<TaskResponse>()

const projectId = toRef(props, 'projectId')

const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
const dragOptions = computed(() => ({
	// sortable options
	animation: reducedMotion.value ? 0 : 150,
	ghostClass: 'ghost',
	dragClass: 'task-dragging',
	delayOnTouchOnly: true,
	delay: 1000,
} as const))

const MIN_SCROLL_HEIGHT_PERCENT = 0.25

const {t} = useI18n({useScope: 'global'})
const isCurrentProject = ({projectId: id}: {projectId: number}) => projectId.value === id
const updateDefaultBucket = useUpdateProjectViewMutation(t('project.kanban.defaultBucketSavedSuccess'), isCurrentProject)
const updateDoneBucket = useUpdateProjectViewMutation(t('project.kanban.doneBucketSavedSuccess'), isCurrentProject)

const {createNewTask, isLoading: quickAddLoading} = useQuickAddTask()
const {setDraggedTask} = useTaskDragState()
const authStore = useAuthStore()

const alwaysShowBucketTaskCount = computed(() => authStore.settings.frontend_settings.always_show_bucket_task_count)
const {handleTaskDropToProject} = useTaskDragToProject()
const positionMutation = useUpdateTaskPositionMutation()
const moveMutation = useMoveTaskMutation()

const savedFilter = useQuery(computed(() => savedFilterQuery(getSavedFilterIdFromProjectId(projectId.value)))).data

const taskContainerRefs = ref<{ [id: number]: HTMLElement }>({})

const drag = ref(false)
const dragBucket = ref(false)
const sourceBucket = ref(0)

const showBucketDeleteModal = ref(false)
const bucketToDelete = ref(0)
const bucketTitleEditable = ref(false)

const newTaskText = ref('')
const showNewTaskInput = ref<number | null>(null)

const newBucketTitle = ref('')
const showNewBucketInput = ref(false)
const newTaskError = ref<{ [id: number]: boolean }>({})
const newTaskInputFocused = ref(false)

const showSetLimitInput = ref(false)
const collapsedBuckets = ref<CollapsedBuckets>({})

const bucketTitleRefs = new Map<number, HTMLElement>()
const titleResetKey = ref(0)
let skipNextTitleSave = false

// The board fills the viewport below whatever sits above it (toolbar, banners), so buckets scroll on their own.
const boardRef = ref<HTMLElement | null>(null)
const boardOffset = ref<number | null>(null)

function measureBoard() {
	const el = boardRef.value
	// A cached (keep-alive) board is detached and would measure as if it were at the top of the page.
	if (!el || !el.isConnected) {
		return
	}
	const top = el.getBoundingClientRect().top + window.scrollY
	const main = el.closest('main')
	const bottomPadding = main ? parseFloat(getComputedStyle(main).paddingBlockEnd) || 0 : 0
	boardOffset.value = Math.max(0, Math.round(top + bottomPadding))
}

useResizeObserver(
	computed(() => [
		boardRef.value?.closest<HTMLElement>('.project-kanban') ?? null,
		boardRef.value?.closest<HTMLElement>('main') ?? null,
	]),
	() => requestAnimationFrame(measureBoard),
)
useEventListener(window, 'resize', measureBoard, {passive: true})
onActivated(() => nextTick(measureBoard))

// URL-synchronized filter parameters
const filter = useRouteQuery('filter')
const s = useRouteQuery('s')

const params = ref<TaskFilterParams>({
	sort_by: [],
	order_by: [],
	filter: '',
	filter_include_nulls: false,
	q: '',
})

watch([filter, s], ([filterValue, sValue]) => {
	params.value.filter = String(filterValue ?? '')
	params.value.q = String(sValue ?? '')
}, { immediate: true })

function updateFilters(newParams: TaskFilterParams) {
	// Update all params
	params.value = { ...newParams }
	
	// Sync only filter and s to URL
	filter.value = newParams.filter || undefined
	s.value = newParams.q || undefined
}

const getTaskDraggableTaskComponentData = computed(() => (bucket: BucketResponse) => {
	return {
		ref: (el: HTMLElement) => setTaskContainerRef(bucket.id, el),
		onScroll: (event: Event) => handleTaskContainerScroll(bucket.id, event.target as HTMLElement),
		type: 'transition-group',
		name: !drag.value ? 'move-card' : null,
		class: [
			'tasks',
			{'dragging-disabled': !canWrite.value},
		],
	}
})

const bucketDraggableComponentData = computed(() => ({
	type: 'transition-group',
	name: !dragBucket.value ? 'move-bucket' : null,
	class: [
		'kanban-bucket-container',
		{'dragging-disabled': !canWrite.value},
	],
}))
const {currentProject: project} = useCurrentProject()
const view = computed(() => project.value?.views.find(view => view.id === props.viewId) as ProjectView || null)
const canWrite = computed(() =>
	typeof project.value?.max_permission === 'number' &&
	project.value.max_permission > Permissions.READ &&
	view.value?.bucket_configuration_mode === 'manual',
)
const canCreateTasks = computed(() => canWrite.value && projectId.value > 0)
// Completing is a task edit: it does not depend on the columns being manual. Favorites and saved filters
// are pseudo projects whose own permission says nothing about each task's source project.
const projectList = useProjects()
function canEditTask(task: Task) {
	const source = projectId.value > 0 ? project.value : projectList.projects[task.project_id ?? 0]
	return typeof source?.max_permission === 'number' && source.max_permission > Permissions.READ
}

const isTouchDevice = ref(false)
if (typeof window !== 'undefined') {
	isTouchDevice.value = !window.matchMedia('(hover: hover) and (pointer: fine)').matches
}
const taskDragHandle = computed(() => isTouchDevice.value ? '.handle' : undefined)

const router = useRouter()
const touchStartY = ref(0)

function openTask(task: TaskResponse) {
	router.push({
		name: 'task.detail',
		params: {id: task.id},
		state: {backdropView: router.currentRoute.value.fullPath},
	})
}

function onHandleTouchStart(e: TouchEvent) {
	touchStartY.value = e.touches[0].clientY
}

function onHandleTouchMove(e: TouchEvent) {
	if (drag.value) return

	const currentY = e.touches[0].clientY
	const deltaY = touchStartY.value - currentY
	const scrollContainer = (e.target as HTMLElement).closest('.tasks') as HTMLElement | null
	if (scrollContainer) {
		scrollContainer.scrollTop += deltaY
		touchStartY.value = currentY
	}
}

const boardParams = computed(() => ({...params.value, filter_timezone: authStore.settings.timezone}))
const board = useKanban(projectId, () => props.viewId, boardParams)
const queryClient = useQueryClient()
const buckets = board.buckets
const createBucketMutation = useCreateBucketMutation()
const deleteBucketMutation = useDeleteBucketMutation(t('project.kanban.deleteBucketSuccess'))
const updateBucketMutation = useUpdateBucketMutation()
const saveBucketTitleMutation = useUpdateBucketMutation(t('project.kanban.bucketTitleSavedSuccess'))
const saveBucketLimitMutation = useUpdateBucketMutation(t('project.kanban.bucketLimitSavedSuccess'))
const bucketPageMutation = useLoadBucketPageMutation()
const getBucketById = (id: number) => buckets.value.find(bucket => bucket.id === id)

const {
	displayMode,
	setDisplayMode,
	grouped,
	collapsedGroups,
	setGroupsCollapsed,
	groupKeys,
	anyGroupCollapsed,
	focusId,
	hierarchy,
	columnTrees,
	loadedCount,
	focusShown,
	exitFocus,
	exitFocusByKey,
} = useKanbanGrouping({
	project: projectId,
	view: () => props.viewId,
	buckets,
	filterSignature: () => params.value.filter || params.value.q
		? JSON.stringify([params.value.filter, params.value.q])
		: null,
	canMove: canWrite,
	canComplete: canEditTask,
	doneBucketId: computed(() => view.value?.done_bucket_id || undefined),
	board: boardRef,
	move: moveTaskToColumn,
	recurringDone: handleRecurringTaskCompletion,
})
const anyBucketHasMore = computed(() => board.data.value?.buckets.some(bucketHasMore) ?? false)

type BucketPatch = {id: number} & Partial<Pick<BucketResponse, 'title' | 'limit' | 'position'>>

// The update is a PUT: the fields the caller does not touch come from the cached bucket.
function updateBucket(patch: BucketPatch, mutation = updateBucketMutation) {
	const cached = getBucketById(patch.id)
	if (!cached) return
	return mutation.mutateAsync({
		project: projectId.value,
		view: props.viewId,
		bucket: {title: cached.title, limit: cached.limit, position: cached.position, ...patch},
	})
}
const initialLoading = board.isLoading
const projectIdWithFallback = computed<number>(() => project.value?.id || projectId.value)

const taskLoading = computed(() => quickAddLoading.value || positionMutation.isPending.value)
const showInitialLoading = useDelayedLoading(initialLoading)
const showTaskLoading = useDelayedLoading(() => initialLoading.value || taskLoading.value)

watch(
	projectId,
	id => {
		if (!id) {
			return
		}
		collapsedBuckets.value = getCollapsedBucketState(id)
	},
	{immediate: true},
)

function setTaskContainerRef(id: number, el: HTMLElement) {
	if (!el) return
	taskContainerRefs.value[id] = el
}

function handleTaskContainerScroll(id: number, el: HTMLElement) {
	if (!el) {
		return
	}
	const scrollTopMax = el.scrollHeight - el.clientHeight
	const threshold = el.scrollTop + el.scrollTop * MIN_SCROLL_HEIGHT_PERCENT
	if (scrollTopMax > threshold) {
		return
	}

	// Mid-drag the copy in `buckets` is one task short, which would look like a missing page.
	const bucket = board.data.value?.buckets.find(item => item.id === id)
	if (bucketPageMutation.isPending.value || !bucket || !bucketHasMore(bucket)) return
	bucketPageMutation.mutate({
		project: projectId.value,
		view: props.viewId,
		params: boardParams.value,
		bucket: id!,
		page: (board.data.value?.pages[id!] ?? 1) + 1,
	})
}

function loadNextBucketPage(id: number) {
	const bucket = board.data.value?.buckets.find(item => item.id === id)
	if (!bucket || !bucketHasMore(bucket)) return Promise.resolve()
	return bucketPageMutation.mutateAsync({
		project: projectId.value,
		view: props.viewId,
		params: boardParams.value,
		bucket: id,
		page: (board.data.value?.pages[id] ?? 1) + 1,
	})
}

// Groups can be collapsed below the scroll threshold, so paging there is also an explicit action.
const loadingBucket = ref<number | null>(null)
async function loadMoreInBucket(id: number) {
	if (loadingBucket.value !== null) return
	loadingBucket.value = id
	try {
		await loadNextBucketPage(id)
	} catch { /* The mutation reports the error. */ } finally {
		loadingBucket.value = null
	}
}

// One more page per column and click: a family can spread over every column, but the work stays bounded.
const loadingEverywhere = ref(false)
async function loadMoreEverywhere() {
	if (loadingEverywhere.value) return
	loadingEverywhere.value = true
	try {
		const ids = (board.data.value?.buckets ?? []).filter(bucketHasMore).map(bucket => bucket.id)
		for (const id of ids) await loadNextBucketPage(id)
	} catch { /* The mutation reports the error. */ } finally {
		loadingEverywhere.value = false
	}
}

// The explicit counterpart of a drag in Groups mode. It keeps the stored position, which Cards mode reorders.
async function moveTaskToColumn(task: TaskResponse, from: number, to: number) {
	const target = getBucketById(to)
	if (!canWrite.value || !target || from === to) return
	if (isDoneBucket(target) && isRoutineTask(task)) {
		error(translatedError('task.routine.doneBucketBlocked'))
		return
	}
	if (isBucketFull(target)) {
		error(translatedError('project.kanban.bucketLimitReached'))
		return
	}
	const project = projectId.value
	const view = props.viewId
	try {
		const result = await moveMutation.mutateAsync({project, view, bucket: to, task})
		const landed = getBucketById(result.bucket_id ?? to) ?? target
		success({message: t('project.kanban.hierarchy.moved', {title: task.title, bucket: landed.title})})
		if (project !== projectId.value || view !== props.viewId) return
		await nextTick()
		boardRef.value
			?.querySelector<HTMLElement>(`[data-tree-task="${task.id}"][data-tree-bucket="${landed.id}"] .kanban-tree-row__title`)
			?.focus()
	} catch { /* The mutation reports the error. */ }
}

function updateTasks(bucketId: number, tasks: BucketResponse['tasks']) {
	if (!board.dragBuckets.value) board.startDrag()
	board.dragBuckets.value = board.dragBuckets.value!.map(bucket => bucket.id === bucketId
		? {...bucket, tasks}
		: bucket)
}

async function updateTaskPosition(e: SortableEvent & {originalEvent?: MouseEvent}) {
	const project = projectId.value
	const view = props.viewId
	drag.value = false
	try {
		const {moved} = await handleTaskDropToProject(e, task => {
			// A moved task stays in a pseudo-project board (favorites, saved filters) until the board is re-read.
			if (project < 0) {
				removeTaskFromBoard(queryClient, kanbanKeys.board(project, view, boardParams.value), task.id)
			}
		})
		if (moved) return
		const bucket = buckets.value[Number(e.to.dataset.bucketIndex)]
		const index = bucket?.tasks.findIndex(task => task.id === Number(e.item.dataset.taskId)) ?? -1
		if (!bucket || index < 0) return
		const task = bucket.tasks[index]
		const before = bucket.tasks[index - 1]
		const after = bucket.tasks[index + 1]
		// The done bucket would mark the task done; a routine is checked in per day instead. endDrag puts the card back.
		if (bucket.id !== sourceBucket.value && isDoneBucket(bucket) && isRoutineTask(task)) {
			error(translatedError('task.routine.doneBucketBlocked'))
			return
		}
		if (bucket.id !== sourceBucket.value) {
			const result = await moveMutation.mutateAsync({project, view, bucket: bucket.id, task})
			if (result.bucket_id !== undefined && result.bucket_id !== bucket.id) return
		}
		await positionMutation.mutateAsync({
			taskId: task.id,
			project_view_id: view,
			position: calculateItemPosition(before?.position ?? null, after?.position ?? null),
		})

		// Dropping at the top gives position 0, which the next task may already have.
		if (index === 0 && after?.position === 0) {
			const afterAfter = bucket.tasks[index + 2]
			await positionMutation.mutateAsync({
				taskId: after.id,
				project_view_id: view,
				position: calculateItemPosition(0, afterAfter?.position ?? null),
			})
		}
	} catch { return } finally {
		board.endDrag()
	}
}

function toggleShowNewTaskInput(bucketId: number) {
	if (initialLoading.value || taskLoading.value) {
		return
	}
	showNewTaskInput.value = showNewTaskInput.value === bucketId 
		? null
		: bucketId
	newTaskInputFocused.value = false
}

async function addTaskToBucket(bucketId: number) {
	if (newTaskText.value === '') {
		newTaskError.value[bucketId] = true
		return
	}
	newTaskError.value[bucketId] = false

	await createNewTask({
		title: newTaskText.value,
		bucket_id: bucketId,
		project_id: projectIdWithFallback.value,
	})
	newTaskText.value = ''
	scrollTaskContainerToTop(bucketId)

	const bucket = getBucketById(bucketId)
	if (bucket && bucket.limit && bucket.count >= bucket.limit) {
		toggleShowNewTaskInput(bucketId)
	}
}

function scrollTaskContainerToTop(bucketId: number) {
	const bucketEl = taskContainerRefs.value[bucketId]
	if (!bucketEl) {
		return
	}
	bucketEl.scrollTop = 0
}

async function createNewBucket() {
	if (newBucketTitle.value === '') {
		return
	}

	await createBucketMutation.mutateAsync({
		project: projectId.value,
		view: props.viewId,
		bucket: {title: newBucketTitle.value},
	})
	newBucketTitle.value = ''
}

function deleteBucketModal(bucketId: number) {
	if (buckets.value.length <= 1) {
		return
	}

	bucketToDelete.value = bucketId
	showBucketDeleteModal.value = true
}

// Stays open while the request runs and after a failure (the mutation reports it); closes once this bucket is gone.
async function deleteBucket() {
	const bucket = bucketToDelete.value
	try {
		await deleteBucketMutation.mutateAsync({
			project: projectId.value,
			view: props.viewId,
			bucket,
		})
	} catch {
		return
	}
	if (bucketToDelete.value === bucket) showBucketDeleteModal.value = false
}

/** This little helper allows us to drag a bucket around at the title without focusing on it right away. */
async function focusBucketTitle(e: Event) {
	bucketTitleEditable.value = true
	await nextTick()
	const target = e.target as HTMLInputElement
	target.focus()
}

function setBucketTitleRef(bucketId: number, el: HTMLElement | null) {
	if (el) {
		bucketTitleRefs.set(bucketId, el)
	} else {
		bucketTitleRefs.delete(bucketId)
	}
}

async function startRenameBucket(bucketId: number, closeMenu: () => void) {
	closeMenu()
	bucketTitleEditable.value = true
	await nextTick()
	const title = bucketTitleRefs.get(bucketId)
	if (!title) {
		return
	}
	title.focus()
	window.getSelection()?.selectAllChildren(title)
}

// Escape restores the saved title: skip the save the blur would trigger, then re-render the heading.
function cancelBucketTitleEdit(event: KeyboardEvent) {
	if (event.isComposing) {
		return
	}
	skipNextTitleSave = true
	;(event.target as HTMLElement).blur()
	titleResetKey.value++
}

async function saveBucketTitle(bucketId: number, bucketTitle: string) {
	if (skipNextTitleSave) {
		skipNextTitleSave = false
		bucketTitleEditable.value = false
		return
	}

	const bucket = getBucketById(bucketId)
	if (bucket?.title === bucketTitle) {
		bucketTitleEditable.value = false
		return
	}
	
	await updateBucket({
		id: bucketId,
		title: bucketTitle,
	}, saveBucketTitleMutation)
	bucketTitleEditable.value = false
}

function isDoneBucket(bucket: BucketResponse) {
	return bucket.id !== 0 && view.value?.done_bucket_id === bucket.id
}

function isBucketFull(bucket: BucketResponse) {
	return bucket.limit > 0 && bucket.count >= bucket.limit
}

function updateBuckets(value: BucketResponse[]) {
	// (1) buckets get updated in store and tasks positions get invalidated
	board.dragBuckets.value = value
}

function handleRecurringTaskCompletion() {
	// Only reload if we're in a saved filter and the filter contains date fields
	if (!isSavedFilterProject(project.value)) {
		return
	}

	const savedFilterQueryString = savedFilter.value?.filters.filter ?? ''
	const filterContainsDateFields = savedFilterQueryString.includes('due_date') ||
		savedFilterQueryString.includes('start_date') ||
		savedFilterQueryString.includes('end_date')
		
	if (filterContainsDateFields) {
		// Reload the kanban board to refresh tasks that now match/don't match the filter
		board.refetch()
	}
}

// TODO: fix type
async function updateBucketPosition(e: { item: HTMLElement }) {
	// (2) bucket positon is changed
	dragBucket.value = false

	// Sortable reports a DOM index which can point past the last bucket, for example while a
	// deleted bucket is still leaving the transition group. The buckets are already updated here.
	const movedBucketId = parseInt(e.item.dataset.bucketId ?? '', 10)
	const bucketIndex = buckets.value.findIndex(b => b.id === movedBucketId)

	if (bucketIndex === -1) {
		board.endDrag()
		return
	}

	const bucketBefore = buckets.value[bucketIndex - 1] ?? null
	const bucketAfter = buckets.value[bucketIndex + 1] ?? null

	try {
		await updateBucket({
			id: movedBucketId,
			position: calculateItemPosition(
				bucketBefore !== null ? bucketBefore.position : null,
				bucketAfter !== null ? bucketAfter.position : null,
			),
		})
	} catch { /* Mutation reports the error. */ } finally { board.endDrag() }
}

async function saveBucketLimit(bucketId: number, limit: number) {
	if (limit < 0) {
		return
	}

	await updateBucket({
		id: bucketId,
		limit,
	}, saveBucketLimitMutation)
}

const setBucketLimitCancel = ref<ReturnType<typeof setTimeout> | null>(null)
// What was typed into the open limit input. A template ref inside the bucket loop would hold an
// array of inputs, and reading `.value` off it sent NaN, which the API stored as no limit.
const limitDraft = ref<{bucket: number, value: string}>()

function cancelBucketLimit() {
	if (setBucketLimitCancel.value !== null) clearTimeout(setBucketLimitCancel.value)
	setBucketLimitCancel.value = null
}

function updateLimitDraft(bucketId: number, value: string) {
	limitDraft.value = {bucket: bucketId, value}
	void setBucketLimit(bucketId)
}

async function setBucketLimit(bucketId: number, now: boolean = false) {
	cancelBucketLimit()
	if (limitDraft.value?.bucket !== bucketId) return
	const text = limitDraft.value.value.trim()
	// Empty clears the limit; anything else has to be a whole number of at least zero.
	const limit = text === '' ? 0 : Number(text)
	if (!Number.isSafeInteger(limit) || limit < 0) return

	if (now) {
		limitDraft.value = undefined
		return saveBucketLimit(bucketId, limit)
	}

	setBucketLimitCancel.value = setTimeout(() => {
		setBucketLimitCancel.value = null
		void saveBucketLimit(bucketId, limit).catch(() => { /* The mutation reports failed autosaves. */ })
	}, 2500)
}

// A pending limit belongs to the board it was typed on, never to the next one.
watch(() => [props.projectId, props.viewId], () => {
	cancelBucketLimit()
	limitDraft.value = undefined
})
onBeforeUnmount(cancelBucketLimit)

function shouldAcceptDrop(bucket: BucketResponse) {
	return (
		// When dragging from a bucket who has its limit reached, dragging should still be possible
		bucket.id === sourceBucket.value ||
		// If there is no limit set, dragging & dropping should always work
		bucket.limit === 0 ||
		// Disallow dropping to buckets which have their limit reached
		bucket.count < bucket.limit
	)
}

function dragstart(bucket: BucketResponse) {
	drag.value = true
	sourceBucket.value = bucket.id
}

function handleTaskDragStart(e: SortableEvent) {
	const taskId = Number(e.item.dataset.taskId)
	const bucketIndex = Number(e.from.dataset.bucketIndex)
	const bucket = buckets.value[bucketIndex]
	const task = bucket?.tasks.find(t => t.id === taskId)

	if (task) {
		board.startDrag()
		setDraggedTask(task)
	}
	dragstart(bucket)
}

function toggleDefaultBucket(bucket: BucketResponse) {
	const currentView = view.value
	if (!currentView?.id) {
		return
	}
	const defaultBucketId = currentView.default_bucket_id === bucket.id
		? 0
		: bucket.id

	updateDefaultBucket.mutate({
		projectId: projectId.value,
		viewId: currentView.id,
		view: createProjectViewUpdate({...currentView, default_bucket_id: defaultBucketId}),
	})
}

function toggleDoneBucket(bucket: BucketResponse) {
	const currentView = view.value
	if (!currentView?.id) {
		return
	}
	const doneBucketId = currentView.done_bucket_id === bucket.id
		? 0
		: bucket.id

	updateDoneBucket.mutate({
		projectId: projectId.value,
		viewId: currentView.id,
		view: createProjectViewUpdate({...currentView, done_bucket_id: doneBucketId}),
	})
}

function collapseBucket(bucket: BucketResponse) {
	collapsedBuckets.value[bucket.id] = true
	saveCollapsedBucketState(projectIdWithFallback.value, collapsedBuckets.value)
}

function unCollapseBucket(bucket: BucketResponse) {
	if (!collapsedBuckets.value[bucket.id]) {
		return
	}

	collapsedBuckets.value[bucket.id] = false
	saveCollapsedBucketState(projectIdWithFallback.value, collapsedBuckets.value)
}
</script>

<style lang="scss" scoped>
.control.is-loading {
	&::after {
		inset-block-start: 30%;
		inset-inline-end: 50%;
		transform: translate(-50%, 0);

		--loader-border-color: var(--grey-500);
	}
}
</style>

<style lang="scss">
.kanban {
	--kanban-bucket-width: 18rem;
	--kanban-collapsed-width: 2.75rem;
	--kanban-gap: var(--space-3);

	gap: var(--kanban-gap);
	overflow: auto hidden;
	block-size: calc(100vh - var(--kanban-offset, 13rem));
	block-size: calc(100dvh - var(--kanban-offset, 13rem));
	min-block-size: 16rem;
	padding-block-end: var(--space-2);

	&:focus,
	.bucket .tasks:focus {
		box-shadow: none;
	}

	// Phones show one lane at a time with the next one peeking; the board scrolls, never the page.
	@media screen and (max-width: $tablet) {
		--kanban-bucket-width: min(85vw, 20rem);
		--kanban-gap: var(--space-2);

		scroll-snap-type: x mandatory;

		// Snapping undoes sortable's small auto-scroll steps, so the board never scrolls while dragging.
		&.is-dragging {
			scroll-snap-type: none;
		}
	}

	&-bucket-container {
		display: flex;
		align-items: stretch;
		gap: var(--kanban-gap);
		list-style: none;
	}

	.ghost {
		position: relative;

		* {
			opacity: 0;
		}

		&::after {
			content: '';
			position: absolute;
			display: block;
			inset-block: var(--space-1);
			inset-inline: var(--space-2);
			border: 1px dashed var(--border-strong);
			border-radius: $radius;
			background: var(--surface-hover);
		}
	}

	.bucket {
		position: relative;
		display: flex;
		flex: 0 0 var(--kanban-bucket-width);
		flex-direction: column;
		inline-size: var(--kanban-bucket-width);
		min-block-size: 0;
		max-block-size: 100%;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		overflow: hidden; // keeps the rounded corners on the scrolling task list

		@media screen and (max-width: $tablet) {
			scroll-snap-align: start;
		}

		// Done lanes carry a success rule on top plus the check icon in the header.
		&.is-done-bucket {
			border-block-start: 2px solid var(--success);
		}

		.tasks {
			flex: 1 1 auto;
			min-block-size: 0;
			overflow: hidden auto;
			list-style: none;
		}

		.task-item {
			position: relative;
			padding: var(--space-1) var(--space-2);

			&:first-of-type {
				padding-block-start: var(--space-1);
			}

			&:last-of-type {
				padding-block-end: var(--space-2);
			}

			.handle {
				position: absolute;
				inset: 0;
				z-index: 1;
				opacity: 0;
				touch-action: none;
				-webkit-touch-callout: none;
				user-select: none;
			}
		}

		&.new-bucket {
			align-self: flex-start;
			border-style: dashed;
			border-color: var(--border-default);
			background: transparent;

			.input {
				border: 0;
				background: var(--surface);
			}

			.button.is-outlined {
				inline-size: 100%;
				border-color: transparent;
				background: transparent;
				color: var(--text-secondary);
				justify-content: flex-start;

				&:hover {
					border-color: transparent;
					background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
					color: var(--text-primary);
				}
			}
		}

		// A narrow lane with the title written vertically; logical sizes keep it in place in RTL.
		&.is-collapsed {
			flex-basis: var(--kanban-collapsed-width);
			inline-size: var(--kanban-collapsed-width);
			align-self: flex-start;
			cursor: pointer;

			.bucket-header {
				flex-direction: column;
				justify-content: flex-start;
				gap: var(--space-2);
				min-block-size: 0;
				padding: var(--space-1) 0 var(--space-2);
			}

			// Logical sizes follow the heading's own writing mode: its inline axis is vertical here.
			.title.input {
				flex: 0 1 auto;
				inline-size: auto;
				block-size: auto;
				max-inline-size: 14rem;
				padding: var(--space-2) var(--space-1);
				writing-mode: vertical-rl;
				white-space: nowrap;
			}

			.tasks,
			.bucket-footer {
				display: none;
			}
		}
	}

	.bucket-header {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: var(--space-1);
		min-block-size: 2.75rem;
		padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2);

		// Block, not Bulma's inline-flex .input, so a long title can end in an ellipsis.
		.title.input {
			display: block;
			flex: 1 1 auto;
			min-inline-size: 0;
			block-size: auto;
			margin: 0;
			padding: var(--space-1) var(--space-2);
			overflow: hidden;
			border-color: transparent;
			border-radius: var(--radius-sm);
			background: transparent;
			box-shadow: none;
			color: var(--text-primary);
			font-size: var(--text-md);
			font-weight: var(--weight-semibold);
			line-height: var(--leading-tight);
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;

			&[contenteditable] {
				cursor: text;
				white-space: normal;
			}

			&[contenteditable]:hover {
				background: var(--surface-hover);
			}

			&[contenteditable]:focus {
				background: var(--surface);
				border-color: var(--input-border-color);
				white-space: normal;
				@include focus-ring;
				outline-offset: 0;
			}
		}

		.limit {
			display: inline-flex;
			flex-shrink: 0;
			align-items: center;
			gap: var(--space-1);
			padding: 0 var(--space-2);
			border: 1px solid var(--border-subtle);
			border-radius: var(--radius-full);
			background: var(--surface);
			color: var(--text-secondary);
			font-size: var(--text-xs);
			font-variant-numeric: tabular-nums;
			font-weight: var(--weight-semibold);
			line-height: 1.5rem;

			&.is-max {
				border-color: hsla(var(--danger-h), var(--danger-s), var(--danger-l), .45);
				background: var(--tint-danger);
				color: var(--danger-text);
			}
		}

		.limit__icon {
			font-size: var(--text-2xs);
		}

		.options {
			flex-shrink: 0;
		}

		.dropdown-trigger {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-inline-size: var(--control-height-sm);
			min-block-size: var(--control-height-sm);
			padding: 0;
			border-radius: var(--radius-sm);
			color: var(--text-secondary);

			&:hover {
				background: var(--surface-hover);
				color: var(--text-primary);
			}
		}
	}

	.bucket-done-cue {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--success);
		font-size: var(--text-sm);
	}

	.bucket-expand {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-inline-size: var(--control-height-sm);
		min-block-size: var(--control-height-sm);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);

		&:hover {
			background: var(--surface-hover);
			color: var(--text-primary);
		}

		&:focus-visible {
			@include focus-ring;
			outline-offset: 0;
		}
	}

	[dir='rtl'] & .bucket-expand__icon {
		transform: scaleX(-1);
	}

	.bucket-footer {
		position: sticky;
		inset-block-end: 0;
		z-index: 2;
		block-size: min-content;
		padding: var(--space-1) var(--space-2) var(--space-2);
		background-color: var(--surface-sunken);
		// At fractional device pixel ratios the scroll clip ends below the sticky footer, showing a sliver of tasks
		box-shadow: 0 1px 0 var(--surface-sunken);

		// Outranks XButton's scoped secondary styles: a quiet row action, not a bordered button.
		.button.is-outlined {
			border-color: transparent;
			background-color: transparent;
			color: var(--text-secondary);
			justify-content: flex-start;

			&:hover {
				border-color: transparent;
				background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
				color: var(--text-primary);
			}
		}
	}

	.bucket-limit-note {
		margin-block-start: var(--space-1);
		padding-inline: var(--space-2);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
	}
}

.kanban .bucket .bucket-footer .button,
.kanban .bucket.new-bucket .button {
	box-shadow: none;
}

.move-card-move {
	transition: transform var(--motion-base) var(--ease-standard);
}

.move-card-leave-from,
.move-card-leave-to,
.move-card-leave-active {
	display: none;
}
</style>
