<template>
	<div
		:data-task-id="task.id"
		:data-project-id="task.project_id"
	>
		<div
			ref="taskRoot"
			:class="{'is-loading': isLoading, 'is-done': task.done, 'has-project-context': showProjectContext, 'is-routine': isRoutine}"
			class="task loader-container single-task"
			tabindex="-1"
			:data-is-overdue="isOverdue || undefined"
			@click="openTaskDetail"
			@keyup.enter="openTaskDetail"
		>
			<span
				v-tooltip="checkboxTooltip"
				class="single-task__check"
			>
				<FancyCheckbox
					:model-value="isRoutine ? routineDone : (task.done ?? false)"
					:disabled="isArchived || disabled || !canMarkAsDone || routinePaused || routineSaving"
					:aria-label="checkboxLabel"
					@update:modelValue="toggleDone"
					@click.stop
				/>
			</span>

			<div
				:class="{'done': task.done, 'show-project': showProjectContext}"
				class="tasktext"
			>
				<span class="tasktext__title">
					<ColorBubble
						v-if="task.hex_color !== ''"
						:color="getHexColor(task.hex_color)"
						class="tasktext__task-color"
					/>
					<TaskGlanceTooltip :task="task">
						<RouterLink
							ref="taskLinkRef"
							:to="taskDetailRoute"
							class="task-link"
						>
							{{ task.title }}
						</RouterLink>
					</TaskGlanceTooltip>
				</span>
				<span
					v-if="showProjectContext"
					class="tasktext__context"
				>
					<ColorBubble
						v-if="projectColor !== '' && baseStore.currentProjectId !== task.project_id"
						:color="projectColor"
						class="tasktext__project-color"
					/>
					<RouterLink
						v-tooltip="$t('task.detail.belongsToProject', {project: project.title})"
						:to="{ name: 'project.index', params: { projectId: task.project_id } }"
						class="task-project"
						@click.stop
					>
						{{ project.title }}
					</RouterLink>
				</span>
			</div>

			<div class="single-task__meta">
				<RoutineStatusChip
					v-if="isRoutine"
					:task="task"
					class="single-task__routine"
				/>

				<PriorityLabel
					:priority="task.priority ?? 0"
					:done="task.done"
					class="single-task__priority"
				/>

				<Labels
					v-if="(task.labels?.length ?? 0) > 0"
					class="labels"
					:labels="task.labels ?? []"
					:max="2"
					compact
				/>

				<span
					v-if="hasIcons"
					class="single-task__icons"
				>
					<span
						v-if="(task.attachments?.length ?? 0) > 0"
						class="project-task-icon"
						role="img"
						:aria-label="$t('task.attributes.attachment', (task.attachments?.length ?? 0))"
					>
						<Icon icon="paperclip" />
					</span>
					<span
						v-if="hasDescription"
						class="project-task-icon is-mirrored-rtl"
						role="img"
						:aria-label="$t('task.attributes.description')"
					>
						<Icon icon="align-left" />
					</span>
					<span
						v-if="isRepeating"
						class="project-task-icon"
						role="img"
						:aria-label="$t('task.attributes.repeat')"
					>
						<Icon icon="history" />
					</span>
					<CommentCount
						:task="task"
						class="project-task-icon"
					/>
				</span>

				<ChecklistSummary
					:task="task"
					compact
				/>

				<span
					v-if="percentDone > 0"
					class="single-task__progress"
				>
					<ProgressBar
						:value="percentDone"
						:aria-label="$t('task.attributes.percentDone')"
					/>
					<span
						class="single-task__percent"
						aria-hidden="true"
					>{{ percentDone }}%</span>
				</span>

				<AssigneeList
					v-if="(task.assignees?.length ?? 0) > 0"
					:assignees="task.assignees ?? []"
					:avatar-size="20"
					:inline="true"
					:show-usernames="false"
					:max="3"
					class="single-task__assignees"
				/>

				<Popup
					v-if="task.due_date && +new Date(task.due_date) > 0"
					placement="bottom-start"
					:anchor="dueDateTriggerEl"
					sheet-on-mobile
					:sheet-title="$t('task.deferDueDate.title')"
				>
					<template #trigger="{toggle, isOpen}">
						<BaseButton
							ref="dueDateTrigger"
							v-tooltip="formatDateLong(task.due_date)"
							class="dueDate"
							:class="{'is-overdue': isOverdue, 'is-today': isDueToday}"
							:aria-label="dueDateLabel"
							:aria-expanded="isOpen ? 'true' : 'false'"
							@click.prevent.stop="toggle()"
						>
							<Icon
								:icon="isOverdue ? 'exclamation-circle' : ['far', 'calendar-alt']"
								class="dueDate__icon"
								aria-hidden="true"
							/>
							<time :datetime="formatISO(task.due_date)">{{ dueDateFormatted }}</time>
						</BaseButton>
					</template>
					<template #content="{isOpen}">
						<DeferTask
							v-if="isOpen"
							:model-value="task"
						/>
					</template>
				</Popup>
			</div>

			<div class="single-task__end">
				<BaseButton
					:class="{'is-favorite': task.is_favorite}"
					class="favorite"
					@click.stop="toggleFavorite"
				>
					<span class="is-sr-only">{{
						task.is_favorite ? $t('task.detail.actions.unfavorite') : $t('task.detail.actions.favorite')
					}}</span>
					<Icon
						v-if="task.is_favorite"
						icon="star"
					/>
					<Icon
						v-else
						:icon="['far', 'star']"
					/>
				</BaseButton>
				<slot />
			</div>

			<TaskHierarchySummary
				class="list-task-hierarchy"
				:task="task"
				:inline-tree="nestedChildren.length > 0"
				:expanded="childrenExpanded"
				@toggle="childrenExpanded = !childrenExpanded"
			/>
		</div>
		<div
			v-if="childrenExpanded && nestedChildren.length"
			class="subtask-branch"
			:style="depth >= 4 ? {'margin-inline-start': '0'} : undefined"
		>
			<SingleTaskInProject
				v-for="subtask in nestedChildren"
				:key="subtask.id"
				:the-task="subtask"
				:disabled="disabled"
				:is-archived="isArchived"
				:can-mark-as-done="canMarkAsDone"
				:all-tasks="allTasks"
				:hierarchy="resolvedHierarchy"
				:depth="depth + 1"
				:style="depth >= 4 ? {'margin-inline-start': '0'} : undefined"
				class="subtask-nested"
				@taskUpdated="emit('taskUpdated', $event)"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import {ref, watch, computed} from 'vue'
