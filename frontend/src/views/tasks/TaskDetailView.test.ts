import {createPinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, shallowMount, type VueWrapper} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	tasksRead: vi.fn(),
	patchTasksRead: vi.fn(),
	tasksList: vi.fn(async () => ({data: {items: []}})),
	projectTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewBucketsTasksList: vi.fn(async () => ({data: {items: []}})),
	bucketsList: vi.fn(async () => ({data: {items: []}})),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
vi.mock('@/composables/useLabels', () => ({useLabels: () => ({filterLabelsByQuery: () => [], isPending: {value: false}, getLabelById: vi.fn()})}))
vi.mock('vuemoji-picker', () => ({VuemojiPicker: {render: () => null}}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import {mapTaskEverywhere} from '@/client/queries/taskCache'
import EditLabels from '@/components/tasks/partials/EditLabels.vue'
import PercentDoneSelect from '@/components/tasks/partials/PercentDoneSelect.vue'
import Datepicker from '@/components/input/Datepicker.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import TaskDetailView from './TaskDetailView.vue'

enableAutoUnmount(afterEach)

function serverTask(id: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		title: `Task ${id}`,
		description: '',
		done: false,
		project_id: 1,
		percent_done: 0.25,
		due_date: '2024-01-01T10:00:00Z',
		labels: [{id: 1, title: 'First'}],
		assignees: [],
		max_permission: 2,
		...overrides,
	}
}

let queryClient: QueryClient

function dueDatePicker(wrapper: VueWrapper) {
	return wrapper.findAllComponents(Datepicker)[0]!
}

async function mountDetail(taskId = 1) {
	queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', component: {render: () => null}},
			{path: '/tasks/:id', name: 'task.detail', component: {render: () => null}},
			{path: '/projects/:projectId', name: 'project.index', component: {render: () => null}},
			{path: '/:pathMatch(.*)*', name: 'not-found', component: {render: () => null}},
		],
	})
	await router.push('/')
	const wrapper = shallowMount(TaskDetailView, {
		props: {taskId},
		global: {
			plugins: [createPinia(), router, [VueQueryPlugin, {queryClient}]],
			mocks: {$t: (key: string) => key},
			stubs: {Icon: true, XButton: true, Modal: true, CustomTransition: {template: '<div><slot/></div>'}},
			directives: {tooltip: () => {}, cy: () => {}, shortcut: () => {}},
		},
	})
	await flushPromises()
	return wrapper
}

describe('TaskDetailView draft', () => {
	beforeEach(() => {
		sdk.tasksRead.mockReset()
		sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: serverTask(path.task)}))
		sdk.patchTasksRead.mockReset()
		sdk.patchTasksRead.mockImplementation(async () => ({data: serverTask(1)}))
	})

	it('keeps unsaved edits when the cached task changes and follows mutation-owned fields', async () => {
		const wrapper = await mountDetail()
		expect(dueDatePicker(wrapper).props('modelValue')).toEqual(new Date('2024-01-01T10:00:00Z'))

		dueDatePicker(wrapper).vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		await flushPromises()

		mapTaskEverywhere(queryClient, 1, task => ({...task, is_unread: true, labels: [{id: 1, title: 'First'}, {id: 2, title: 'Second'}]}))
		await flushPromises()

		expect(sdk.patchTasksRead).not.toHaveBeenCalled()
		expect(dueDatePicker(wrapper).props('modelValue')).toEqual(new Date('2024-02-02T10:00:00Z'))
		expect(wrapper.findComponent(EditLabels).props('modelValue')).toEqual([{id: 1, title: 'First'}, {id: 2, title: 'Second'}])
	})

	it('reseeds the draft when the task id changes', async () => {
		const wrapper = await mountDetail()
		dueDatePicker(wrapper).vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		await flushPromises()

		await wrapper.setProps({taskId: 2})
		await flushPromises()

		expect(dueDatePicker(wrapper).props('modelValue')).toEqual(new Date('2024-01-01T10:00:00Z'))
	})

	it('saves only progress and preserves unrelated draft fields', async () => {
		sdk.patchTasksRead.mockImplementation(async () => ({data: serverTask(1, {percent_done: 0.9, due_date: '2024-03-03T10:00:00Z'})}))
		const wrapper = await mountDetail()
		// Picked but not saved yet: an unsaved edit outlives the response, a clean field would follow it.
		dueDatePicker(wrapper).vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		await flushPromises()

		wrapper.findComponent(PercentDoneSelect).vm.$emit('update:modelValue', 0.9)
		await flushPromises()

		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(wrapper.findAllComponents(Datepicker)[0]?.props('modelValue')).toEqual(new Date('2024-02-02T10:00:00Z'))
		expect(wrapper.findComponent(PercentDoneSelect).props('modelValue')).toBe(0.9)
		expect(sdk.patchTasksRead.mock.calls[0][0].body).toEqual([{op: 'add', path: '/percent_done', value: 0.9}])
	})
	it('ignores duplicate progress submissions while saving', async () => {
		let resolve!: (value: unknown) => void
		sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
		const wrapper = await mountDetail()
		const progress = wrapper.findComponent(PercentDoneSelect)
		progress.vm.$emit('update:modelValue', 0.5)
		progress.vm.$emit('update:modelValue', 0.8)
		await flushPromises()
		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(progress.props('disabled')).toBe(true)
		resolve({data: serverTask(1, {percent_done: 0.5})})
		await flushPromises()
		expect(progress.props('modelValue')).toBe(0.5)
		expect(progress.props('disabled')).toBe(false)
	})

	it('does not overwrite progress after navigating to a different task during save', async () => {
		let resolve!: (value: unknown) => void
		sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
		const wrapper = await mountDetail()
		wrapper.findComponent(PercentDoneSelect).vm.$emit('update:modelValue', 0)
		await flushPromises()
		await wrapper.setProps({taskId: 2})
		await flushPromises()
		resolve({data: serverTask(1, {percent_done: 0})})
		await flushPromises()
		expect(wrapper.findComponent(PercentDoneSelect).props('modelValue')).toBe(0.25)
	})
})

