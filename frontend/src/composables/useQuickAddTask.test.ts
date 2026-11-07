import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {flushPromises, mount} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({
	tasksCreate: vi.fn(),
	tasksBulkCreate: vi.fn(),
	labelsList: vi.fn(),
	labelsCreate: vi.fn(),
	taskLabelsCreate: vi.fn(),
	taskAssigneesCreate: vi.fn(),
	projectsUsersSearch: vi.fn(),
	projectsList: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))
vi.mock('vue-router', async importOriginal => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRouter: () => ({currentRoute: {value: {params: {}}}}),
}))

import {error} from '@/message'
import {useQuickAddTask} from './useQuickAddTask'
import {queryClient as sharedQueryClient} from '@/client/queryClient'

const cleanup: (() => void)[] = []

function quickAdd() {
	let actions!: ReturnType<typeof useQuickAddTask>
	const queryClient = new QueryClient()
	const wrapper = mount(defineComponent({
		setup() {
			actions = useQuickAddTask()
			return () => null
		},
	}), {global: {plugins: [createPinia(), [VueQueryPlugin, {queryClient}]]}})
	cleanup.push(() => { wrapper.unmount(); queryClient.clear() })
	return actions
}

describe('useQuickAddTask', () => {
	beforeEach(() => {
		sharedQueryClient.clear()
		vi.mocked(error).mockClear()
		Object.values(sdk).forEach(mock => mock.mockReset())
		sdk.labelsList.mockResolvedValue({data: {items: [], total_pages: 1}})
		sdk.projectsUsersSearch.mockResolvedValue({data: {items: []}})
		sdk.projectsList.mockResolvedValue({data: {items: [], total_pages: 1}})
		sdk.taskAssigneesCreate.mockResolvedValue({data: {}})
	})
	afterEach(() => {
		cleanup.splice(0).forEach(dispose => dispose())
		sharedQueryClient.clear()
	})

	it('stays busy while resolving a member before any task mutation starts', async () => {
		let resolve!: (value: unknown) => void
		sdk.projectsUsersSearch.mockReturnValue(new Promise(done => { resolve = done }))
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: 'Review', project_id: 1}})
		const actions = quickAdd()
		const pending = actions.createNewTask({title: 'Review @jane', project_id: 1})
		await flushPromises()
		const creatingBeforeResolution = sdk.tasksCreate.mock.calls.length
		const busyBeforeResolution = actions.isLoading.value
		resolve({data: {items: [{id: 3, username: 'jane'}]}})
		await pending
		expect(creatingBeforeResolution).toBe(0)
		expect(busyBeforeResolution).toBe(true)
		expect(actions.isLoading.value).toBe(false)
	})

	it('returns a saved task and one clear notice when attaching its member fails', async () => {
		sdk.projectsUsersSearch.mockResolvedValue({data: {items: [{id: 3, username: 'jane'}]}})
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: 'Review', project_id: 1}})
		sdk.taskAssigneesCreate.mockRejectedValue({status: 500})
		const actions = quickAdd()
		await expect(actions.createNewTask({title: 'Review @jane', project_id: 1}))
			.resolves.toMatchObject({id: 7, title: 'Review', assignees: []})
		expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledWith({message: expect.stringContaining('@jane')})
		expect(actions.isLoading.value).toBe(false)
	})

	it('keeps successful labels and reports only unsaved additions after task creation', async () => {
		sdk.labelsList.mockResolvedValue({data: {items: [
			{id: 9, title: 'Urgent'},
			{id: 10, title: 'Research'},
		], total_pages: 1}})
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: 'Review', project_id: 1}})
		sdk.taskLabelsCreate.mockImplementation(async ({body}: {body: {label_id: number}}) => {
			if (body.label_id === 9) throw {status: 500}
			return {data: {}}
		})
		const task = await quickAdd().createNewTask({title: 'Review *Urgent *Research', project_id: 1})
		expect(task).toMatchObject({id: 7, title: 'Review', labels: [{id: 10, title: 'Research'}]})
		expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledWith({message: expect.stringContaining('*Urgent')})
	})

	it('strips a matched assignee from the created title', async () => {
		sdk.projectsUsersSearch.mockResolvedValue({data: {items: [{id: 3, username: 'jane'}]}})
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: 'Buy milk', project_id: 1}})

		await quickAdd().createNewTask({title: 'Buy milk @jane', project_id: 1})

		expect(sdk.tasksCreate).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({title: 'Buy milk'}),
		}))
	})

	it('keeps the created task when its label cannot be created', async () => {
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: 'Buy milk', project_id: 1}})
		sdk.labelsCreate.mockRejectedValue({status: 500})

		const task = await quickAdd().createNewTask({title: 'Buy milk *Urgent', project_id: 1})

		expect(task).toMatchObject({id: 7, title: 'Buy milk'})
		expect(task.labels).toEqual([])
		expect(sdk.taskLabelsCreate).not.toHaveBeenCalled()
		expect(error).toHaveBeenCalledTimes(1)
		expect(error).toHaveBeenCalledWith({message: expect.stringContaining('Urgent')})
	})

	it('creates no label when the whole title is magic', async () => {
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: '*Urgent', project_id: 1}})

		const task = await quickAdd().createNewTask({title: '*Urgent', project_id: 1})

		expect(sdk.tasksCreate).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({title: '*Urgent'}),
		}))
		expect(task).toMatchObject({id: 7, title: '*Urgent'})
		expect(sdk.labelsCreate).not.toHaveBeenCalled()
		expect(sdk.taskLabelsCreate).not.toHaveBeenCalled()
	})

	it('keeps a title that is only a project prefix in the input project', async () => {
		sdk.projectsList.mockResolvedValue({data: {items: [{id: 42, title: 'Other'}], total_pages: 1}})
		sdk.tasksCreate.mockResolvedValue({data: {id: 7, title: '+Other', project_id: 1}})

		await quickAdd().createNewTask({title: '+Other', project_id: 1})

		expect(sdk.tasksCreate).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({title: '+Other', project_id: 1}),
		}))
		expect(sdk.projectsUsersSearch).not.toHaveBeenCalled()
		expect(sdk.labelsCreate).not.toHaveBeenCalled()
		expect(sdk.taskLabelsCreate).not.toHaveBeenCalled()
	})

	it('does not toast per task when the same label create keeps failing in a bulk add', async () => {
		sdk.tasksBulkCreate.mockResolvedValue({
			data: {
				tasks: [
					{id: 7, project_id: 1},
					{id: 8, project_id: 1},
					{id: 9, project_id: 1},
				],
			},
		})
		sdk.labelsCreate.mockRejectedValue({status: 500})

		const result = await quickAdd().createNewTasksBulk([
			{title: 'One *Urgent', project_id: 1},
			{title: 'Two *Urgent', project_id: 1},
			{title: 'Three *Urgent', project_id: 1},
		])

		expect(result.tasks).toHaveLength(3)
		expect(sdk.taskLabelsCreate).not.toHaveBeenCalled()
		expect(error).not.toHaveBeenCalled()
	})

	it('reports a failed label write on a bulk create without failing the create', async () => {
		sdk.labelsList.mockResolvedValue({data: {items: [{id: 9, title: 'Urgent'}], total_pages: 1}})
		sdk.tasksBulkCreate.mockResolvedValue({data: {tasks: [{id: 7, title: 'Buy milk', project_id: 1}]}})
		sdk.taskLabelsCreate.mockRejectedValue({status: 500})

		const result = await quickAdd().createNewTasksBulk([{title: 'Buy milk *Urgent', project_id: 1}])

		expect(result.error).toBeNull()
		expect(result.tasks[0]).toMatchObject({id: 7, title: 'Buy milk'})
		expect(sdk.labelsCreate).not.toHaveBeenCalled()
		expect(error).toHaveBeenCalledTimes(1)
	})
})