import {useI18n} from 'vue-i18n'

import {getHexColor} from '@/helpers/task'
import type {Task as ITask} from '@/client/generated'

import PriorityLabel from '@/components/tasks/partials/PriorityLabel.vue'
import Labels from '@/components/tasks/partials/Labels.vue'
import TaskGlanceTooltip from '@/components/tasks/partials/TaskGlanceTooltip.vue'
import DeferTask from '@/components/tasks/partials/DeferTask.vue'
import ChecklistSummary from '@/components/tasks/partials/ChecklistSummary.vue'
import TaskHierarchySummary from './TaskHierarchySummary.vue'
import {buildTaskHierarchy, type TaskHierarchy} from '@/helpers/taskHierarchy'
import CommentCount from '@/components/tasks/partials/CommentCount.vue'
import RoutineStatusChip from '@/components/tasks/partials/RoutineStatusChip.vue'

import ProgressBar from '@/components/misc/ProgressBar.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import ColorBubble from '@/components/misc/ColorBubble.vue'
import Popup from '@/components/misc/Popup.vue'


import {formatDisplayDate, formatISO, formatDateLong} from '@/helpers/time/formatDate'
import {success} from '@/message'

import {useProjects} from '@/composables/useProjects'
import {useUpdateTaskMutation, useFavoriteTaskMutation} from '@/client/queries/taskMutations'
import {taskKeys} from '@/client/queries/tasks'
import {useQueryClient} from '@tanstack/vue-query'
import AssigneeList from '@/components/tasks/partials/AssigneeList.vue'
import {playPopSound} from '@/helpers/playPop'
import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import {TASK_REPEAT_MODES} from '@/types/IRepeatMode'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {dueGroupOf} from '@/helpers/workspaceTasks'
import {resolveUserTimezone} from '@/helpers/time/userTimezone'
import {useAuthStore} from '@/stores/auth'
import {useBaseStore} from '@/stores/base'
import {useRoutineCheckIn} from '@/composables/useRoutineCheckIn'
import {isLegacyRoutine, routineOf, routineStatus} from '@/helpers/taskRoutine'

