import {createPinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, shallowMount, type VueWrapper} from '@vue/test-utils'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	tasksRead: vi.fn(),
	patchTasksRead: vi.fn(),
	tasksDuplicate: vi.fn(),
	tasksList: vi.fn(async () => ({data: {items: []}})),
	projectTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewBucketsTasksList: vi.fn(async () => ({data: {items: []}})),
	bucketsList: vi.fn(async () => ({data: {items: []}})),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn(), getErrorText: (cause: Error) => cause.message}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
vi.mock('@/composables/useLabels', () => ({useLabels: () => ({filterLabelsByQuery: () => [], isPending: {value: false}, getLabelById: vi.fn()})}))
vi.mock('vuemoji-picker', () => ({VuemojiPicker: {render: () => null}}))
// The base store probes the API on creation and swaps window.API_URL while it does; the view's saves are fenced on
// that URL (a save never goes to another server), so the probe must not run in the middle of these tests.
vi.mock('@/helpers/checkAndSetApiUrl', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/checkAndSetApiUrl')>(),
	checkAndSetApiUrl: vi.fn(async () => window.API_URL),
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))
// A plain textarea stands in for TipTap so the description draft can be typed.
vi.mock('@/components/input/AsyncEditor', async () => {
	const {defineComponent} = await import('vue')
	return {default: defineComponent({
		name: 'DescriptionEditorMock',
		props: ['modelValue'],
		emits: ['update:modelValue', 'save'],
		template: '<div><textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/></div>',
	})}
})

import type {Task} from '@/client/generated'
import {applyServerTaskDeleted, applyServerTaskUpdated} from '@/client/queries/taskMutations'
import {taskKeys} from '@/client/queries/tasks'
import Datepicker from '@/components/input/Datepicker.vue'
import ColorPicker from '@/components/input/ColorPicker.vue'
import Heading from '@/components/tasks/partials/Heading.vue'
import PercentDoneSelect from '@/components/tasks/partials/PercentDoneSelect.vue'
import PrioritySelect from '@/components/tasks/partials/PrioritySelect.vue'
import Reminders from '@/components/tasks/partials/Reminders.vue'
import TaskDetailView from './TaskDetailView.vue'

enableAutoUnmount(afterEach)

const API_ZERO_DATE = '0001-01-01T00:00:00Z'

// max_permission is only in the detail response, not in the generated Task type.
function serverTask(id: number, overrides: Partial<Task> = {}): Task & {max_permission: number} {
	return {
		id,
		title: `Task ${id}`,
		description: '<p>Stored notes</p>',
		done: false,
		project_id: 1,
		percent_done: 0.25,
		priority: 1,
		due_date: '2024-01-01T10:00:00Z',
		labels: [],
		assignees: [],
		max_permission: 2,
		updated: '2024-01-01T00:00:00Z',
		...overrides,
	}
}

// What another client or an Arona receipt wrote after the view loaded.
const later = (overrides: Partial<Task>) => serverTask(1, {
	updated: '2024-01-02T00:00:00Z',
	...overrides,
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {resolve = done})
	return {promise, resolve}
}

let queryClient: QueryClient
let router: Router

async function mountDetail(taskId = 1, stubs: Record<string, boolean> = {}) {
	queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
	router = createRouter({
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
			stubs: {
				Icon: true,
				XButton: true,
				Modal: true,
				CustomTransition: {template: '<div><slot/></div>'},
				Description: false,
				DescriptionEditorMock: false,
				...stubs,
			},
			directives: {tooltip: () => {}, cy: () => {}, shortcut: () => {}},
		},
	})
	await flushPromises()
	return wrapper
}

function datepicker(wrapper: VueWrapper, field: 'dueDate' | 'startDate' | 'endDate') {
	return wrapper.findAllComponents(Datepicker).find(picker => picker.props('title') === `task.attributes.${field}`)
}

function patchBody(call = 0) {
	return sdk.patchTasksRead.mock.calls[call][0].body
}

beforeEach(() => {
	vi.clearAllMocks()
	sdk.tasksRead.mockReset()
	sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: serverTask(path.task)}))
	sdk.patchTasksRead.mockReset()
})

