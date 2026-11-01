<template>
	<Modal
		:enabled="active"
		:overflow="isNewTaskCommand"
		variant="top"
		:aria-label="$t('quickActions.title')"
		@close="closeQuickActions"
	>
		<div
			ref="quickActionsCard"
			class="card quick-actions"
			:class="{'is-quick-add-mode': isQuickAddMode}"
			:style="isQuickAddMode ? {maxHeight: quickEntryMaxHeight + 'px', overflowY: 'auto'} : undefined"
		>
			<div
				class="action-input"
				:class="{'has-active-cmd': selectedCmd !== null}"
			>
				<div
					v-if="selectedCmd !== null"
					class="active-cmd tag"
				>
					{{ selectedCmd.title }}
				</div>
				<input
					ref="searchInput"
					v-focus
					:value="query"
					class="input"
					:class="{'is-loading': loading || running}"
					:aria-busy="running || undefined"
					:aria-invalid="commandError !== '' || undefined"
					:aria-describedby="commandError !== '' ? commandErrorId : undefined"
					:placeholder="placeholder"
					@input="updateQuery"
					@keyup="search"
					@keydown.down.prevent="select(0, 0)"
					@keyup.prevent.delete="unselectCmd"
					@keydown.prevent.enter="onEnter"
					@keydown.prevent.esc="closeQuickActions"
				>
				<QuickAddMagic
					v-if="isNewTaskCommand"
				/>
				<BaseButton
					:aria-label="$t('misc.closeQuickActions')"
					class="close"
					@click="closeQuickActions"
				>
					<Icon icon="times" />
				</BaseButton>
			</div>

			<p
				v-if="commandError !== ''"
				:id="commandErrorId"
				class="help is-danger quick-actions-error"
				role="alert"
			>
				{{ commandError }}
			</p>

			<div
				v-if="hintText !== '' && !isNewTaskCommand"
				class="help quick-actions-hint"
			>
				{{ hintText }}
			</div>

			<div
				class="is-sr-only"
				role="status"
				aria-live="polite"
			>
				{{ resultAnnouncement }}
			</div>

			<div
				v-if="selectedCmd === null"
				class="results"
			>
				<div
					v-for="(r, k) in results"
					:key="k"
					class="result"
				>
					<span class="result-title">
						{{ r.title }}
					</span>
					<div class="result-items">
						<BaseButton
							v-for="(i, key) in r.items"
							:key="key"
							:ref="(el: Element | ComponentPublicInstance | null) => setResultRefs(el, k, key)"
							class="result-item-button"
							:class="{'is-strikethrough': isDone(i)}"
							@keydown.up.prevent="select(k, key - 1)"
							@keydown.down.prevent="select(k, key + 1)"
							@click.prevent.stop="doAction(r.type, i)"
							@keyup.prevent.enter="doAction(r.type, i)"
							@keydown.prevent.esc="searchInput?.focus()"
						>
							<template v-if="r.type === ACTION_TYPE.LABELS">
								<XLabel :label="i" />
							</template>
							<template v-else-if="r.type === ACTION_TYPE.TASK">
								<SingleTaskInlineReadonly
									:task="i as ITask"
									:show-project="true"
								/>
								<span
									v-if="isDone(i)"
									class="is-sr-only"
								>{{ $t('task.attributes.done') }}</span>
							</template>
							<template v-else>
								<span
									v-if="isSavedFilterProject(i as Partial<ProjectResponse>)"
									class="saved-filter-icon icon"
								>
									<Icon icon="filter" />
								</span>
								{{ i.title }}
							</template>
							<span class="is-sr-only">{{ r.typeLabel }}</span>
						</BaseButton>
					</div>
				</div>
			</div>
		</div>
	</Modal>
</template>

<script setup lang="ts">
import {type ComponentPublicInstance, computed, ref, useId, watch, watchEffect, onBeforeUnmount} from 'vue'
import {useQuickAddMode} from '@/composables/useQuickAddMode'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'

import {useTasks} from '@/composables/useTasks'
import {useQueries} from '@tanstack/vue-query'
import {teamSearchQuery, useCreateTeamMutation} from '@/client/queries/teams'
import type {Team as ITeam} from '@/client/generated'
import {refDebounced} from '@vueuse/core'