const props = withDefaults(defineProps<{
	theTask: ITask,
	isArchived?: boolean,
	showProject?: boolean,
	disabled?: boolean,
	canMarkAsDone?: boolean,
	allTasks?: ITask[],
	hierarchy?: TaskHierarchy,
	depth?: number,
}>(), {
	isArchived: false,
	showProject: false,
	disabled: false,
	canMarkAsDone: true,
	allTasks: () => [],
	hierarchy: undefined,
	depth: 0,
})

const emit = defineEmits<{
	'taskUpdated': [task: ITask],
}>()

const resolvedHierarchy = computed(() => props.hierarchy ?? buildTaskHierarchy(props.allTasks))
const nestedChildren = computed(() => resolvedHierarchy.value.children.get(props.theTask.id!) ?? [])
const childrenExpanded = ref(true)
watch(() => props.theTask.id, () => {childrenExpanded.value = true})

const {t} = useI18n({useScope: 'global'})

const task = computed(() => props.theTask)

const isRepeating = computed(() => (task.value.repeat_after ?? 0) > 0
	|| ((task.value.repeat_after ?? 0) === 0
		&& task.value.repeat_mode === TASK_REPEAT_MODES.REPEAT_MODE_MONTH))

const projectList = useProjects()
const queryClient = useQueryClient()
const updateTask = useUpdateTaskMutation(true)
const favoriteTask = useFavoriteTaskMutation()
const routineCheckIn = useRoutineCheckIn()
const routineSaving = computed(() => routineCheckIn.isPending(task.value.id))
const isLoading = useDelayedLoading(() => updateTask.isPending.value || favoriteTask.isPending.value || routineSaving.value)

const project = computed(() => projectList.projects[task.value.project_id ?? 0])
const projectColor = computed(() => project.value?.hex_color ?? '')

const baseStore = useBaseStore()

// Overviews always name the project; inside a project only tasks from elsewhere (saved filters,
// favourites) do. The id is enough: no project request per row.
const showProjectContext = computed(() => Boolean(project.value) && (props.showProject
	|| baseStore.currentProjectId !== task.value.project_id))

const checkboxLabel = computed(() => {
	const label = isRoutine.value
		? t(routine.value && isLegacyRoutine(routine.value)
			? 'task.routine.checkInLabel' : 'routineSchedule.completeTask', {task: task.value.title})
		: t('task.detail.markAsDone', {task: task.value.title})
	// The tooltip on a disabled checkbox never reaches keyboard or screen reader users.
	if (!props.canMarkAsDone) return `${label}. ${t('task.readOnlyCheckbox')}`
	return routinePaused.value ? `${label}. ${t('task.routine.pausedNoCheckIn')}` : label
})

const checkboxTooltip = computed(() => {
	if (!props.canMarkAsDone) return t('task.readOnlyCheckbox')
	return routinePaused.value ? t('task.routine.pausedNoCheckIn') : ''
})

const hasDescription = computed(() => !isEditorContentEmpty(task.value.description ?? ''))
const hasIcons = computed(() => (task.value.attachments?.length ?? 0) > 0
	|| hasDescription.value
	|| isRepeating.value
	|| (task.value.comment_count ?? 0) > 0)
const percentDone = computed(() => Math.round((task.value.percent_done ?? 0) * 100))

const taskDetailRoute = computed(() => ({
	name: 'task.detail',
	params: {id: task.value.id},
	// TODO: re-enable opening task detail in modal
	// state: { backdropView: router.currentRoute.value.fullPath },
}))

