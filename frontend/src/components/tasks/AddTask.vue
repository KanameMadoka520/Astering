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
					:aria-disabled="!newTaskTitle.trim() || busy || Boolean(recovery)"
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
		<section
			v-if="recovery"
			class="bulk-recovery"
			:aria-label="$t('task.bulkRecovery.title')"
			:aria-busy="busy"
		>
			<strong>{{ $t('task.bulkRecovery.title') }}</strong>
			<p role="status">
				{{ $t('task.bulkRecovery.summary', {created: recovery.entries.length - pendingEntries.length, pending: pendingEntries.length, relations: pendingRelations}) }}
			</p>
			<ul v-if="pendingEntries.length">
				<li
					v-for="entry in pendingEntries"
					:key="recovery.entries.indexOf(entry)"
				>
					{{ entry.title }}
				</li>
			</ul>
			<p>{{ $t('task.bulkRecovery.hint') }}</p>
			<p
				v-if="confirmDiscard"
				class="bulk-recovery-confirm"
				role="alert"
			>
				{{ $t('task.bulkRecovery.discardConfirm', {pending: pendingEntries.length, relations: pendingRelations}) }}
			</p>
			<div class="bulk-recovery-actions">
				<XButton
					class="bulk-recovery-retry"
					:loading="busy"
					:aria-disabled="busy"
					@click="retryBatch"
				>
					{{ $t('task.bulkRecovery.retry') }}
				</XButton>
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-disabled="busy"
					@click="toggleDiscard"
				>
					{{ $t(confirmDiscard ? 'misc.cancel' : 'task.bulkRecovery.discard') }}
				</XButton>
				<XButton
					v-if="confirmDiscard"
					class="bulk-recovery-discard"
					danger
					:aria-disabled="busy"
					@click="discardBatch"
				>
					{{ $t('misc.confirm') }}
				</XButton>
			</div>
		</section>
	</div>
</template>

<script setup lang="ts">
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
	type ClientRequestContext,
} from '@/client/requestContext'
import {useCreateTaskRelationMutation} from '@/client/queries/taskMutations'
import {computed, ref, shallowRef, watch, nextTick, onBeforeUnmount} from 'vue'
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
const createRelationMutation = useCreateTaskRelationMutation()
const router = useRouter()

type BatchEntry = {
	title: string,
	project_id: number,
	parentIndex: number | null,
	task?: ITask,
	linked: boolean,
}
type CreationBatch = {
	context: ClientRequestContext,
	path: string,
	generation: number,
	entries: BatchEntry[],
}
const recovery = shallowRef<CreationBatch>()
const confirmDiscard = ref(false)
const pendingEntries = computed(() => recovery.value?.entries.filter(entry => !entry.task) ?? [])
const pendingRelations = computed(() => recovery.value?.entries.filter(entry => !entry.linked).length ?? 0)
let generation = 0
let disposed = false
function currentBatch(batch: CreationBatch) {
	return !disposed && batch.generation === generation && batch.path === router.currentRoute.value.fullPath
		&& isClientRequestContextCurrent(batch.context)
}
function assertBatch(batch: CreationBatch) {
	assertClientRequestContext(batch.context)
	if (!currentBatch(batch)) throw new DOMException('Task batch scope changed', 'AbortError')
}
watch([
	() => router.currentRoute.value.fullPath,
	() => authStore.identityKey,
	() => authStore.currentSessionId,
], () => {
	generation++
	recovery.value = undefined
	confirmDiscard.value = false
}, {flush: 'sync'})
onBeforeUnmount(() => { disposed = true; generation++ })

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
	if (busy.value || recovery.value) return
	if (!newTaskTitle.value.trim()) {
		errorMessage.value = t('project.create.addTitleRequired')
		return
	}
	errorMessage.value = ''
	submitting.value = true
	try { await createTasks() }
	finally { submitting.value = false }
}

function restoreTitle(backup: string) {
	newTaskTitle.value = newTaskTitle.value === '' ? backup : `${backup}\n${newTaskTitle.value}`
}

// The parser's parent titles are ambiguous for repeated names. Keep its parsing, and associate the same source
// lines by indentation/index only, including the parser's adjustment for an initially indented pasted block.
function parentIndexes(source: string, parsed: TaskWithParent[]) {
	const lines = source.split(/[\r\n]+/).filter(line => line.replace(/\s/g, '').length > 0)
	let offset = lines[0]?.match(/^(\t| )+/)?.[0].length ?? 0
	const levels = lines.map(line => {
		const leading = line.match(/^(\t| )+/)?.[0].length ?? 0
		offset = Math.min(offset, leading)
		return line.substring(offset).match(/^ */)?.[0].length ?? 0
	})
	const stack: number[] = []
	return parsed.map((task, index) => {
		while (stack.length && levels[stack[stack.length - 1]] >= levels[index]) stack.pop()
		const parent = task.parent === null ? null : stack[stack.length - 1] ?? null
		stack.push(index)
		return parent
	})
}

