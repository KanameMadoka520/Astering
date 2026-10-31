<template>
	<div
		ref="card"
		class="task loader-container draggable"
		:class="{
			'is-loading': showLoading,
			'draggable': !loadingInternal,
			'is-routine': isRoutine,
			'has-light-text': !colorIsDark(color),
			'has-custom-background-color': color ?? undefined,
		}"
		:style="{'background-color': color ?? undefined}"
		:data-task-id="task.id"
		:data-project-id="task.project_id"
		:data-is-overdue="isOverdue || undefined"
		@click.exact="openTaskDetail()"
		@click.ctrl="() => toggleTaskDone(task)"
		@click.meta="() => toggleTaskDone(task)"
	>
		<img
			v-if="coverImageBlobUrl"
			:src="coverImageBlobUrl"
			alt=""
			class="tw:w-full"
		>
		<div class="kanban-card__body">
			<div class="kanban-card__meta">
				<span class="task-id">
					<Done
						class="kanban-card__done"
						:is-done="task.done"
						variant="small"
					/>
					{{ getTaskIdentifier(task) }}
					<span
						v-if="showTaskPosition"
						class="tw:text-red-600 tw:ps-2"
					>
						{{ task.position }}
					</span>
				</span>
				<RoutineStatusChip
					v-if="isRoutine"
					:task="task"
					class="kanban-card__routine"
				/>
				<span
					v-if="new Date(task.due_date ?? 0).getTime() > 0"
					v-tooltip="formatDateLong(task.due_date)"
					class="due-date"
				>
					<span class="icon">
						<Icon :icon="['far', 'calendar-alt']" />
					</span>
					<time :datetime="formatISO(task.due_date)">
						{{ formatDisplayDate(task.due_date) }}
					</time>
				</span>
			</div>
			
			<h3>
				<RouterLink
					:to="{ name: 'task.detail', params: {id: task.id} }"
					class="kanban-card__title-link"
					draggable="false"
					@click.exact.prevent.stop="openTaskDetail()"
					@click.ctrl.stop
					@click.meta.stop
				>
					{{ task.title }}
				</RouterLink>
			</h3>
			
			<span
				v-if="projectTitle"
				class="project-title"
			>
				{{ projectTitle }}
			</span>

			<TaskHierarchySummary :task="task" />

			<ProgressBar
				v-if="task.percent_done > 0"
				class="task-progress"
				:value="task.percent_done * 100"
				:label="$t('task.attributes.percentDone')"
			/>
			<div class="footer">
				<Labels :labels="task.labels" />
				<PriorityLabel
					:priority="task.priority"
					:done="task.done"
					class="is-inline-flex is-align-items-center"
				/>
				<span
					v-if="task.attachments.length > 0"
					class="icon"
					role="img"
					:aria-label="$t('task.attributes.attachment', task.attachments.length)"
				>
					<Icon icon="paperclip" />
				</span>
				<span
					v-if="!isEditorContentEmpty(task.description)"
					class="icon"
					role="img"
					:aria-label="$t('task.attributes.description')"
				>
					<Icon icon="align-left" />
				</span>
				<span
					v-if="task.repeat_after > 0"
					class="icon"
					role="img"
					:aria-label="$t('task.attributes.repeat')"
				>
					<Icon icon="history" />
				</span>
				<CommentCount
					:task="task"
					class="project-task-icon"
				/>
				<AssigneeList
					v-if="task.assignees.length > 0"
					:assignees="task.assignees"
					:avatar-size="24"
				/>
				<ChecklistSummary
					:task="task"
					class="checklist"
				/>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import {computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch} from 'vue'
import {useRouter} from 'vue-router'

import {useGlobalNow} from '@/composables/useGlobalNow'

import PriorityLabel from '@/components/tasks/partials/PriorityLabel.vue'
import ProgressBar from '@/components/misc/ProgressBar.vue'
import Done from '@/components/misc/Done.vue'
import Labels from '@/components/tasks/partials/Labels.vue'
import ChecklistSummary from './ChecklistSummary.vue'
import CommentCount from './CommentCount.vue'
import TaskHierarchySummary from './TaskHierarchySummary.vue'
import RoutineStatusChip from './RoutineStatusChip.vue'

import {getHexColor, getTaskIdentifier} from '@/helpers/task'
import type {Task as ITask} from '@/client/generated'
import type {TaskResponse} from '@/client/queries/tasks'
import {canPreviewImage} from '@/helpers/attachmentPreview'
import {fetchAttachmentUrl, releaseAttachmentUrl} from '@/helpers/attachments'
import {ApiError} from '@/client/problem'