const {now} = useGlobalNow()

// Relative dates ("in 2 hours") follow the shared minute clock: one timer for all rows, not one per row.
const dueDateFormatted = computed(() => {
	void now.value
	return task.value.due_date ? formatDisplayDate(task.value.due_date) : ''
})

// An enabled routine is checked in for today instead of being marked done; task.done never moves with it.
const routine = computed(() => routineOf(task.value))
const isRoutine = computed(() => routine.value?.enabled === true)
const routineDone = computed(() => routineStatus(routine.value, now.value) === 'done')
const routinePaused = computed(() => routineStatus(routine.value, now.value) === 'paused')

function toggleDone(checked: boolean) {
	if (isRoutine.value) {
		void routineCheckIn.setCheckedIn(task.value, checked)
		return
	}
	void markAsDone(checked)
}

// A routine's state is today's check-in, so an old due date never marks it overdue.
const isOverdue = computed(() => (
	!isRoutine.value &&
	!task.value.done &&
	task.value.due_date !== null &&
	new Date(task.value.due_date ?? 0).getTime() > 0 &&
	new Date(task.value.due_date ?? 0).getTime() <= now.value.getTime()
))

const authStore = useAuthStore()
const isDueToday = computed(() => !task.value.done
	&& !isOverdue.value
	&& dueGroupOf(task.value.due_date, now.value, resolveUserTimezone(authStore.settings?.timezone)) === 'today')

const dueDateLabel = computed(() => {
	const due = t('task.detail.due', {at: dueDateFormatted.value})
	return isOverdue.value ? `${t('workspace.groups.overdue')}: ${due}` : due
})

let oldTask: ITask

async function markAsDone(checked: boolean, wasReverted: boolean = false) {
	if (!wasReverted) oldTask = {...task.value}

	// Fire the request immediately and with the intended done value snapshotted, so a re-render or
	// teardown during the animation delay can neither drop the save nor make it send a stale state.
	const source = wasReverted && isRepeating.value ? oldTask : task.value
	const updatePromise = updateTask.mutateAsync({
		...source,
		id: source.id!,
		done: checked,
	}).catch(() => undefined)

	const finish = async () => {
		const newTask = await updatePromise
		if (!newTask) return

		if (wasReverted) {
			// The list may have dropped this row already (Home and Upcoming hide done tasks), so it cannot tell
			// its parent; refresh the open task lists so the task comes back, and confirm the undo.
			void queryClient.invalidateQueries({queryKey: taskKeys.lists, refetchType: 'active'})
			success({message: checked ? t('task.doneSuccess') : t('task.undoneSuccess')})
			return
		}

		if (checked) {
			playPopSound()
		}
		emit('taskUpdated', newTask)

		let message = t('task.doneSuccess')
		if (!task.value.done && !isRepeating.value) {
			message = t('task.undoneSuccess')
		}

		success({message}, [{
			title: t('task.undo'),
			callback: () => undoDone(checked),
		}])
	}

	if (checked && !prefersReducedMotion()) {
		setTimeout(finish, 300) // Delay only the follow-up to show the animation when marking a task as done
	} else if (checked) {
		await finish()
	} else {
		await finish() // Don't delay it when un-marking it as it doesn't have an animation the other way around
	}
}