import BaseButton from '@/components/base/BaseButton.vue'
import QuickAddMagic from '@/components/tasks/partials/QuickAddMagic.vue'
import XLabel from '@/components/tasks/partials/Label.vue'
import SingleTaskInlineReadonly from '@/components/tasks/partials/SingleTaskInlineReadonly.vue'

import {useBaseStore} from '@/stores/base'
import {useProjects} from '@/composables/useProjects'
import {useCurrentProject} from '@/composables/useCurrentProject'
import {useQuickAddTask} from '@/composables/useQuickAddTask'
import {isRequestContextAbort} from '@/client/requestContext'
import {useAuthStore} from '@/stores/auth'
import {useLabels} from '@/composables/useLabels'
import {useDelayedLoading} from '@/composables/useDelayedLoading'

import {getHistory} from '@/modules/projectHistory'
import {parseTaskText, PREFIXES, PrefixMode} from '@/modules/quickAddMagic'
import {success} from '@/message'

import type {Task as ITask, Label} from '@/client/generated'
import type {TaskFilterParams} from '@/client/queries/tasks'
import {
	createProjectDraft,
	isSavedFilterProject,
	useCreateProjectMutation,
	type ProjectResponse,
} from '@/client/queries/projects'

const {t} = useI18n({useScope: 'global'})
const router = useRouter()

const baseStore = useBaseStore()
const projectList = useProjects()
const createProjectMutation = useCreateProjectMutation()
const {currentProject: selectedProject} = useCurrentProject()
const {filterLabelsByQuery, getLabelsByExactTitles} = useLabels()
const {createNewTask} = useQuickAddTask()
const authStore = useAuthStore()

const {isQuickAddMode} = useQuickAddMode()

type QuickActionItem = Command | ITask | ProjectResponse | (ITeam & {title: string}) | Label

enum ACTION_TYPE {
	CMD = 'cmd',
	TASK = 'task',
	PROJECT = 'project',
	TEAM = 'team',
	LABELS = 'labels',
}

enum COMMAND_TYPE {
	NEW_TASK = 'newTask',
	NEW_PROJECT = 'newProject',
	NEW_TEAM = 'newTeam',
}

enum SEARCH_MODE {
	ALL = 'all',
	TASKS = 'tasks',
	PROJECTS = 'projects',
	TEAMS = 'teams',
}

const query = ref('')
const selectedCmd = ref<Command | null>(null)

// A command keeps the dialog and the typed text until it worked; a second Enter meanwhile does nothing.
const running = ref(false)
const commandError = ref('')
const commandErrorId = useId()

const taskSearchParams = ref<TaskFilterParams | null>(null)
const taskQuery = useTasks(
	() => ({params: taskSearchParams.value ?? {}}),
	{enabled: () => taskSearchParams.value !== null},
)
const foundTasks = computed(() => taskSearchParams.value
	? taskQuery.tasks.value
	: [])

const createTeamMutation = useCreateTeamMutation()

interface Command {
	type: COMMAND_TYPE
	title: string
	placeholder: string
	action: () => Promise<void>
}

const commands = computed<{ [key in COMMAND_TYPE]: Command }>(() => ({
	newTask: {
		type: COMMAND_TYPE.NEW_TASK,
		title: t('quickActions.cmds.newTask'),
		placeholder: t('quickActions.newTask'),
		action: newTask,
	},
	newProject: {
		type: COMMAND_TYPE.NEW_PROJECT,
		title: t('quickActions.cmds.newProject'),
		placeholder: t('quickActions.newProject'),
		action: newProject,
	},
	newTeam: {
		type: COMMAND_TYPE.NEW_TEAM,
		title: t('quickActions.cmds.newTeam'),
		placeholder: t('quickActions.newTeam'),
		action: newTeam,
	},
}))

const active = computed(() => baseStore.quickActionsActive)

// The watchEffects below first run synchronously in setup; any const that run reaches must be declared above them.
watchEffect(() => {
	if (!active.value) {
		reset()
	}
})

let focusRafId: number | null = null