import {formatDateLong, formatDisplayDate, formatISO} from '@/helpers/time/formatDate'
import {colorIsDark} from '@/helpers/color/colorIsDark'
import AssigneeList from '@/components/tasks/partials/AssigneeList.vue'
import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import {useProjects} from '@/composables/useProjects'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useTaskDoneToggle} from '@/composables/useTaskDoneToggle'

const props = defineProps<{
	task: TaskResponse,
	projectId: number,
}>()

const emit = defineEmits<{
	'taskCompletedRecurring': [task: ITask]
}>()

const router = useRouter()

const loadingInternal = ref(false)
const showLoading = useDelayedLoading(loadingInternal)

const color = computed(() => getHexColor(props.task.hex_color))

const projectList = useProjects()

const projectTitle = computed(() => {
	if (props.projectId === props.task.project_id) {
		return
	}
	
	const project = projectList.projects[props.task.project_id]
	return project?.title
})

const showTaskPosition = computed(() => window.DEBUG_TASK_POSITION)

const {now} = useGlobalNow()
// A routine's state is today's check-in, so an old due date never marks it overdue.
const isOverdue = computed(() => (
	!isRoutine.value &&
	!props.task.done &&
	props.task.due_date !== null &&
	new Date(props.task.due_date ?? 0).getTime() > 0 &&
	new Date(props.task.due_date ?? 0).getTime() <= now.value.getTime()
))

const doneToggle = useTaskDoneToggle()
const isRoutine = computed(() => doneToggle.isRoutine(props.task))

// Ctrl/Cmd-click on a routine checks it in for today (or undoes that); its done flag never changes.
async function toggleTaskDone(task: TaskResponse) {
	loadingInternal.value = true
	try {
		await doneToggle.toggle(task, updatedTask => emit('taskCompletedRecurring', updatedTask))
	} finally {
		loadingInternal.value = false
	}
}

function openTaskDetail() {
	router.push({
		name: 'task.detail',
		params: {id: props.task.id},
		state: {backdropView: router.currentRoute.value.fullPath},
	})
}

const coverImageBlobUrl = ref<string | null>(null)

function showCoverImage(url: string | null) {
	releaseAttachmentUrl(coverImageBlobUrl.value)
	coverImageBlobUrl.value = url
}

let coverRequest = 0
let coverRetry: ReturnType<typeof setTimeout> | undefined
// the server answers 503 while its preview queue is full
const COVER_RETRY_DELAY = 5000

async function maybeDownloadCoverImage(retryWhenBusy = true) {
	clearTimeout(coverRetry)
	const request = ++coverRequest
	if (!props.task.cover_image_attachment_id) {
		showCoverImage(null)
		return
	}

	const attachment = props.task.attachments.find(a => a.id === props.task.cover_image_attachment_id)
	if (!attachment || !canPreviewImage(attachment)) {
		return
	}

	try {
		const url = await fetchAttachmentUrl({id: attachment.id!, task_id: props.task.id}, 'lg')
		if (request !== coverRequest) {
			releaseAttachmentUrl(url)
			return
		}
		showCoverImage(url)
	} catch (error) {
		// the cover is decorative, the card works without it
		if (retryWhenBusy && request === coverRequest && error instanceof ApiError && error.status === 503) {
			coverRetry = setTimeout(() => maybeDownloadCoverImage(false), COVER_RETRY_DELAY)
		}
	}
}

const card = useTemplateRef<HTMLElement>('card')
const hasBeenVisible = ref(false)
let visibilityObserver: IntersectionObserver | undefined

// rootMargin only grows the viewport; buckets scroll on their own and need scrollMargin
const COVER_PRELOAD_MARGIN = '200px'

onMounted(() => {
	visibilityObserver = new IntersectionObserver(
		entries => {
			if (!entries.some(entry => entry.isIntersecting)) {
				return
			}
			hasBeenVisible.value = true
			visibilityObserver?.disconnect()
		},
		{
			rootMargin: COVER_PRELOAD_MARGIN,
			scrollMargin: COVER_PRELOAD_MARGIN,
		},
	)
	visibilityObserver.observe(card.value!)
})

watch(
	[hasBeenVisible, () => props.task.cover_image_attachment_id],
	([visible]) => {
		if (visible) {
			maybeDownloadCoverImage()
		}
	},
)

onBeforeUnmount(() => {
	visibilityObserver?.disconnect()
	clearTimeout(coverRetry)
	coverRequest++
	showCoverImage(null)
})
</script>

