import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({
	tasksBulkCreate: vi.fn(),
	labelsList: vi.fn(),
	labelsCreate: vi.fn(),
	taskLabelsCreate: vi.fn(),
	taskAssigneesCreate: vi.fn(),
	projectsUsersSearch: vi.fn(),
	projectsList: vi.fn(),
	tasksRelationsCreate: vi.fn(),
	tasksRead: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	translatedError: (key: string) => new Error(key),
}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import {removeToken, saveToken} from '@/helpers/auth'
import {queryClient as sharedQueryClient} from '@/client/queryClient'
import AddTask from './AddTask.vue'

let wrapper: VueWrapper | undefined
let router: Router
let client: QueryClient
let nextId = 10
async function setup() {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [{
			path: '/projects/:projectId/:viewId',
			name: 'project.view',
			component: {render: () => null},
		}],
	})
	await router.push('/projects/1/1')
	client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	wrapper = mount(AddTask, {
		global: {
			plugins: [createPinia(), router, [VueQueryPlugin, {queryClient: client}]],
			directives: {focus: {}},
			mocks: {$t: (key: string) => key},
			stubs: {
				Icon: true,
				QuickAddMagic: true,
				Expandable: {template: '<div><slot /></div>'},
				XButton: {
					template: '<button @click="$emit(\'click\', $event)"><slot /></button>',
					emits: ['click'],
				},
			},
		},
		attachTo: document.body,
	})
	await flushPromises()
	return wrapper
}
async function typeAndEnter(view: VueWrapper, text: string) {
	await view.get('textarea').setValue(text)
	await view.get('textarea').trigger('keydown', {key: 'Enter'})
	await flushPromises()
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
	return {promise, resolve, reject}
}
type BulkInput = {
	path: {project: number},
	body: {tasks: {title: string}[]},
}
function created({path, body}: BulkInput) {
	return {data: {tasks: body.tasks.map(task => ({...task, id: nextId++, project_id: path.project}))}}
}
const retry = (view: VueWrapper) => view.get('.bulk-recovery-retry')