describe('TaskDetailView live updates', () => {
	beforeEach(() => {
		sdk.tasksRead.mockReset()
		sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: serverTask(path.task)}))
		sdk.patchTasksRead.mockReset()
	})

	it('shows a skeleton only until the first task arrives', async () => {
		let resolve!: (value: unknown) => void
		sdk.tasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
		const wrapper = await mountDetail()

		expect(wrapper.find('.task-view-skeleton').exists()).toBe(true)
		expect(wrapper.find('.task-view').exists()).toBe(false)

		resolve({data: serverTask(1)})
		await flushPromises()

		expect(wrapper.find('.task-view-skeleton').exists()).toBe(false)
		expect(wrapper.find('.task-view').exists()).toBe(true)
	})

	it('keeps the task on screen while a field saves and marks only that field busy', async () => {
		let resolve!: (value: unknown) => void
		sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
		const wrapper = await mountDetail()

		dueDatePicker(wrapper).vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		dueDatePicker(wrapper).vm.$emit('closeOnChange')
		await flushPromises()
		// The per-field pending state is delayed so fast saves never flicker.
		await new Promise(done => setTimeout(done, 150))

		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(wrapper.find('.task-view').exists()).toBe(true)
		expect(wrapper.find('.task-view-container').classes()).not.toContain('is-loading')
		expect(dueDatePicker(wrapper).element.closest('.column')?.getAttribute('aria-busy')).toBe('true')
		expect(wrapper.findComponent(EditLabels).exists()).toBe(true)

		resolve({data: serverTask(1, {due_date: '2024-02-02T10:00:00Z'})})
		await flushPromises()

		expect(dueDatePicker(wrapper).element.closest('.column')?.hasAttribute('aria-busy')).toBe(false)
	})

	it('says which field was not saved, retries it, and clears the notice once it is saved', async () => {
		sdk.patchTasksRead.mockRejectedValueOnce(new Error('Server error'))
		const wrapper = await mountDetail()

		dueDatePicker(wrapper).vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		dueDatePicker(wrapper).vm.$emit('closeOnChange')
		await flushPromises()

		const notice = wrapper.find('.task-fields-not-saved')
		expect(notice.exists()).toBe(true)
		expect(notice.attributes('role')).toBe('alert')
		expect(notice.text()).toContain('task.detail.fieldsNotSaved')

		sdk.patchTasksRead.mockResolvedValueOnce({data: serverTask(1, {due_date: '2024-02-02T10:00:00Z'})})
		await notice.findComponent(BaseButton).vm.$emit('click')
		await flushPromises()

		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(2)
		expect(sdk.patchTasksRead.mock.calls[1][0]).toEqual(expect.objectContaining({
			body: expect.arrayContaining([expect.objectContaining({path: '/due_date'})]),
		}))
		expect(wrapper.find('.task-fields-not-saved').exists()).toBe(false)
	})

	it('shows an inline error with retry when the first load fails', async () => {
		sdk.tasksRead.mockRejectedValueOnce({status: 500})
		const wrapper = await mountDetail()

		const loadError = wrapper.findComponent(LoadError)
		expect(loadError.exists()).toBe(true)
		expect(wrapper.find('.task-view').exists()).toBe(false)

		await (loadError.props('retry') as () => unknown)()
		await flushPromises()

		expect(sdk.tasksRead).toHaveBeenCalledTimes(2)
		expect(wrapper.findComponent(LoadError).exists()).toBe(false)
		expect(wrapper.find('.task-view').exists()).toBe(true)
	})
})