describe('TaskDetailView follows server changes', () => {
	it('shows dates, progress, priority and colour written elsewhere when they were not edited here', async () => {
		const wrapper = await mountDetail()
		await wrapper.find('x-button-stub[icon="fill-drip"]').trigger('click')
		await flushPromises()
		expect(wrapper.findComponent(ColorPicker).props('modelValue')).toBe('')

		await applyServerTaskUpdated(queryClient, later({
			due_date: '2024-05-05T10:00:00Z',
			start_date: '2024-04-01T10:00:00Z',
			end_date: '2024-05-20T10:00:00Z',
			percent_done: 0.6,
			priority: 3,
			hex_color: 'e8590c',
		}))
		await flushPromises()

		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toEqual(new Date('2024-05-05T10:00:00Z'))
		expect(datepicker(wrapper, 'startDate')?.props('modelValue')).toEqual(new Date('2024-04-01T10:00:00Z'))
		expect(datepicker(wrapper, 'endDate')?.props('modelValue')).toEqual(new Date('2024-05-20T10:00:00Z'))
		expect(wrapper.findComponent(PercentDoneSelect).props('modelValue')).toBe(0.6)
		expect(wrapper.findComponent(PrioritySelect).props('modelValue')).toBe(3)
		expect(wrapper.findComponent(Heading).props('task').hex_color).toBe('e8590c')
		expect(wrapper.findComponent(ColorPicker).props('modelValue')).toBe('e8590c')
		expect(sdk.patchTasksRead).not.toHaveBeenCalled()
	})

	it('keeps a description draft and an unsaved field while a refetch updates the rest', async () => {
		const wrapper = await mountDetail()
		await wrapper.find('.tiptap__task-description textarea').setValue('<p>Draft that is not saved yet</p>')
		datepicker(wrapper, 'dueDate')!.vm.$emit('update:modelValue', new Date('2024-02-02T10:00:00Z'))
		await flushPromises()

		sdk.tasksRead.mockImplementation(async () => ({data: later({
			due_date: '2024-06-06T10:00:00Z',
			start_date: '2024-04-01T10:00:00Z',
			priority: 3,
			title: 'Renamed elsewhere',
		})}))
		await queryClient.invalidateQueries({queryKey: taskKeys.details})
		await flushPromises()

		expect(sdk.tasksRead).toHaveBeenCalledTimes(2)
		expect((wrapper.find('.tiptap__task-description textarea').element as HTMLTextAreaElement).value)
			.toBe('<p>Draft that is not saved yet</p>')
		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toEqual(new Date('2024-02-02T10:00:00Z'))
		expect(datepicker(wrapper, 'startDate')?.props('modelValue')).toEqual(new Date('2024-04-01T10:00:00Z'))
		expect(wrapper.findComponent(PrioritySelect).props('modelValue')).toBe(3)
		expect(wrapper.findComponent(Heading).props('task').title).toBe('Renamed elsewhere')
		expect(sdk.patchTasksRead).not.toHaveBeenCalled()

		// Saving the picked date sends that date alone, not the values the refetch brought in.
		sdk.patchTasksRead.mockImplementation(async () => ({data: later({
			due_date: '2024-02-02T10:00:00Z',
			start_date: '2024-04-01T10:00:00Z',
			priority: 3,
			title: 'Renamed elsewhere',
		})}))
		datepicker(wrapper, 'dueDate')!.vm.$emit('closeOnChange', false)
		await flushPromises()

		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(patchBody()).toEqual([{op: 'add', path: '/due_date', value: '2024-02-02T10:00:00.000Z'}])
		expect((wrapper.find('.tiptap__task-description textarea').element as HTMLTextAreaElement).value)
			.toBe('<p>Draft that is not saved yet</p>')
	})

	it('leaves reminders and dates alone when an update elsewhere did not change them', async () => {
		const reminders = [{
			relative_to: 'due_date',
			relative_period: -3600,
			reminder: '2024-01-01T09:00:00Z',
		}]
		sdk.tasksRead.mockImplementation(async () => ({data: serverTask(1, {reminders})}))
		const wrapper = await mountDetail()
		// An open reminder popup or datepicker resets whenever it receives a new object.
		const shown = wrapper.findComponent(Reminders).props('modelValue')
		const due = datepicker(wrapper, 'dueDate')?.props('modelValue')

		await applyServerTaskUpdated(queryClient, later({
			reminders,
			priority: 3,
		}))
		await flushPromises()

		expect(wrapper.findComponent(PrioritySelect).props('modelValue')).toBe(3)
		expect(wrapper.findComponent(Reminders).props('modelValue')).toBe(shown)
		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toBe(due)
	})

	it('saves only the edited field after a background change and keeps the newer server values', async () => {
		const wrapper = await mountDetail()
		await wrapper.find('x-button-stub[icon="fill-drip"]').trigger('click')
		await applyServerTaskUpdated(queryClient, later({
			due_date: '2024-05-05T10:00:00Z',
			percent_done: 0.6,
			hex_color: 'e8590c',
		}))
		await flushPromises()

		sdk.patchTasksRead.mockImplementation(async () => ({data: later({
			due_date: '2024-05-05T10:00:00Z',
			percent_done: 0.6,
			hex_color: 'e8590c',
			priority: 4,
			updated: '2024-01-03T00:00:00Z',
		})}))
		wrapper.findComponent(PrioritySelect).vm.$emit('update:modelValue', 4)
		await flushPromises()

		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(patchBody()).toEqual([{op: 'add', path: '/priority', value: 4}])
		expect(wrapper.findComponent(PrioritySelect).props('modelValue')).toBe(4)
		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toEqual(new Date('2024-05-05T10:00:00Z'))
		expect(wrapper.findComponent(PercentDoneSelect).props('modelValue')).toBe(0.6)
		expect(wrapper.findComponent(ColorPicker).props('modelValue')).toBe('e8590c')
		expect(queryClient.getQueryData<Task>(taskKeys.detail(1, ['reactions', 'is_unread', 'buckets']))).toMatchObject({
			due_date: '2024-05-05T10:00:00Z',
			percent_done: 0.6,
			hex_color: 'e8590c',
			priority: 4,
		})
	})
})

