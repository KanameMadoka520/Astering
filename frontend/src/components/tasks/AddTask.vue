<template>
	<div
		ref="taskAdd"
		class="task-add"
		:class="{'is-invited': focusPulse}"
	>
		<div class="add-task__field field">
			<p class="control task-input-wrapper">
				<label
					class="is-sr-only"
					:for="textareaId"
				>
					{{ $t('project.list.addPlaceholder') }}
				</label>
				<span class="icon is-small task-icon">
					<Icon icon="tasks" />
				</span>
				<textarea
					:id="textareaId"
					ref="newTaskInput"
					v-model="newTaskTitle"
					v-focus
					class="add-task-textarea input"
					:class="{'textarea-empty': newTaskTitle === ''}"
					:placeholder="$t('project.list.addPlaceholder')"
					rows="1"
					@keydown="resetEmptyTitleError"
					@keydown.enter="handleEnter"
					@keydown.esc="blurTaskInput"
				/>
				<QuickAddMagic
					:highlight-hint-icon="taskAddHovered"
				/>
			</p>
			<p class="control">
				<XButton
					class="add-task-button"
					:disabled="newTaskTitle === '' || showLoading || undefined"
					icon="plus"
					:loading="busy"
					:aria-label="$t('project.list.add')"
					@click="addTask()"
				>
					<span class="button-text">
						{{ $t('project.list.add') }}
					</span>
				</XButton>
			</p>
		</div>
		<p
			v-if="focusPulse"
			class="task-invite"
			role="status"
		>
			{{ $t('flow.taskInvite') }}
		</p>
		<Expandable :open="errorMessage !== ''">
			<p
				v-if="errorMessage !== ''"
				class="pbs-3 mbs-0 help is-danger"
			>
				{{ errorMessage }}
			</p>
		</Expandable>
	</div>
</template>

<script setup lang="ts">
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {useCreateTaskRelationMutation} from '@/client/queries/taskMutations'
import {computed, ref, nextTick, onBeforeUnmount} from 'vue'
import {useI18n} from 'vue-i18n'
import {useElementHover} from '@vueuse/core'
import {useRouter} from 'vue-router'

import {RELATION_KIND} from '@/types/IRelationKind'
import type {Task as ITask} from '@/client/generated'

import Expandable from '@/components/base/Expandable.vue'
import QuickAddMagic from '@/components/tasks/partials/QuickAddMagic.vue'
import {parseSubtasksViaIndention, type TaskWithParent} from '@/helpers/parseSubtasksViaIndention'
import {getLabelsFromPrefix} from '@/modules/quickAddMagic'
import {runWrites} from '@/helpers/runWrites'
import {error} from '@/message'

import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'
import {reportSkippedLabels, useQuickAddTask} from '@/composables/useQuickAddTask'

import {useAutoHeightTextarea} from '@/composables/useAutoHeightTextarea'
import {useDelayedLoading} from '@/composables/useDelayedLoading'

const emit = defineEmits<{
	tasksAdded: [tasks: ITask[]],
}>()

const textareaId = computed(() => `task-add-textarea-${Math.random().toString(36).substr(2, 9)}`)

const newTaskTitle = ref('')
const {textarea: newTaskInput} = useAutoHeightTextarea(newTaskTitle)

const {t} = useI18n({useScope: 'global'})
const authStore = useAuthStore()
const configStore = useConfigStore()
const {createNewTasksBulk, findProjectId, ensureLabelsExist, isLoading: loading} = useQuickAddTask()
// From Enter until the tasks exist, including looking up and creating labels first: a second Enter in that
// time would create the task and its new labels twice.
const submitting = ref(false)
const busy = computed(() => loading.value || submitting.value)
const showLoading = useDelayedLoading(busy)
const createRelationMutation = useCreateTaskRelationMutation()
const router = useRouter()

// enable only if we don't have a modal
// onStartTyping(() => {
// 	if (newTaskInput.value === null || document.activeElement === newTaskInput.value) {
// 		return
// 	}
// 	newTaskInput.value.focus()
// })

