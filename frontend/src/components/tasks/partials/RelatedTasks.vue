<template>
	<div class="task-relations">
		<div class="task-section-header">
			<h2 class="task-section-title">
				<span class="icon is-grey">
					<Icon icon="sitemap" />
				</span>
				{{ $t('task.attributes.relatedTasks') }}
			</h2>
			<XButton
				v-if="editEnabled && Object.keys(relatedTasks).length > 0"
				id="showRelatedTasksFormButton"
				v-tooltip="$t('task.relation.add')"
				:aria-label="$t('task.relation.add')"
				:aria-expanded="showNewRelationForm"
				class="add-task-relation-button d-print-none"
				:class="{'is-active': showNewRelationForm}"
				variant="secondary"
				icon="plus"
				:shadow="false"
				@click="showNewRelationForm = !showNewRelationForm"
			/>
		</div>
		<transition-group name="fade">
			<template v-if="editEnabled && showCreate">
				<label
					key="label"
					class="label"
				>
					{{ $t('task.relation.new') }}
					<CustomTransition name="fade">
						<span
							v-if="isSaving"
							class="is-inline-flex"
						>
							<span class="loader is-inline-block mie-2" />
							{{ $t('misc.saving') }}
						</span>
						<span
							v-else-if="saved"
							class="has-text-success"
						>
							{{ $t('misc.saved') }}
						</span>
					</CustomTransition>
				</label>
				<div
					key="field-search"
					class="field task-relation-search-field"
				>
					<Multiselect
						v-model="newTaskRelation.task"
						v-focus
						:placeholder="$t('task.relation.searchPlaceholder')"
						:loading="taskQuery.isFetching.value"
						:search-results="mappedFoundTasks"
						label="title"
						:creatable="true"
						:create-placeholder="$t('task.relation.createPlaceholder')"
						@search="findTasks"
						@create="createAndRelateTask"
					>
						<template #searchResult="{option: task}">
							<span
								class="search-result"
								:class="{'is-strikethrough': task.done}"
							>
								<span
									v-if="task.project_id !== projectId"
									class="different-project"
								>
									<span
										v-if="projectList.projects[task.project_id ?? 0]?.title"
										v-tooltip="$t('task.relation.differentProject')"
									>
										{{ projectList.projects[task.project_id ?? 0]?.title }} >
									</span>
								</span>
								<span class="task-identifier">{{ getTaskIdentifier(task) }}</span>
								{{ task.title }}
							</span>
						</template>
					</Multiselect>
					<QuickAddMagic />
				</div>
				<div
					key="field-kind"
					class="field has-addons mbe-4"
				>
					<div class="control is-expanded">
						<div class="select is-fullwidth has-defaults">
							<select
								v-model="newTaskRelation.kind"
								:aria-label="$t('task.relation.select')"
							>
								<option value="unset">
									{{ $t('task.relation.select') }}
								</option>
								<option
									v-for="rk in RELATION_KINDS"
									:key="`option_${rk}`"
									:value="rk"
								>
									{{ $t(`task.relation.kinds.${rk}`, 1) }}
								</option>
							</select>
						</div>
					</div>
					<div class="control">
						<XButton @click="addTaskRelation()">
							{{ $t('task.relation.add') }}
						</XButton>
					</div>
				</div>
			</template>
		</transition-group>

		<div
			v-for="rts in mappedRelatedTasks"
			:key="rts.kind"
			class="related-tasks"
		>
			<span class="title">{{ rts.title }}</span>
			<div class="tasks">
				<div
					v-for="task in rts.tasks"
					:key="task.id"
					class="task"
				>
					<div class="is-flex is-align-items-center">
						<FancyCheckbox
							:model-value="task.done ?? false"
							class="task-done-checkbox"
							@update:modelValue="toggleTaskDone({...task, done: $event})"
						/>
						<RouterLink
							:to="{ name: route.name as string, params: { id: task.id }, state: taskModalNavigationState(route) }"
							:class="{ 'is-strikethrough': task.done}"
						>
							<span
								v-if="task.project_id !== projectId"
								class="different-project"
							>
								<span
									v-if="projectList.projects[task.project_id ?? 0]?.title"
									v-tooltip="$t('task.relation.differentProject')"
								>
									{{ projectList.projects[task.project_id ?? 0]?.title }} >
								</span>
							</span>
							<span class="task-identifier">{{ getTaskIdentifier(task) }}</span>
							{{ task.title }}
						</RouterLink>
					</div>
					<BaseButton
						v-if="editEnabled"
						class="remove"
						:aria-label="$t('task.relation.delete')"
						@click="setRelationToDelete({
							relation_kind: rts.kind,
							other_task_id: task.id,
							title: task.title,
						})"
					>
						<Icon icon="trash-alt" />
					</BaseButton>
				</div>
			</div>
		</div>
		<p
			v-if="showNoRelationsNotice && Object.keys(relatedTasks).length === 0"
			class="none"
		>
			{{ $t('task.relation.noneYet') }}
		</p>

		<Modal
			:enabled="relationToDelete !== undefined"
			danger
			:confirm-label="$t('task.relation.deleteConfirm')"
			@close="relationToDelete = undefined"
			@submit="removeTaskRelation"
		>
			<template #header>
				<span>{{ $t('task.relation.delete') }}</span>
			</template>

			<template #text>
				<p>{{ $t('task.relation.deleteText', {task: relationToDelete?.title ?? ''}) }}</p>
			</template>
		</Modal>
	</div>