describe('TaskDetailView title draft', () => {
	function typeTitle(heading: HTMLElement, title: string) {
		heading.textContent = title
		heading.dispatchEvent(new Event('input'))
	}

	it('keeps a title being typed through a rename elsewhere and saves only the title', async () => {
		const wrapper = await mountDetail(1, {Heading: false})
		const heading = wrapper.find('h1.title').element as HTMLElement
		expect(heading.textContent).toBe('Task 1')

		typeTitle(heading, 'Typed here')
		await applyServerTaskUpdated(queryClient, later({title: 'Renamed elsewhere'}))
		await flushPromises()
		expect(heading.textContent).toBe('Typed here')

		sdk.patchTasksRead.mockImplementation(async () => ({data: later({
			title: 'Typed here',
			updated: '2024-01-03T00:00:00Z',
		})}))
		heading.dispatchEvent(new Event('blur'))
		await flushPromises()

		expect(patchBody()).toEqual([{op: 'add', path: '/title', value: 'Typed here'}])

		await applyServerTaskUpdated(queryClient, later({
			title: 'Renamed again',
			updated: '2024-01-04T00:00:00Z',
		}))
		await flushPromises()
		expect(heading.textContent).toBe('Renamed again')
	})

	it('shows a rename elsewhere and saves nothing when the title was only focused', async () => {
		const wrapper = await mountDetail(1, {Heading: false})
		const heading = wrapper.find('h1.title').element as HTMLElement
		heading.dispatchEvent(new Event('focus'))

		await applyServerTaskUpdated(queryClient, later({title: 'Renamed elsewhere'}))
		await flushPromises()
		heading.dispatchEvent(new Event('blur'))
		await flushPromises()

		expect(heading.textContent).toBe('Renamed elsewhere')
		expect(sdk.patchTasksRead).not.toHaveBeenCalled()
	})
})