watchEffect(() => {
	if (active.value) {
		if (isQuickAddMode) {
			selectedCmd.value = commands.value.newTask
		}

		// The input may not be focusable yet due to:
		// 1. Modal mounts the <dialog> via v-if and then calls showModal() in a
		//    follow-up flush, so v-focus fires while the dialog is still closed
		//    and the focus() call is dropped.
		// 2. In quick-add mode the Electron window isn't visible until
		//    did-finish-load.
		// Retry with rAF until focus actually lands on the input.
		const tryFocus = () => {
			if (!active.value) {
				focusRafId = null
				return
			}
			if (searchInput.value) {
				searchInput.value.focus()
				if (document.activeElement === searchInput.value) {
					focusRafId = null
					return
				}
			}
			focusRafId = requestAnimationFrame(tryFocus)
		}
		focusRafId = requestAnimationFrame(tryFocus)
	} else if (focusRafId !== null) {
		cancelAnimationFrame(focusRafId)
		focusRafId = null
	}
})

function closeQuickActions() {
	baseStore.setQuickActionsActive(false)
}

const foundProjects = computed(() => {
	const {project, text, labels, assignees} = parsedQuery.value

	if (project !== null) {
		return projectList.searchProjectAndFilter(project ?? text)
			.filter(p => Boolean(p))
	}

	if (labels.length > 0 || assignees.length > 0) {
		return []
	}

	if (text === '') {
		const history = getHistory()
		return history.map((p) => projectList.projects[p.id])
			.filter(p => Boolean(p))
	}

	return projectList.searchProjectAndFilter(project ?? text)
		.filter(p => Boolean(p))
})

const foundLabels = computed(() => {
	const {labels, text} = parsedQuery.value
	if (text === '' && labels.length === 0) {
		return []
	}

	if (labels.length > 0) {
		return filterLabelsByQuery([], labels[0])
	}

	return filterLabelsByQuery([], text)
})

// FIXME: use fuzzysearch
const foundCommands = computed(() => availableCmds.value.filter((a) =>
	a.title.toLowerCase().includes(query.value.toLowerCase()),
))

interface Result {
	type: ACTION_TYPE
	title: string
	// singular, unlike the plural group heading in `title`: it is announced per item
	typeLabel: string
	items: QuickActionItem[]
}

const results = computed<Result[]>(() => {
	return [
		{
			type: ACTION_TYPE.CMD,
			title: t('quickActions.commands'),
			typeLabel: t('quickActions.resultTypes.command'),
			items: foundCommands.value,
		},
		{
			type: ACTION_TYPE.PROJECT,
			title: t('quickActions.projects'),
			typeLabel: t('quickActions.resultTypes.project'),
			items: foundProjects.value,
		},
		{
			type: ACTION_TYPE.TASK,
			title: t('quickActions.tasks'),
			typeLabel: t('quickActions.resultTypes.task'),
			items: foundTasks.value,
		},
		{
			type: ACTION_TYPE.LABELS,
			title: t('quickActions.labels'),
			typeLabel: t('quickActions.resultTypes.label'),
			items: foundLabels.value,
		},
		{
			type: ACTION_TYPE.TEAM,
			title: t('quickActions.teams'),
			typeLabel: t('quickActions.resultTypes.team'),
			items: foundTeams.value,
		},
	].filter((i) => i.items.length > 0)
})

function isDone(item: QuickActionItem): boolean {
	return 'done' in item && Boolean(item.done)
}

const placeholder = computed(() => selectedCmd.value?.placeholder || t('quickActions.placeholder'))

const currentProject = computed(() => {
	if (!selectedProject.value || isSavedFilterProject(selectedProject.value)) {
		return null
	}

	return selectedProject.value
})

const hintText = computed(() => {
	if (selectedCmd.value !== null && currentProject.value !== null) {
		switch (selectedCmd.value.type) {
			case COMMAND_TYPE.NEW_TASK:
				return t('quickActions.createTask', {
					title: currentProject.value.title,
				})
			case COMMAND_TYPE.NEW_PROJECT:
				return t('quickActions.createProject')
		}
	}
	const prefixes =
		PREFIXES[authStore.settings.frontend_settings.quick_add_magic_mode] ?? PREFIXES[PrefixMode.Default]
	return t('quickActions.hint', {...prefixes})
})

const availableCmds = computed(() => {
	return [
		commands.value.newTask,
		commands.value.newProject,
		commands.value.newTeam,
	]
})

const parsedQuery = computed(() => parseTaskText(query.value, authStore.settings.frontend_settings.quick_add_magic_mode))