</template>

<script setup lang="ts">
import {ref, reactive, computed} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute} from 'vue-router'
import {taskModalNavigationState} from '@/helpers/taskModal'

import {useTasks} from '@/composables/useTasks'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useCreateTaskRelationMutation, useDeleteTaskRelationMutation, useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {createTaskDraft, getTaskIdentifier} from '@/helpers/task'
import type {Task as ITask} from '@/client/generated'
import {RELATION_KINDS, type IRelationKind} from '@/types/IRelationKind'


import CustomTransition from '@/components/misc/CustomTransition.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import Multiselect from '@/components/input/Multiselect.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import QuickAddMagic from '@/components/tasks/partials/QuickAddMagic.vue'

import {error, success} from '@/message'
import {useQuickAddTask} from '@/composables/useQuickAddTask'
import {useProjects} from '@/composables/useProjects'
import {useAuthStore} from '@/stores/auth'
import {playPopSound} from '@/helpers/playPop'

const props = withDefaults(defineProps<{
	taskId: number,
	initialRelatedTasks?: ITask['related_tasks'],
	showNoRelationsNotice?: boolean,
	projectId: number,
	editEnabled: boolean,
}>(), {
	initialRelatedTasks: () => ({}),
	showNoRelationsNotice: false,
})

const {createNewTask} = useQuickAddTask()
const updateTask = useUpdateTaskMutation()
const projectList = useProjects()
const authStore = useAuthStore()
const route = useRoute()
const {t} = useI18n({useScope: 'global'})

type TaskRelation = {kind: IRelationKind, task: ITask}

const createRelation = useCreateTaskRelationMutation()
const deleteRelation = useDeleteTaskRelationMutation()
const isSaving = useDelayedLoading(() => createRelation.isPending.value || deleteRelation.isPending.value)

const relatedTasks = computed(() => props.initialRelatedTasks ?? {})

const newTaskRelation: TaskRelation = reactive({
	kind: authStore.settings.frontend_settings.default_task_relation_type as IRelationKind,
	task: createTaskDraft(),
})


const showNewRelationForm = ref(false)
const showCreate = computed(() => Object.keys(relatedTasks.value).length === 0 || showNewRelationForm.value)

const query = ref('')
const taskQuery = useTasks(() => ({params: {q: query.value, sort_by: ['done']}}), {enabled: () => query.value !== ''})
const foundTasks = taskQuery.tasks
function findTasks(value: string) { query.value = value }

function sortTasksForRelationSearch(tasks: ITask[]) {
	return [...tasks].sort((a, b) => {
		if (a.done !== b.done) {
			return a.done ? 1 : -1
		}

		const aIsCurrentProject = a.project_id === props.projectId
		const bIsCurrentProject = b.project_id === props.projectId

		if (aIsCurrentProject === bIsCurrentProject) {
			return 0
		}

		return aIsCurrentProject ? -1 : 1
	})
}

const mapRelationKindsTitleGetter = computed(() => ({
	'subtask': (count: number) => t('task.relation.kinds.subtask', count),
	'parenttask': (count: number) => t('task.relation.kinds.parenttask', count),
	'related': (count: number) => t('task.relation.kinds.related', count),
	'duplicateof': (count: number) => t('task.relation.kinds.duplicateof', count),
	'duplicates': (count: number) => t('task.relation.kinds.duplicates', count),
	'blocking': (count: number) => t('task.relation.kinds.blocking', count),
	'blocked': (count: number) => t('task.relation.kinds.blocked', count),
	'precedes': (count: number) => t('task.relation.kinds.precedes', count),
	'follows': (count: number) => t('task.relation.kinds.follows', count),
	'copiedfrom': (count: number) => t('task.relation.kinds.copiedfrom', count),
	'copiedto': (count: number) => t('task.relation.kinds.copiedto', count),
}))