<style lang="scss" scoped>
.task {
	// Fixed chip colours for custom-coloured cards: whichever text colour colorIsDark picks keeps 4.5:1 on them.
	--kanban-chip-on-light: hsl(220, 13%, 91%);
	--kanban-chip-on-dark: hsl(215, 27.9%, 16.9%);

	-webkit-touch-callout: none; // iOS Safari
	user-select: none;
	cursor: pointer;
	display: block;
	position: relative;

	border: 1px solid var(--border-subtle);
	border-radius: $radius;
	background: var(--surface);
	box-shadow: var(--elevation-1);
	color: var(--text-primary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow: hidden;

	&:hover {
		border-color: var(--border-default);
		box-shadow: var(--elevation-2);
	}

	&.loader-container.is-loading::after {
		inline-size: 1.5rem;
		block-size: 1.5rem;
		inset-block-start: calc(50% - .75rem);
		inset-inline-start: calc(50% - .75rem);
		border-width: 2px;
	}

	> img {
		display: block;
		inline-size: 100%;
	}

	h3 {
		margin-block: var(--space-1) 0;
		font-family: $family-sans-serif;
		font-size: var(--text-md);
		font-weight: var(--weight-medium);
		line-height: var(--leading-tight);
		word-break: break-word;
	}

	.kanban-card__title-link {
		color: inherit;
		text-decoration: none;
	}

	.due-date {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-1);
		font-size: var(--text-xs);
		white-space: nowrap;

		.icon {
			inline-size: auto;
			block-size: auto;
		}
	}

	&[data-is-overdue] .due-date {
		color: var(--danger-text);
	}

	.footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
		margin-block-start: var(--space-2);
		padding: 0;
		background: transparent;

		&:empty {
			display: none;
		}

		:deep(.checklist-summary) {
			padding-inline-start: 0;
			font-size: var(--text-xs);
		}

		:deep(.assignees-list) {
			margin-inline-start: auto;
		}

		:deep(.priority-label) {
			font-size: var(--text-xs);
			padding: 0 var(--space-1);

			.icon {
				block-size: 1rem;
				margin-block-start: 0;
				padding: 0 var(--space-1) 0 0;
			}
		}

		> .icon {
			inline-size: 1.25rem;
			block-size: 1.25rem;
			font-size: var(--text-2xs);
			color: var(--text-secondary);
		}
	}

	.footer > .icon,
	.due-date,
	.footer :deep(.priority-label) {
		min-block-size: 1.25rem;
		border-radius: var(--radius-sm);
		background: var(--surface-active);
	}

	.task-id,
	.project-title {
		display: flex;
		align-items: center;
		color: var(--text-tertiary);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.project-title {
		margin-block-start: var(--space-1);
	}

	&.is-moving {
		opacity: .5;
	}

	span {
		inline-size: auto;
	}

	&.has-custom-background-color {
		border-color: transparent;
		color: #000000; // pure black, not grey-800: guarantees 4.5:1 at the luminance flip point

		.footer > .icon,
		.due-date,
		.footer :deep(.priority-label) {
			background: var(--kanban-chip-on-light);
		}

		.footer > .icon {
			color: inherit;
		}

		// beat the component-level muted colour so secondary text tracks the guaranteed main text colour
		.task-id,
		.project-title {
			color: inherit;
		}

		.footer :deep(.checklist-summary) {
			color: inherit;
		}
	}

	&.has-light-text {
		--white: hsla(var(--white-h), var(--white-s), var(--white-l), var(--white-a)) !important;
		color: var(--white);

		.footer > .icon,
		.due-date,
		.footer :deep(.priority-label) {
			background: var(--kanban-chip-on-dark);
		}

		.footer .icon svg {
			fill: var(--white);
		}

		.task-id,
		.project-title {
			color: inherit;
		}

		.footer :deep(.checklist-summary) {
			color: inherit;
		}

		// --danger-text fails on the dark chip; the brightened red keeps hue/saturation and reaches 4.5:1
		&[data-is-overdue] .due-date,
		.footer :deep(.priority-label.high-priority) {
			color: hsl(var(--danger-h), var(--danger-s), 68%);
		}
	}
}

@supports selector(:has(*)) {
	.task:has(.kanban-card__title-link:focus-visible) {
		@include focus-ring;
		outline-offset: 1px;

		.kanban-card__title-link {
			outline: none;
		}
	}
}

.kanban-card__body {
	padding: var(--space-2) var(--space-3) var(--space-3);
}

.kanban-card__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	min-block-size: 1.25rem;
}

// Sits next to the identifier; the due date keeps the end of the row.
.kanban-card__routine {
	margin-inline-end: auto;
}

.kanban-card__done {
	margin-inline-end: var(--space-1);
}

.task-progress {
	margin: var(--space-2) 0 0;
	inline-size: 100%;
	block-size: .375rem;
}

:deep(.comment-count) {
	padding: 0 var(--space-1);
	border-radius: var(--radius-sm);
	background: var(--surface-active);
}
</style>
