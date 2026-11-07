import {computed, ref} from 'vue'
import {useRouter} from 'vue-router'
import type {Task, Label} from '@/client/generated'
import {
	useCreateTaskMutation,
	useBulkCreateTasksMutation,
	useAddTaskAssigneeMutation,
	useAddTaskLabelMutation,
} from '@/client/queries/taskMutations'
import {ensureLabels, refreshLabels, getLabelByExactTitle, useCreateLabelMutation} from '@/client/queries/labels'
import {ensureProjects, findProjectByExactTitle} from '@/client/queries/projects'
import {searchProjectUsers} from '@/client/queries/userSearch'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'
import {parseTaskText, PREFIXES} from '@/modules/quickAddMagic'
import {buildQuickAddTask} from '@/helpers/task'
import {getRandomColorHex} from '@/helpers/color/randomColor'
import {runWrites} from '@/helpers/runWrites'
import {error} from '@/message'
import {i18n} from '@/i18n'
import {taskRemindersFromSettings} from '@/helpers/userSettings'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	type ClientRequestContext,
} from '@/client/requestContext'

interface ResolvedLabels {
	labels: Label[]
	skipped: string[]
}

export function reportSkippedLabels(skipped: string[]) {
	if (!skipped.length) return
	error({message: i18n.global.t('task.label.createFailed', {labels: skipped.join(', ')})})
}