const searchMode = computed(() => {
	if (query.value === '') {
		return SEARCH_MODE.ALL
	}

	const {text, project, labels, assignees} = parsedQuery.value
	if (assignees.length === 0 && text !== '') {
		return SEARCH_MODE.TASKS
	}

	if (
		assignees.length === 0 &&
		project !== null &&
		text === '' &&
		labels.length === 0
	) {
		return SEARCH_MODE.PROJECTS
	}

	if (
		assignees.length > 0 &&
		project === null &&
		text === '' &&
		labels.length === 0
	) {
		return SEARCH_MODE.TEAMS
	}

	return SEARCH_MODE.ALL
})

const isNewTaskCommand = computed(() => (
	selectedCmd.value !== null &&
	selectedCmd.value.type === COMMAND_TYPE.NEW_TASK
))

const taskSearchTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

function searchTasks() {
	if (
		searchMode.value !== SEARCH_MODE.ALL &&
		searchMode.value !== SEARCH_MODE.TASKS &&
		searchMode.value !== SEARCH_MODE.PROJECTS
	) {
		taskSearchParams.value = null
		return
	}

	if (selectedCmd.value !== null) {
		return
	}

	if (taskSearchTimeout.value !== null) {
		clearTimeout(taskSearchTimeout.value)
		taskSearchTimeout.value = null
	}

	const {text, project: projectName, labels} = parsedQuery.value

	let filter = ''

	if (projectName !== null) {
		const project = projectList.findProjectByExactname(projectName)
		if (project !== null) {
			filter += ' project = ' + project.id
		}
	}

	if (labels.length > 0) {
		const labelIds = getLabelsByExactTitles(labels)
			.map(label => label.id)
			.filter((id): id is number => typeof id === 'number')
		if (labelIds.length > 0) {
			filter += 'labels in ' + labelIds.join(', ')
		}
	}

	const params: Partial<TaskFilterParams> = {
		q: text,
		// undone tasks first, most relevant first within each group (relevance is
		// only honored on backends that can score the search, see the API docs)
		sort_by: ['done', 'relevance'],
		filter,
	}

	taskSearchTimeout.value = setTimeout(async () => {
		taskSearchParams.value = params
	}, 150)
}

const teamSearches = refDebounced(computed(() => parsedQuery.value.assignees), 150)
const teamQueries = useQueries({
	queries: computed(() => active.value && query.value !== '' && selectedCmd.value === null &&
		(searchMode.value === SEARCH_MODE.ALL || searchMode.value === SEARCH_MODE.TEAMS)
		? teamSearches.value.map(search => teamSearchQuery(search)) : []),
})
const foundTeams = computed(() => teamQueries.value.flatMap(result => result.data ?? []).map(team => ({...team, title: team.name ?? ''})))
const teamSearchLoading = computed(() => teamQueries.value.some(result => result.isFetching))
const loading = useDelayedLoading(() =>
	taskQuery.isFetching.value ||
	projectList.isLoading ||
	teamSearchLoading.value || createTeamMutation.isPending.value,
)

// Not v-model: it ignores input during IME composition, and Android keyboards
// compose every word. The query would lag behind and the results re-render
// under the finger once tapping one commits the composition.
function updateQuery(event: Event) {
	query.value = (event.target as HTMLInputElement).value
	commandError.value = ''
}

function search() {
	searchTasks()
}

const searchInput = ref<HTMLElement | null>(null)
const quickActionsCard = ref<HTMLElement | null>(null)

const QUICK_ENTRY_WIDTH = 680
const quickEntryMaxHeight = Math.round(window.screen.availHeight * 0.7)
let resizeObserver: ResizeObserver | null = null

if (isQuickAddMode) {
	watch(quickActionsCard, (el) => {
		resizeObserver?.disconnect()
		if (!el) return
		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const height = Math.min(
					Math.ceil(entry.borderBoxSize[0].blockSize),
					quickEntryMaxHeight,
				)
				window.quickEntry?.resize?.(QUICK_ENTRY_WIDTH, height)
			}
		})
		resizeObserver.observe(el)
	})

	onBeforeUnmount(() => {
		resizeObserver?.disconnect()
	})
}