beforeEach(() => {
	removeToken()
	window.API_URL = ''
	sharedQueryClient.clear()
	sharedQueryClient.setDefaultOptions({queries: {retry: false}})
	nextId = 10
	Object.values(sdk).forEach(fn => fn.mockReset())
	sdk.projectsList.mockResolvedValue({data: {
		items: [{id: 1, title: 'One'}, {id: 2, title: 'Two'}],
		total_pages: 1,
	}})
	sdk.labelsList.mockResolvedValue({data: {items: [], total_pages: 1}})
	sdk.projectsUsersSearch.mockResolvedValue({data: {items: []}})
	sdk.tasksBulkCreate.mockImplementation(async (input: BulkInput) => created(input))
	sdk.tasksRelationsCreate.mockResolvedValue({data: {}})
	sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: {id: path.task}}))
})
afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	client?.clear()
	sharedQueryClient.clear()
	removeToken()
	window.API_URL = ''
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('AddTask', () => {
	it('creates once when Enter is pressed again while labels are looked up', async () => {
		const labels = deferred<unknown>()
		sdk.labelsList.mockReturnValueOnce(labels.promise)
		sdk.labelsList.mockResolvedValue({data: {items: [{id: 4, title: 'groceries'}], total_pages: 1}})
		sdk.taskLabelsCreate.mockResolvedValue({data: {}})
		const view = await setup()
		await typeAndEnter(view, 'Buy milk *groceries')
		await view.get('textarea').trigger('keydown', {key: 'Enter'})
		await view.get('.add-task-button').trigger('click')
		labels.resolve({data: {items: [{id: 4, title: 'groceries'}], total_pages: 1}})
		await flushPromises()
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(1)
	})
	it('keeps concurrent input when task preparation fails before any write', async () => {
		const lookup = deferred<unknown>()
		sdk.projectsUsersSearch.mockReturnValueOnce(lookup.promise)
		const view = await setup()
		await typeAndEnter(view, 'First idea @member')
		await view.get('textarea').setValue('Second idea')
		lookup.reject(new Error('NO_PROJECT'))
		await flushPromises()
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('First idea @member\nSecond idea')
		expect(sdk.tasksBulkCreate).not.toHaveBeenCalled()
	})
	it('retries only failed entries across repeated failures, retaining successful ids and a concurrent draft', async () => {
		let attempts = 0
		sdk.tasksBulkCreate.mockImplementation(async (input: BulkInput) => {
			if (input.path.project === 2 && attempts++ < 2) throw new Error('Temporary failure')
			return created(input)
		})
		const view = await setup()
		await typeAndEnter(view, 'Saved +One\nPending +Two')
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('')
		expect(view.find('.bulk-recovery').exists()).toBe(true)
		await view.get('textarea').setValue('Independent new draft')
		await view.get('textarea').trigger('keydown', {key: 'Enter'})
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(2)
		await retry(view).trigger('click')
		await flushPromises()
		expect(view.find('.bulk-recovery').exists()).toBe(true)
		await retry(view).trigger('click')
		await flushPromises()
		expect(sdk.tasksBulkCreate.mock.calls.map(([input]) => input.path.project)).toEqual([1, 2, 2, 2])
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('Independent new draft')
		expect(view.find('.bulk-recovery').exists()).toBe(false)
		expect(view.emitted('tasksAdded')?.flat(2).map(task => (task as {id: number}).id)).toEqual([10, 11])
	})
	it.each([1, 2])('links the original parent and child when project %s initially fails', async failedProject => {
		let failed = false
		sdk.tasksBulkCreate.mockImplementation(async (input: BulkInput) => {
			if (input.path.project === failedProject && !failed) {
				failed = true
				throw new Error('Temporary failure')
			}
			return created(input)
		})
		const view = await setup()
		await typeAndEnter(view, 'Parent +One\n  Child +Two')
		expect(sdk.tasksRelationsCreate).not.toHaveBeenCalled()
		await retry(view).trigger('click')
		await flushPromises()
		expect(sdk.tasksBulkCreate.mock.calls.map(([input]) => input.path.project)).toEqual([1, 2, failedProject])
		expect(sdk.tasksRelationsCreate).toHaveBeenCalledWith(expect.objectContaining({
			path: {task: failedProject === 1 ? 10 : 11},
			body: {other_task_id: failedProject === 1 ? 11 : 10, relation_kind: 'parenttask'},
		}))
	})
	it('associates duplicate titles by input position, including nested parents with the same title', async () => {
		const view = await setup()
		await typeAndEnter(view, 'Same\n  Same\n    Leaf\n  Leaf\nSame\n  Leaf')
		expect(sdk.tasksRelationsCreate.mock.calls.map(([input]) => [input.path.task, input.body.other_task_id]))
			.toEqual([[11, 10], [12, 11], [13, 10], [15, 14]])
	})
	it('keeps an inherited explicit project for a child whose own title has no project prefix', async () => {
		const view = await setup()
		await typeAndEnter(view, 'Parent +Two\n  Child')
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(1)
		expect(sdk.tasksBulkCreate).toHaveBeenCalledWith(expect.objectContaining({
			path: {project: 2},
			body: expect.objectContaining({tasks: [
				expect.objectContaining({title: 'Parent'}),
				expect.objectContaining({title: 'Child'}),
			]}),
		}))
	})
	it('retries a failed relation without creating either task again', async () => {
		sdk.tasksRelationsCreate.mockRejectedValueOnce(new Error('Relation interrupted'))
		const view = await setup()
		await typeAndEnter(view, 'Parent\n  Child')
		expect(view.find('.bulk-recovery').exists()).toBe(true)
		await retry(view).trigger('click')
		await flushPromises()
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(1)
		expect(sdk.tasksRelationsCreate).toHaveBeenCalledTimes(2)
		expect(view.find('.bulk-recovery').exists()).toBe(false)
	})
	it('requires a separate confirmation to discard pending work and keeps the new draft', async () => {
		sdk.tasksBulkCreate.mockImplementation(async (input: BulkInput) => {
			if (input.path.project === 2) throw new Error('Temporary failure')
			return created(input)
		})
		const view = await setup()
		await typeAndEnter(view, 'Saved +One\nPending +Two')
		await view.get('textarea').setValue('Independent new draft')
		await view.get('.bulk-recovery-actions button:nth-child(2)').trigger('click')
		expect(view.find('.bulk-recovery').exists()).toBe(true)
		expect(view.find('.bulk-recovery-confirm').exists()).toBe(true)
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(2)
		await view.get('.bulk-recovery-discard').trigger('click')
		await flushPromises()
		expect(view.find('.bulk-recovery').exists()).toBe(false)
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('Independent new draft')
		expect(document.activeElement).toBe(view.get('textarea').element)
		expect(view.emitted('tasksAdded')?.flat(2).map(task => (task as {id: number}).id)).toEqual([10])
	})
	it('keeps retry busy through the entire request and cannot send a second retry or new batch', async () => {
		let failed = false
		const delayed = deferred<ReturnType<typeof created>>()
		sdk.tasksBulkCreate.mockImplementation(async (input: BulkInput) => {
			if (!failed) {
				failed = true
				throw new Error('Temporary failure')
			}
			return delayed.promise
		})
		const view = await setup()
		await typeAndEnter(view, 'Pending')
		await retry(view).trigger('click')
		await flushPromises()
		expect(retry(view).attributes('aria-disabled')).toBe('true')
		await retry(view).trigger('click')
		await typeAndEnter(view, 'Independent new draft')
		expect(sdk.tasksBulkCreate).toHaveBeenCalledTimes(2)
		delayed.resolve(created({path: {project: 1}, body: {tasks: [{title: 'Pending'}]}}))
		await flushPromises()
		expect(view.find('.bulk-recovery').exists()).toBe(false)
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('Independent new draft')
	})
	it.each(['route', 'identity', 'api', 'unmount'] as const)('drops late work after a %s change without restoring or linking into the next scope', async changed => {
		const lookup = deferred<unknown>()
		sdk.projectsUsersSearch.mockReturnValueOnce(lookup.promise)
		const view = await setup()
		await typeAndEnter(view, 'Parent @member\n  Child')
		await view.get('textarea').setValue('Next scope draft')
		if (changed === 'route') await router.push('/projects/2/1')
		if (changed === 'identity') saveToken(`fixture.${btoa(JSON.stringify({id: 2, type: 1}))}.fixture`, false)
		if (changed === 'api') window.API_URL = 'https://other.example/api/v2'
		if (changed === 'unmount') view.unmount()
		lookup.resolve({data: {items: []}})
		await flushPromises()
		expect(sdk.tasksBulkCreate).not.toHaveBeenCalled()
		expect(sdk.tasksRelationsCreate).not.toHaveBeenCalled()
		if (changed !== 'unmount') {
			expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('Next scope draft')
			expect(view.find('.bulk-recovery').exists()).toBe(false)
		}
	})
})