const taskAdd = ref<HTMLElement | null>(null)
const taskAddHovered = useElementHover(taskAdd)

const errorMessage = ref('')

function resetEmptyTitleError() {
	if (!newTaskTitle.value) {
		errorMessage.value = ''
	}
}

async function addTask() {
	if (busy.value) {
		return
	}
	if (newTaskTitle.value === '') {
		errorMessage.value = t('project.create.addTitleRequired')
		return
	}
	errorMessage.value = ''
	submitting.value = true
	try {
		await createTasks()
	} finally {
		submitting.value = false
	}
}

// A failed create puts the title back. Text typed in the meantime stays, after it on its own line.
function restoreTitle(backup: string) {
	newTaskTitle.value = newTaskTitle.value === '' ? backup : `${backup}\n${newTaskTitle.value}`
}

async function createTasks() {
	const context = captureClientRequestContext()
	const taskTitleBackup = newTaskTitle.value
	// Keyed by the title the task had before quick add magic parsed it. A Map,
	// because a user-entered `__proto__` would corrupt plain-object lookups.
	const createdTasks = new Map<ITask['title'], ITask>()
	const tasksToCreate = parseSubtasksViaIndention(newTaskTitle.value, authStore.settings.frontend_settings.quick_add_magic_mode)

	// We ensure all labels exist prior to passing them down to the create task method
	// In the store it will only ever see one task at a time so there's no way to reliably 
	// check if a new label was created before (because everything happens async).
	const allLabels = tasksToCreate.map(({title}) => getLabelsFromPrefix(title, authStore.settings.frontend_settings.quick_add_magic_mode) ?? [])
	const requestedLabels = [...new Set(allLabels.flat())]
	const {skipped} = await ensureLabelsExist(requestedLabels, context)
	assertClientRequestContext(context)

	// Skipped labels (e.g. link shares may not create them) don't block task creation; just tell the user.
	reportSkippedLabels(skipped)

	let currentProjectId = authStore.settings.default_project_id
	if (typeof router.currentRoute.value.params.projectId !== 'undefined') {
		currentProjectId = Number(router.currentRoute.value.params.projectId)
	}

	try {
		newTaskTitle.value = ''

		const entries = await Promise.all(tasksToCreate
			.filter(({title}) => title !== '')
			.map(async ({title, project}) => ({
				title,
				project_id: (project !== null
					? await findProjectId({project, projectId: 0})
					: currentProjectId) || authStore.settings.default_project_id || 0,
			})))

		// Input like a lone bullet passes the empty check but parses to nothing.
		if (entries.length === 0) {
			restoreTitle(taskTitleBackup)
			errorMessage.value = t('project.create.addTitleRequired')
			return
		}

		// Separate from createdTasks: duplicate lines create two tasks but collapse
		// into a single map entry.
		const allCreated: ITask[] = []

		assertClientRequestContext(context)
		const bulk = await createNewTasksBulk(entries)
		entries.forEach(({title}, index) => {
			const task = bulk.tasks[index]
			if (task === null) {
				return
			}
			createdTasks.set(title, task)
			allCreated.push(task)
		})

		const allParentTasks = tasksToCreate.filter(t => t.parent !== null).map(t => t.parent)
		const createRelation = async (t: TaskWithParent) => {
			const createdTask = createdTasks.get(t.title)
			if (typeof createdTask === 'undefined') {
				return
			}

			const isParent = allParentTasks.includes(t.title)
			if (t.parent === null && !isParent) {
				return
			}

			const createdParentTask = createdTasks.get(t.parent ?? '')
			if (typeof createdTask === 'undefined' || typeof createdParentTask === 'undefined') {
				return
			}

			assertClientRequestContext(context)
			const rel = await createRelationMutation.mutateAsync({
				taskId: createdTask.id!,
				other_task_id: createdParentTask.id,
				relation_kind: RELATION_KIND.PARENTTASK,
			})

			return rel
		}

		try {
			await runWrites(tasksToCreate, createRelation, configStore.concurrent_writes)
		} catch (e) {
			// The tasks themselves exist by now — reporting and moving on beats
			// restoring the input and letting the user duplicate all of them.
			error(e)
		}

		assertClientRequestContext(context)
		if (allCreated.length > 0) {
			emit('tasksAdded', allCreated)
		}

		if (bulk.error !== null) {
			restoreTitle(taskTitleBackup)
			error(bulk.error)
		}
	} catch (e) {
		restoreTitle(taskTitleBackup)
		if (e instanceof Error && e.message === 'NO_PROJECT') {
			errorMessage.value = t('project.create.addProjectRequired')
			return
		}
		throw e
	}
}