async function doAction(type: ACTION_TYPE, item: QuickActionItem) {
	switch (type) {
		case ACTION_TYPE.PROJECT:
			closeQuickActions()
			if (!isQuickAddMode) {
				await router.push({
					name: 'project.index',
					params: {projectId: (item as ProjectResponse).id},
				})
			}
			break
		case ACTION_TYPE.TASK:
			if (isQuickAddMode) {
				const channel = new BroadcastChannel('vikunja-task-updates')
				channel.postMessage({type: 'task-created-open', taskId: (item as ITask).id})
				channel.close()
				window.quickEntry?.showMainWindow()
			} else {
				await router.push({
					name: 'task.detail',
					params: {id: (item as ITask).id},
				})
			}
			closeQuickActions()
			break
		case ACTION_TYPE.TEAM:
			closeQuickActions()
			if (!isQuickAddMode) {
				await router.push({
					name: 'teams.edit',
					params: {id: (item as ITeam).id},
				})
			}
			break
		case ACTION_TYPE.CMD:
			query.value = ''
			selectedCmd.value = item as Command
			searchInput.value?.focus()
			break
		case ACTION_TYPE.LABELS: {
			const title = item.title ?? ''
			if (/\s/.test(title)) {
				query.value = '*"' + title + '"'
			} else {
				query.value = '*' + title
			}
			searchInput.value?.focus()
			searchTasks()
			break
		}
	}
}

let openTaskAfterCreate = false

function onEnter(event: KeyboardEvent) {
	openTaskAfterCreate = event.ctrlKey || event.metaKey
	doCmd()
}

async function doCmd() {
	// With a command chosen the search results are hidden, so Enter must never run one of them.
	if (selectedCmd.value === null && results.value.length === 1 && results.value[0].items.length === 1) {
		const result = results.value[0]
		doAction(result.type, result.items[0])
		openTaskAfterCreate = false
		return
	}

	if (selectedCmd.value === null || query.value === '') {
		openTaskAfterCreate = false
		return
	}

	if (running.value) return
	running.value = true
	commandError.value = ''
	try {
		await selectedCmd.value.action()
	} catch (cause) {
		openTaskAfterCreate = false
		if (isRequestContextAbort(cause)) return
		commandError.value = cause instanceof Error && cause.message === 'NO_PROJECT'
			? t('project.create.addProjectRequired')
			: t('quickActions.notCreated')
	} finally {
		running.value = false
	}
}

async function newTask() {
	let projectId = authStore.settings.default_project_id
	if (currentProject.value?.id && currentProject.value.id > 0) {
		projectId = currentProject.value.id
	}
	const task = await createNewTask({
		title: query.value,
		project_id: projectId,
	})
	success({message: t('task.createSuccess')})
	if (!isQuickAddMode) closeQuickActions()

	if (isQuickAddMode) {
		const channel = new BroadcastChannel('vikunja-task-updates')
		const type = openTaskAfterCreate ? 'task-created-open' : 'task-created'
		channel.postMessage({type, taskId: task.id})
		channel.close()

		if (openTaskAfterCreate) {
			window.quickEntry?.showMainWindow()
		}

		closeQuickActions()
		openTaskAfterCreate = false
		return
	}

	await router.push({name: 'task.detail', params: {id: task.id}})
}

async function newProject() {
	const parentProjectId = currentProject.value?.id ?? 0
	const created = await createProjectMutation.mutateAsync(createProjectDraft({
		title: query.value,
		parent_project_id: Math.max(parentProjectId, 0),
	}))
	closeQuickActions()
	await router.push({name: 'project.index', params: {projectId: created.id}})
}

async function newTeam() {
	const team = await createTeamMutation.mutateAsync({name: query.value})
	closeQuickActions()
	await router.push({
		name: 'teams.edit',
		params: {id: team.id},
	})
}

type BaseButtonInstance = InstanceType<typeof BaseButton>
const resultRefs = ref<(BaseButtonInstance | null)[][]>([])

function setResultRefs(el: Element | ComponentPublicInstance | null, index: number, key: number) {
	if (resultRefs.value[index] === undefined) {
		resultRefs.value[index] = []
	}

	resultRefs.value[index][key] = el as (BaseButtonInstance | null)
}

function select(parentIndex: number, index: number) {
	if (index < 0 && parentIndex === 0) {
		searchInput.value?.focus()
		return
	}
	if (index < 0) {
		parentIndex--
		index = results.value[parentIndex].items.length - 1
	}
	let elems: BaseButtonInstance | null | undefined = resultRefs.value[parentIndex][index]
	if (results.value[parentIndex].items.length === index) {
		elems = resultRefs.value[parentIndex + 1] ? resultRefs.value[parentIndex + 1][0] : undefined
	}
	if (
		typeof elems === 'undefined'
		/* || elems.length === 0 */
	) {
		return
	}
	if (Array.isArray(elems)) {
		elems[0].focus()
		return
	}
	elems?.focus()
}