export function useQuickAddTask() {
	const create = useCreateTaskMutation()
	const bulk = useBulkCreateTasksMutation()
	const addAssignee = useAddTaskAssigneeMutation()
	const addLabel = useAddTaskLabelMutation()
	const createLabel = useCreateLabelMutation()
	const auth = useAuthStore()
	const config = useConfigStore()
	const router = useRouter()
	const pendingOperations = ref(0)

	function reportIncompleteDetails(details: string[]) {
		if (!details.length) return
		error({message: i18n.global.t('task.quickAdd.detailsIncomplete', {details: [...new Set(details)].join(', ')})})
	}

	async function findProjectId({project, projectId}: {project?: string | null, projectId: number}) {
		if (project) {
			const {projects} = await ensureProjects()
			const found = findProjectByExactTitle(projects, project)
				?? projects.find(item => item.identifier?.toLowerCase() === project.toLowerCase())
			if (found?.id) return found.id
		}
		const routeProjectId = Number(router.currentRoute.value.params.projectId)
		const id = projectId > 0 ? projectId : routeProjectId
		if (!(id > 0)) throw new Error('NO_PROJECT')
		return id
	}

	async function ensureLabelsExist(titles: string[], context = captureClientRequestContext()): Promise<ResolvedLabels> {
		const wanted = [...new Set(titles)]
		if (!wanted.length) return {labels: [], skipped: []}
		assertClientRequestContext(context)
		let labels: Label[] = []
		try {
			labels = await ensureLabels()
			if (wanted.some(title => !getLabelByExactTitle(labels, title))) labels = await refreshLabels()
		} catch {
			assertClientRequestContext(context)
		}
		const found = await Promise.all(wanted.map(async title => {
			assertClientRequestContext(context)
			const existing = getLabelByExactTitle(labels, title)
			if (existing) return {title, label: existing}
			// A label must never fail the task it belongs to; the caller summarises what was skipped.
			try {
				return {title, label: await createLabel.mutateAsync({title, hex_color: getRandomColorHex()})}
			} catch {
				assertClientRequestContext(context)
				return {title, label: undefined}
			}
		}))
		return {
			labels: found.map(({label}) => label).filter((label): label is Label => label !== undefined),
			skipped: found.filter(({label}) => label === undefined).map(({title}) => title),
		}
	}

	async function build(input: Partial<Task>, context: ClientRequestContext) {
		const mode = auth.settings.frontend_settings.quick_add_magic_mode
		const parsed = parseTaskText(input.title ?? '', mode)
		// A title that is only magic stays a literal title: nothing parsed out of it may move or decorate the task.
		const magicOnly = !parsed.text
		const project_id = await findProjectId({
			project: magicOnly ? null : parsed.project,
			projectId: input.project_id ?? 0,
		})
		assertClientRequestContext(context)
		const matches = magicOnly ? [] : await Promise.all(parsed.assignees.map(async match => {
			const users = await searchProjectUsers(project_id, match)
			const query = match.toLowerCase()
			const user = users.find(user => [user.username, user.name, user.email].some(value => users.length === 1
				? value?.toLowerCase().includes(query)
				: value?.toLowerCase() === query))
			return user ? {...user, match} : undefined
		}))
		assertClientRequestContext(context)
		const defaults = taskRemindersFromSettings(auth.settings.frontend_settings.quick_add_default_reminders)
		return {
			task: buildQuickAddTask(
				parsed,
				{...input, project_id},
				PREFIXES[mode],
				matches.filter(user => user !== undefined),
				defaults,
			),
			parsedLabels: magicOnly ? [] : parsed.labels,
		}
	}

	async function addLabelsToTask(
		{task, parsedLabels}: {task: Task, parsedLabels: string[]},
		context = captureClientRequestContext(),
	) {
		const {labels, skipped} = await ensureLabelsExist(parsedLabels, context)
		const saved = new Set<number>()
		const incomplete: string[] = []
		await runWrites(labels, async label => {
			assertClientRequestContext(context)
			try {
				await addLabel.mutateAsync({taskId: task.id!, label: {...label, id: label.id!}, notifyError: false})
				saved.add(label.id!)
			} catch {
				assertClientRequestContext(context)
				incomplete.push(`*${label.title}`)
			}
		}, config.concurrent_writes)
		const existing = task.labels ?? []
		return {
			task: {...task, labels: [...existing, ...labels.filter(label => saved.has(label.id!) && !existing.some(item => item.id === label.id))]},
			skipped,
			incomplete,
		}
	}

	async function finishTask(task: Task, built: Awaited<ReturnType<typeof build>>, context: ClientRequestContext) {
		assertClientRequestContext(context)
		const assignees = [...(task.assignees ?? [])]
		const incomplete: string[] = []
		await runWrites(built.task.assignees ?? [], async user => {
			assertClientRequestContext(context)
			try {
				await addAssignee.mutateAsync({taskId: task.id!, user: {...user, id: user.id!}, notifyError: false})
				if (!assignees.some(item => item.id === user.id)) assignees.push(user)
			} catch {
				assertClientRequestContext(context)
				incomplete.push(`@${user.username ?? user.name ?? user.id}`)
			}
		}, config.concurrent_writes)
		const result = await addLabelsToTask(
			{task: {...task, assignees}, parsedLabels: built.parsedLabels},
			context,
		)
		return {...result, incomplete: [...incomplete, ...result.incomplete]}
	}

	async function createNewTask(input: Partial<Task>) {
		pendingOperations.value++
		try {
			const context = captureClientRequestContext()
			const built = await build(input, context)
			assertClientRequestContext(context)
			const created = await create.mutateAsync({...built.task, project_id: built.task.project_id!})
			const {task, skipped, incomplete} = await finishTask(created, built, context)
			assertClientRequestContext(context)
			if (incomplete.length) reportIncompleteDetails([...incomplete, ...skipped.map(title => `*${title}`)])
			else reportSkippedLabels(skipped)
			return task
		} finally {
			pendingOperations.value--
		}
	}

	async function createNewTasksBulk(entries: {title: string, project_id: number}[], beforeCreate?: () => void) {
		pendingOperations.value++
		try {
			const context = captureClientRequestContext()
			const built = await Promise.all(entries.map(entry => build(entry, context)))
			assertClientRequestContext(context)
			beforeCreate?.()
			const result = await bulk.mutateAsync(built.map(item => item.task))
			const incomplete: string[] = []
			await runWrites(built.map((item, index) => ({item, index})), async ({item, index}) => {
				const task = result.tasks[index]
				if (!task) return
				// Only failed creates restore the typed title; failed additions must not duplicate a saved task.
				const finished = await finishTask(task, item, context)
				result.tasks[index] = finished.task
				incomplete.push(...finished.incomplete)
			}, config.concurrent_writes)
			assertClientRequestContext(context)
			reportIncompleteDetails(incomplete)
			return result
		} finally {
			pendingOperations.value--
		}
	}

	return {
		isLoading: computed(() => pendingOperations.value > 0 || [create, bulk, addAssignee, addLabel, createLabel].some(mutation => mutation.isPending.value)),
		createNewTask,
		createNewTasksBulk,
		findProjectId,
		ensureLabelsExist,
	}
}