function prefersReducedMotion() {
	return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function undoDone(checked: boolean) {
	markAsDone(!checked, true)
}

async function toggleFavorite() {
	let updated
	try {
		updated = await favoriteTask.mutateAsync({...task.value, id: task.value.id!})
	} catch {
		return // The star stays as it was; the mutation reports the error.
	}
	emit('taskUpdated', updated)
}

const taskRoot = ref<HTMLElement | null>(null)
const dueDateTrigger = ref<InstanceType<typeof BaseButton> | null>(null)
const dueDateTriggerEl = computed<HTMLElement | null>(() => dueDateTrigger.value?.$el ?? null)
const taskLinkRef = ref<InstanceType<typeof BaseButton> | null>(null)

function hasTextSelected() {
	const isTextSelected = window.getSelection()?.toString()
	return !(typeof isTextSelected === 'undefined' || isTextSelected === '' || isTextSelected === '\n')
}

function openTaskDetail(event: MouseEvent | KeyboardEvent) {
	if (event.target instanceof HTMLElement) {
		const isInteractiveElement = event.target.closest('a, button, label, input[type="checkbox"], .favorite, [role="button"]')
		if (isInteractiveElement || hasTextSelected()) {
			return
		}
	}

	taskLinkRef.value?.$el.click()
}

defineExpose({
	focus: () => taskRoot.value?.focus(),
	click: (e: MouseEvent | KeyboardEvent) => openTaskDetail(e),
})
</script>

<style lang="scss" scoped>
// Row grid: checkbox | title (+ muted project line) | meta rail | star.
// The meta rail drops under the title on phones; the hierarchy summary always gets its own line.
.single-task {
	display: grid;
	grid-template-columns: auto minmax(min(12rem, 100%), 1fr) minmax(0, auto) auto;
	grid-template-areas:
		"check text meta end"
		".     hier hier hier";
	// Checkbox, meta rail and star line up with the first title line; the project line sits below.
	align-items: start;
	column-gap: var(--space-2);
	min-block-size: 2.25rem;
	padding: var(--space-1) var(--space-2);
	border-radius: $radius;
	color: var(--text-primary);
	cursor: pointer;

	// Enough block padding for the 44px checkbox and star targets to stay inside the row.
	@media (pointer: coarse) {
		min-block-size: var(--target-min);
		padding-block: var(--space-2);
	}

	@media screen and (max-width: $tablet) {
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas:
			"check text end"
			".     meta meta"
			".     hier hier";
		padding-block: var(--space-2);
	}

	&:hover,
	&:has(:focus-visible) {
		background-color: var(--surface-hover);
	}

	// Rows sit flush in a card, so the j/k focus ring is drawn inside the row.
	&:focus-visible {
		outline-offset: -2px;
	}

	&.loader-container.is-loading::after {
		inset-block-start: calc(50% - 1rem);
		inset-inline-start: calc(50% - 1rem);
		inline-size: 2rem;
		block-size: 2rem;
		border-inline-start-color: var(--border-strong);
		border-block-end-color: var(--border-strong);
	}
}

.single-task__check {
	// Layout footprint of the checkbox: the bare icon on fine pointers; a title-line square on coarse
	// ones, so its 44px target spills only into the row padding and the column gap, never onto the title.
	--check-footprint: 1.125rem;

	grid-area: check;
	display: inline-flex;
	align-items: center;
	min-block-size: 1.75rem;

	@media (pointer: coarse) {
		--check-footprint: 1.75rem;
	}

	:deep(.fancy-checkbox) {
		// The default stroke is ~1.6:1; checkboxes need 3:1 against the row.
		--stroke-color: var(--text-tertiary);

		display: inline-flex;
		padding: 0;

		.fancy-checkbox__content {
			display: none;
		}

		// FancyCheckbox sizes the label to --target-min; negative margins keep that real target while
		// the row lays it out at the footprint, so rows keep their height and the title its position.
		.base-checkbox__label {
			justify-content: center;
			margin: calc((var(--check-footprint) - var(--target-min)) / 2);
		}
	}
}

.tasktext {
	grid-area: text;
	display: flex;
	flex-direction: column;
	justify-content: center;
	min-inline-size: 0;
	line-height: var(--leading-tight);
}

.tasktext__title {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	min-block-size: 1.75rem;

	:deep(.task-glance-trigger) {
		display: block;
		min-inline-size: 0;
	}
}

.task-link {
	display: block;
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-base);
	text-overflow: ellipsis;
	white-space: nowrap;

	&:hover {
		color: var(--text-primary);
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: .2em;
	}

	@media screen and (max-width: $tablet) {
		display: -webkit-box;
		white-space: normal;
		overflow-wrap: anywhere;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}
}