function unselectCmd() {
	if (query.value !== '') {
		return
	}
	selectedCmd.value = null
}

function reset() {
	query.value = ''
	selectedCmd.value = null
	commandError.value = ''
}

const resultCount = computed(() => results.value.reduce((total, group) => total + group.items.length, 0))

// Announce the result count to assistive technology, debounced so it doesn't
// fire on every keystroke while the user is still typing.
const resultAnnouncement = ref('')
let announceTimeout: ReturnType<typeof setTimeout> | null = null
watch(resultCount, count => {
	if (!active.value || selectedCmd.value !== null) {
		return
	}
	if (announceTimeout !== null) {
		clearTimeout(announceTimeout)
	}
	announceTimeout = setTimeout(() => {
		resultAnnouncement.value = t('quickActions.results', count)
	}, 300)
})
watch(active, isActive => {
	if (!isActive) {
		resultAnnouncement.value = ''
	}
})
onBeforeUnmount(() => {
	if (announceTimeout !== null) {
		clearTimeout(announceTimeout)
	}
})
</script>

<style lang="scss" scoped>
.quick-actions {
	// global Bulma .card styles are gone (ported into Card.vue, scoped),
	// so this bare .card div needs its own card visuals
	background-color: var(--surface-raised);
	border-radius: var(--radius-lg);
	border: 1px solid var(--border-default);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	overflow: hidden;
	justify-content: flex-start !important;

	&.is-quick-add-mode {
		padding: 0;
		margin: 0;
		border: none;
		box-shadow: none;
	}
}

.action-input {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding-inline: var(--space-2);
	border-block-end: 1px solid var(--border-subtle);

	.input {
		block-size: 3rem;
		border: 0;
		box-shadow: none;
		background: transparent;
		color: var(--text-primary);
		font-size: var(--text-lg);

		@media screen and (max-width: $tablet - 1px) {
			padding-inline-end: var(--space-1);
		}
	}

	&.has-active-cmd .input {
		padding-inline-start: var(--space-1);
	}

	.close {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		inline-size: var(--target-min);
		block-size: var(--target-min);
		border-radius: $radius;
		color: var(--text-secondary);
		font-size: var(--text-lg);

		&:hover {
			background-color: var(--surface-hover);
			color: var(--text-primary);
		}

		@media screen and (min-width: $tablet) {
			display: none;
		}
	}
}

.active-cmd {
	flex-shrink: 0;
	margin-inline-start: var(--space-2);
	border-radius: var(--radius-full);
	background-color: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
}

.quick-actions-error {
	margin: 0;
	padding: var(--space-2) var(--space-4);
	border-block-end: 1px solid var(--border-subtle);
	font-size: var(--text-sm);
}

.quick-actions-hint {
	padding: var(--space-2) var(--space-4);
	border-block-end: 1px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.results {
	inline-size: 100%;
	padding-block: var(--space-1);
	color: var(--text-primary);
	text-align: start;
}

.result + .result {
	margin-block-start: var(--space-1);
}

.result-title {
	display: block;
	padding: var(--space-2) var(--space-4) var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

.result-items {
	padding-inline: var(--space-1);
}

.result-item-button {
	display: block;
	inline-size: 100%;
	min-block-size: var(--nav-row-height);
	padding: var(--space-2) var(--space-3);
	border: none;
	border-radius: var(--radius-sm);
	background: transparent;
	box-shadow: none;
	color: var(--text-primary);
	font-family: $family-sans-serif;
	font-size: var(--text-md);
	font-weight: normal;
	text-align: start;
	text-transform: none;
	cursor: pointer;

	&:hover {
		background-color: var(--surface-hover);
	}

	// Arrow keys move focus through the rows, so the focused row reads as the selection.
	&:focus,
	&:active {
		background-color: var(--surface-selected);
		box-shadow: none !important;
	}

	&:focus-visible {
		outline-offset: -2px;
	}

	.saved-filter-icon {
		inline-size: .75rem;
		margin-inline-end: var(--space-1);
		color: var(--text-tertiary);
		font-size: var(--text-xs);
	}

	&:has(.saved-filter-icon) {
		display: flex;
		align-items: center;
	}
}
</style>