const mappedRelatedTasks = computed(() => Object.entries(relatedTasks.value).map(
	([kind, tasks]) => ({
		title: mapRelationKindsTitleGetter.value[kind as IRelationKind]((tasks ?? []).length),
		tasks: tasks ?? [],
		kind: kind as IRelationKind,
	}),
))
const mappedFoundTasks = computed(() => sortTasksForRelationSearch(foundTasks.value.filter(t => t.id !== props.taskId)))


const saved = ref(false)

async function addTaskRelation() {
	if (newTaskRelation.task.id === 0 && query.value !== '') {
		return createAndRelateTask(query.value)
	}

	if (!newTaskRelation.task.id) {
		error({message: t('task.relation.taskRequired')})
		return
	}

	await createRelation.mutateAsync({
		taskId: props.taskId,
		other_task_id: newTaskRelation.task.id,
		relation_kind: newTaskRelation.kind,
	})
	newTaskRelation.task = createTaskDraft()
	newTaskRelation.kind = authStore.settings.frontend_settings.default_task_relation_type as IRelationKind
	saved.value = true
	showNewRelationForm.value = false
	setTimeout(() => {
		saved.value = false
	}, 2000)
}

type RelationToDelete = {relation_kind: IRelationKind, other_task_id?: number, title?: string}

const relationToDelete = ref<RelationToDelete>()

function setRelationToDelete(relation: RelationToDelete) {
	relationToDelete.value = relation
}

// The dialog stays open while the request runs and after a failure (the mutation reports it), so the
// relation is never shown as removed when it is not; it only closes once this exact relation is gone.
async function removeTaskRelation() {
	const relation = relationToDelete.value
	if (!relation) return
	if (!relation.other_task_id) {
		relationToDelete.value = undefined
		return
	}
	try {
		await deleteRelation.mutateAsync({relationKind: relation.relation_kind, task: props.taskId, otherTask: relation.other_task_id})
	} catch {
		return
	}
	if (relationToDelete.value === relation) relationToDelete.value = undefined
	saved.value = true
	setTimeout(() => {
		saved.value = false
	}, 2000)
}

function openNewRelationForm() {
	showNewRelationForm.value = true
}

defineExpose({openNewRelationForm})

async function createAndRelateTask(title: string) {
	const newTask = await createNewTask({title, project_id: props.projectId})
	newTaskRelation.task = newTask
	await addTaskRelation()
}

async function toggleTaskDone(task: ITask) {
	await updateTask.mutateAsync({...task, id: task.id!})
	
	if (task.done) {
		playPopSound()
	}
	
	success({message: t('task.detail.updateSuccess')})
}
</script>

<style lang="scss" scoped>
.add-task-relation-button {
	min-block-size: var(--control-height-sm);
	min-inline-size: var(--control-height-sm);

	:deep(svg) {
		transition: transform var(--motion-fast) var(--ease-standard);
	}

	&.is-active :deep(svg) {
		transform: rotate(45deg);
	}
}

.label {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);

	.loader {
		inline-size: .75rem;
		block-size: .75rem;
	}
}

.different-project {
	color: var(--text-tertiary);
	inline-size: auto;
}

.task-identifier {
	color: var(--text-tertiary);
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	margin-inline-end: var(--space-1);
}

.related-tasks + .related-tasks {
	margin-block-start: var(--space-3);
}

.title {
	display: block;
	margin: 0;
	padding-inline: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-normal);
}

.tasks {
	display: flex;
	flex-direction: column;
	gap: 1px;
	padding-block: var(--space-1);
}

.task {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	min-block-size: max(2.25rem, var(--target-min));
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	> .is-flex {
		min-inline-size: 0;
	}

	a {
		color: var(--text-primary);
		overflow-wrap: anywhere;

		&:hover {
			color: var(--accent-text);
		}
	}
}

// Low emphasis but always visible, so touch and keyboard users can reach it.
.remove {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: max(1.75rem, var(--target-min));
	block-size: max(1.75rem, var(--target-min));
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover,
	&:focus-visible {
		background-color: var(--tint-danger);
		color: var(--danger-text);
	}
}

.none {
	margin: 0;
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.delete-warning {
	color: inherit;
}

:deep(.multiselect .search-results button) {
	padding: var(--space-2);
}

.task-relation-search-field {
	position: relative;

	:deep(.quick-add-magic-trigger-btn) {
		position: absolute;
		inset-block-start: .75rem;
		inset-inline-end: .75rem;
		z-index: 4;
	}
}

// FIXME: The height of the actual checkbox in the <FancyCheckbox/> component is too much resulting in a
//  weired positioning of the checkbox. Setting the height here is a workaround until we fix the styling
//  of the component.
.task-done-checkbox {
	padding: 0;
	block-size: 18px; // The exact height of the checkbox in the container
	margin-inline-end: var(--space-2);
}
</style>