function handleEnter(e: KeyboardEvent) {
	// when pressing shift + enter we want to continue as we normally would. Otherwise, we want to create 
	// the new task(s). The vue event modifier don't allow this, hence this method.
	if (e.shiftKey) {
		return
	}

	if (e.isComposing) {
		return
	}

	e.preventDefault()
	addTask()
}

const focusPulse = ref(false)
let pulseTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(pulseTimer))
async function focusTaskInput() {
	await nextTick()
	focusPulse.value = true
	newTaskInput.value?.scrollIntoView({block:'center', behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
	newTaskInput.value?.focus({preventScroll:true})
	clearTimeout(pulseTimer)
	pulseTimer=setTimeout(()=>focusPulse.value=false,2500)
}

function blurTaskInput() {
	newTaskInput.value?.blur()
}

defineExpose({
	focusTaskInput,
})
</script>

<style lang="scss" scoped>
.task-add,
// overwrite bulma styles
.task-add .add-task__field {
	margin-block-end: 0;
}

.task-invite {
	margin: var(--space-2) 0 0;
	color: var(--accent-text);
	font-size: var(--text-sm);
}

.task-add .add-task__field {
	display: flex;
	align-items: flex-start;
	justify-content: flex-start;
	gap: var(--space-2);

	.control {
		flex-shrink: 0;
		margin-block-end: 0;
	}

	// Must out-rank the `.control` rule above, or the input keeps its intrinsic width
	// and pushes the add button past a 320px screen.
	.task-input-wrapper {
		flex-shrink: 1;
		min-inline-size: 0;
	}
}

.task-input-wrapper {
	position: relative;
	flex-grow: 1;

	.icon {
		// Above the textarea, which Bulma positions relatively.
		z-index: 1;
		color: var(--text-tertiary);
	}

	.task-icon,
	:deep(.quick-add-magic-trigger-btn) {
		position: absolute;
	}

	.task-icon {
		inset-block-start: .75rem;
		inset-inline-start: .875rem;
		pointer-events: none;
	}

	:deep(.quick-add-magic-trigger-btn) {
		inset-block-start: .5rem;
		inset-inline-end: .5rem;
		inline-size: 1.5rem;
		block-size: 1.5rem;
		border-radius: $radius;

		&:hover {
			background: var(--surface-hover);
			color: var(--text-secondary);
		}

		@media (pointer: coarse) {
			&::before {
				content: '';
				position: absolute;
				inset: calc((var(--target-min) - 1.5rem) / -2);
			}
		}
	}
}

// The field's own border and keyboard outline are the only focus indicator.
.add-task-textarea {
	min-block-size: var(--control-height-lg);
	padding-inline: 2.5rem;
	resize: none;

	.is-invited & {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--surface-selected-strong);
	}
}

// Fixed height: the button stays one line tall while the textarea grows.
.add-task-button {
	block-size: var(--control-height-lg);
	min-block-size: var(--control-height-lg);

	@media (pointer: coarse) {
		block-size: max(var(--control-height-lg), var(--target-min));
		min-block-size: max(var(--control-height-lg), var(--target-min));
	}

	@media screen and (max-width: $tablet) {
		.button-text {
			display: none;
		}

		:deep(.icon) {
			margin: 0 !important;
		}
	}
}

// Adding this class when the textarea has no text prevents the textarea from wrapping the placeholder.
.textarea-empty {
	white-space: nowrap;
	text-overflow: ellipsis;
}
</style>

<style>
button.show-helper-text {
	inset-inline-end: 0;
}
</style>