async function createTasks() {
	const backup = newTaskTitle.value
	const batch: CreationBatch = {
		context: captureClientRequestContext(),
		path: router.currentRoute.value.fullPath,
		generation,
		entries: [],
	}
	// Clear only the submitted snapshot, so typing during label/member lookup starts an independent draft.
	newTaskTitle.value = ''
	try {
		const mode = authStore.settings.frontend_settings.quick_add_magic_mode
		const parsed = parseSubtasksViaIndention(backup, mode)
		const parents = parentIndexes(backup, parsed)
		const retained = parsed.map((task, index) => ({task, index})).filter(({task}) => task.title !== '')
		if (!retained.length) {
			restoreTitle(backup)
			errorMessage.value = t('project.create.addTitleRequired')
			return
		}
		const labels = [...new Set(retained.flatMap(({task}) => getLabelsFromPrefix(task.title, mode) ?? []))]
		const {skipped} = await ensureLabelsExist(labels, batch.context)
		assertBatch(batch)
		reportSkippedLabels(skipped)
		const currentProject = Number(router.currentRoute.value.params.projectId) || authStore.settings.default_project_id
		const retainedIndexes = new Map(retained.map(({index}, entryIndex) => [index, entryIndex]))
		batch.entries = await Promise.all(retained.map(async ({task, index}) => {
			const project = task.project !== null
				? await findProjectId({project: task.project, projectId: 0})
				: currentProject
			assertBatch(batch)
			const parent = parents[index]
			const parentIndex = parent === null ? null : retainedIndexes.get(parent) ?? null
			return {
				title: task.title,
				project_id: project || authStore.settings.default_project_id || 0,
				parentIndex,
				linked: parentIndex === null,
			}
		}))
		await executeBatch(batch)
	} catch (cause) {
		if (isRequestContextAbort(cause) || !currentBatch(batch)) return
		if (batch.entries.some(entry => entry.task)) {
			recovery.value = {...batch, entries: [...batch.entries]}
			error(cause)
			return
		}
		restoreTitle(backup)
		errorMessage.value = cause instanceof Error && cause.message === 'NO_PROJECT'
			? t('project.create.addProjectRequired')
			: t('task.bulkRecovery.prepareFailed')
	}
}

async function executeBatch(batch: CreationBatch) {
	assertBatch(batch)
	const pending = batch.entries.filter(entry => !entry.task)
	if (pending.length) {
		const result = await createNewTasksBulk(pending.map(({title, project_id}) => ({title, project_id})), () => assertBatch(batch))
		assertBatch(batch)
		const added: ITask[] = []
		pending.forEach((entry, index) => {
			const task = result.tasks[index]
			if (!task?.id) return
			entry.task = task
			added.push(task)
		})
		if (added.length) emit('tasksAdded', added)
		if (result.error) error(result.error)
	}
	await runWrites(batch.entries, async entry => {
		if (entry.linked || entry.parentIndex === null || !entry.task) return
		const parent = batch.entries[entry.parentIndex]?.task
		if (!parent) return
		assertBatch(batch)
		try {
			await createRelationMutation.mutateAsync({
				taskId: entry.task.id!,
				other_task_id: parent.id!,
				relation_kind: RELATION_KIND.PARENTTASK,
			})
			assertBatch(batch)
			entry.linked = true
		} catch (cause) {
			assertBatch(batch)
			// A lost acknowledgement can leave a valid relation on the server; its duplicate response confirms it.
			if ((cause as {code?: number} | null)?.code === 4008) entry.linked = true
		}
	}, configStore.concurrent_writes)
	assertBatch(batch)
	if (batch.entries.some(entry => !entry.task || !entry.linked)) {
		recovery.value = {...batch, entries: [...batch.entries]}
	} else {
		const restoreFocus = Boolean(document.activeElement?.closest('.bulk-recovery'))
		recovery.value = undefined
		confirmDiscard.value = false
		if (restoreFocus) {
			await nextTick()
			if (currentBatch(batch) && document.activeElement === document.body) newTaskInput.value?.focus()
		}
	}
}

async function retryBatch() {
	if (busy.value || !recovery.value) return
	const batch = recovery.value
	if (!currentBatch(batch)) {
		recovery.value = undefined
		return
	}
	confirmDiscard.value = false
	submitting.value = true
	try { await executeBatch(batch) }
	catch (cause) {
		if (!isRequestContextAbort(cause) && currentBatch(batch)) error(cause)
	} finally { submitting.value = false }
}
function toggleDiscard() {
	if (!busy.value) confirmDiscard.value = !confirmDiscard.value
}
async function discardBatch() {
	if (busy.value || !confirmDiscard.value || !recovery.value) return
	recovery.value = undefined
	confirmDiscard.value = false
	await nextTick()
	newTaskInput.value?.focus()
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

.bulk-recovery {
	margin-block-start: var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	p {
		margin-block: var(--space-2);
	}

	ul {
		max-block-size: 10rem;
		padding-inline-start: var(--space-4);
		overflow: auto;
	}
}

.bulk-recovery-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
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