.tasktext.done .task-link {
	color: var(--text-tertiary);
	text-decoration: line-through;
}

.tasktext__context {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	margin-block-start: .125rem;
	font-size: var(--text-xs);
}

.task-project {
	overflow: hidden;
	color: var(--text-tertiary);
	text-overflow: ellipsis;
	white-space: nowrap;

	&:hover {
		color: var(--text-secondary);
		text-decoration: underline;
	}
}

.tasktext__task-color,
.tasktext__project-color {
	flex-shrink: 0;
}

.tasktext__project-color {
	inline-size: .5rem;
	block-size: .5rem;
}

.single-task__meta {
	grid-area: meta;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-1) var(--space-3);
	min-inline-size: 0;
	min-block-size: 1.75rem;
	color: var(--text-secondary);
	font-size: var(--text-sm);

	&:empty {
		display: none;
	}

	@media screen and (max-width: $tablet) {
		justify-content: flex-start;
		gap: var(--space-1) var(--space-2);
		min-block-size: 0;
		margin-block-start: var(--space-1);
	}
}

.single-task__priority {
	font-size: var(--text-xs);

	// Medium stays an icon in rows; the word remains for screen readers and the table view.
	&.not-so-high :deep(.priority-label__text) {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
}

.single-task__icons {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.single-task__progress {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);

	:deep(.progress-bar) {
		--progress-height: 4px;

		flex: none;
		order: 0;
		inline-size: 2.5rem;
		min-inline-size: 0;
		margin: 0;
		border-radius: var(--radius-full);
	}
}

.single-task__percent {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.single-task__assignees {
	flex-shrink: 0;
}

.dueDate {
	position: relative;
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: 1.5rem;
	padding-inline: var(--space-2);
	border-radius: var(--radius-full);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;

	&:hover {
		background-color: var(--surface-active);
	}

	&.is-today {
		background-color: var(--tint-info);
		color: var(--accent-text);
	}

	&.is-overdue {
		background-color: var(--tint-danger);
		color: var(--danger-text);
		font-weight: var(--weight-medium);
	}

	&.is-today:hover,
	&.is-overdue:hover {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
	}

	@media (pointer: coarse) {
		&::before {
			content: '';
			position: absolute;
			inset: calc((var(--target-min) - 1.5rem) / -2) 0;
		}
	}
}

.dueDate__icon {
	font-size: .8em;
}

.single-task__end {
	grid-area: end;
	display: flex;
	align-items: center;
	min-block-size: 1.75rem;
}

.favorite {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: 1.75rem;
	block-size: 1.75rem;
	border-radius: $radius;
	color: var(--text-tertiary);
	transition: opacity var(--motion-fast) var(--ease-standard);

	&:hover,
	&.is-favorite {
		color: var(--warning);
	}

	&.is-favorite {
		opacity: 1;
	}

	@media (pointer: coarse) {
		&::before {
			content: '';
			position: absolute;
			inset: calc((var(--target-min) - 1.75rem) / -2);
		}
	}
}

// Opacity, not visibility, so the star stays clickable and "visible" to the e2e tests.
@media (hover: hover) and (pointer: fine) {
	.favorite:not(.is-favorite) {
		opacity: 0;
	}

	.single-task:hover .favorite,
	.single-task:focus-within .favorite {
		opacity: 1;
	}
}

.list-task-hierarchy {
	grid-area: hier;
	min-inline-size: 0;
}

.subtask-branch {
	border-inline-start: 2px solid var(--border-default);
	margin-inline-start: 1rem;
}

.subtask-nested {
	margin-inline-start: 1rem;
	position: relative;
}

.subtask-nested::before {
	content: '';
	position: absolute;
	inset-inline-start: -1rem;
	inset-block-start: 1.1rem;
	inline-size: .8rem;
	border-block-start: 2px solid var(--border-default);
}

:deep(.popup) {
	border-radius: var(--radius-md);
	background-color: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	&.is-open {
		padding: var(--space-4);
		border: 1px solid var(--border-subtle);
	}
}
</style>