describe('TaskDetailView end date', () => {
	const scheduled = {
		start_date: '2024-03-02T10:00:00Z',
		due_date: '2024-03-12T10:00:00Z',
	}

	it('never copies the due date into an empty end date on an unrelated save', async () => {
		sdk.tasksRead.mockImplementation(async () => ({data: serverTask(1, scheduled)}))
		sdk.patchTasksRead.mockImplementation(async () => ({data: later({
			...scheduled,
			priority: 4,
		})}))
		const wrapper = await mountDetail()
		expect(datepicker(wrapper, 'endDate')).toBeUndefined()

		wrapper.findComponent(PrioritySelect).vm.$emit('update:modelValue', 4)
		await flushPromises()

		expect(patchBody()).toEqual([{op: 'add', path: '/priority', value: 4}])
		expect(datepicker(wrapper, 'endDate')).toBeUndefined()
	})

	it('clears the end date by sending only the cleared end date', async () => {
		sdk.tasksRead.mockImplementation(async () => ({data: serverTask(1, {
			...scheduled,
			end_date: '2024-03-20T10:00:00Z',
		})}))
		sdk.patchTasksRead.mockImplementation(async () => ({data: later({
			...scheduled,
			end_date: API_ZERO_DATE,
		})}))
		const wrapper = await mountDetail()

		await wrapper.find('[aria-label="task.detail.removeEndDate"]').trigger('click')
		await flushPromises()

		expect(sdk.patchTasksRead).toHaveBeenCalledOnce()
		expect(patchBody()).toEqual([{op: 'add', path: '/end_date', value: API_ZERO_DATE}])
		expect(datepicker(wrapper, 'endDate')).toBeUndefined()
		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toEqual(new Date(scheduled.due_date))
	})
})

describe('TaskDetailView fences async work by task', () => {
	it('never applies a slow save of the previous task to the next one', async () => {
		const save = deferred<{data: Task}>()
		sdk.patchTasksRead.mockImplementationOnce(() => save.promise)
		sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: path.task === 2
			? serverTask(2, {
				priority: 2,
				due_date: '2025-07-07T10:00:00Z',
			})
			: serverTask(path.task)}))
		const wrapper = await mountDetail()

		wrapper.findComponent(PrioritySelect).vm.$emit('update:modelValue', 4)
		await flushPromises()
		await wrapper.setProps({taskId: 2})
		await flushPromises()
		expect(wrapper.findComponent(Heading).props('task').id).toBe(2)

		save.resolve({data: later({
			priority: 4,
			due_date: '2030-01-01T10:00:00Z',
		})})
		await flushPromises()
		// The pending marker is delayed so fast saves never flicker; it must not land on the next task either.
		await new Promise(done => setTimeout(done, 150))

		expect(wrapper.findComponent(Heading).props('task')).toMatchObject({
			id: 2,
			priority: 2,
		})
		expect(wrapper.findComponent(PrioritySelect).props('modelValue')).toBe(2)
		expect(datepicker(wrapper, 'dueDate')?.props('modelValue')).toEqual(new Date('2025-07-07T10:00:00Z'))
		expect(wrapper.findComponent(PrioritySelect).element.closest('.column')?.hasAttribute('aria-busy')).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/')
	})

	it('stays on the next task when a duplicate of the previous one finishes', async () => {
		const duplicate = deferred<{data: {duplicated_task: Task}}>()
		sdk.tasksDuplicate.mockImplementationOnce(() => duplicate.promise)
		const wrapper = await mountDetail()

		await wrapper.find('x-button-stub[icon="copy"]').trigger('click')
		await wrapper.setProps({taskId: 2})
		await flushPromises()
		duplicate.resolve({data: {duplicated_task: serverTask(3)}})
		await flushPromises()

		expect(sdk.tasksDuplicate).toHaveBeenCalledOnce()
		expect(router.currentRoute.value.fullPath).toBe('/')
	})
})

describe('TaskDetailView deleted elsewhere', () => {
	it('shows a deleted notice without editable fields instead of routing to not found', async () => {
		const wrapper = await mountDetail()
		expect(wrapper.findComponent(Heading).exists()).toBe(true)

		await applyServerTaskDeleted(queryClient, 1)
		await flushPromises()

		const notice = wrapper.find('.task-view-deleted [role="alert"]')
		expect(notice.exists()).toBe(true)
		expect(notice.text()).toContain('task.detail.deletedNotice')
		expect(wrapper.find('.task-view').exists()).toBe(false)
		expect(wrapper.findComponent(Heading).exists()).toBe(false)
		expect(wrapper.findAllComponents(Datepicker)).toHaveLength(0)
		expect(router.currentRoute.value.name).not.toBe('not-found')

		await wrapper.find('.task-view-deleted x-button-stub').trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/projects/1')
	})

	it('still sends a task that cannot be loaded to not found', async () => {
		sdk.tasksRead.mockRejectedValueOnce({status: 404})
		const wrapper = await mountDetail()

		expect(router.currentRoute.value.name).toBe('not-found')
		expect(wrapper.find('.task-view-deleted').exists()).toBe(false)
	})
})
