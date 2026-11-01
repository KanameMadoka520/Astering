import {createPinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {flushPromises, shallowMount, type VueWrapper} from '@vue/test-utils'
import {createMemoryHistory, createRouter, RouterView, type Router} from 'vue-router'
import {h} from 'vue'

const sdk = vi.hoisted(() => ({
	tasksRead: vi.fn(),
	tasksDelete: vi.fn(),
	tasksList: vi.fn(async () => ({data: {items: []}})),
	projectTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewTasksList: vi.fn(async () => ({data: {items: []}})),
	projectViewBucketsTasksList: vi.fn(async () => ({data: {items: []}})),
	bucketsList: vi.fn(async () => ({data: {items: []}})),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({
	projects: {1: {
		id: 1,
		title: 'Project',
		parent_project_id: 0,
	}},
	getAncestors: () => [],
})}))
vi.mock('@/composables/useLabels', () => ({useLabels: () => ({
	filterLabelsByQuery: () => [],
	isPending: {value: false},
	getLabelById: vi.fn(),
})}))
vi.mock('vuemoji-picker', () => ({VuemojiPicker: {render: () => null}}))
// Keep the API probe from changing the real request-context URL halfway through a test.
vi.mock('@/helpers/checkAndSetApiUrl', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/checkAndSetApiUrl')>(),
	checkAndSetApiUrl: vi.fn(async () => window.API_URL),
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import TaskDetailView from './TaskDetailView.vue'
import {removeToken, saveToken} from '@/helpers/auth'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
} from '@/client/requestContext'

function accountToken(id: number, prefix = 'header') {
	const claims = {
		id,
		type: 1,
	}
	return `${prefix}.${btoa(JSON.stringify(claims))}.signature`
}

function task(id: number) {
	return {
		id,
		title: `Task ${id}`,
		description: '',
		project_id: 1,
		max_permission: 2,
		labels: [],
		assignees: [],
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

let queryClient: QueryClient
let router: Router
let wrapper: VueWrapper | undefined
let host: VueWrapper | undefined
let previousApiUrl: string

beforeEach(() => {
	vi.clearAllMocks()
	previousApiUrl = window.API_URL
	removeToken()
	window.API_URL = ''
	saveToken(accountToken(1), false)
	sdk.tasksRead.mockReset()
	sdk.tasksRead.mockImplementation(async ({path}: {path: {task: number}}) => ({data: task(path.task)}))
	sdk.tasksDelete.mockReset()
	sdk.tasksDelete.mockResolvedValue({data: {}})
})

afterEach(() => {
	host?.unmount()
	host = undefined
	wrapper = undefined
	queryClient?.clear()
	removeToken()
	window.API_URL = previousApiUrl
})

async function openConfirmation(backdropView?: string) {
	queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: '/',
				name: 'home',
				component: {render: () => null},
			},
			{
				path: '/elsewhere',
				component: {render: () => null},
			},
			{
				path: '/tasks/:id',
				name: 'task.detail',
				component: TaskDetailView,
				props: route => ({
					taskId: Number(route.params.id),
					backdropView,
				}),
			},
			{
				path: '/projects/:projectId',
				name: 'project.index',
				component: {render: () => null},
			},
		],
	})
	await router.push('/tasks/1')
	host = shallowMount({render: () => h(RouterView)}, {
		global: {
			plugins: [createPinia(), router, [VueQueryPlugin, {queryClient}]],
			mocks: {$t: (key: string) => key},
			stubs: {
				RouterView: false,
				TaskDetailView: false,
				Icon: true,
				XButton: true,
				Modal: {
					name: 'DeletionModal',
					props: ['enabled', 'loading'],
					template: '<div />',
				},
				CustomTransition: {template: '<div><slot/></div>'},
			},
			directives: {
				tooltip: () => {},
				cy: () => {},
				shortcut: () => {},
			},
		},
	})
	await flushPromises()
	wrapper = host.findComponent(TaskDetailView)
	await wrapper.find('x-button-stub[icon="trash-alt"]').trigger('click')
	const modal = wrapper.findComponent({name: 'DeletionModal'})
	expect(modal.props('enabled')).toBe(true)
	const vm = wrapper.vm as unknown as {deleteTask: () => Promise<void>}
	return {vm, modal}
}

describe('TaskDetailView deletion confirmation', () => {
	it('rejects an old confirmation after the task route is reused', async () => {
		const {vm, modal} = await openConfirmation()
		await router.push('/tasks/2')
		await flushPromises()

		await vm.deleteTask()
		expect(sdk.tasksDelete).not.toHaveBeenCalled()
		expect(modal.props('enabled')).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
	})

	it('rejects the old task while the next task is still loading', async () => {
		const {vm, modal} = await openConfirmation()
		sdk.tasksRead.mockImplementation(() => new Promise(() => {}))
		await router.push('/tasks/2')
		await vm.deleteTask()

		expect(sdk.tasksDelete).not.toHaveBeenCalled()
		expect(modal.props('enabled')).toBe(false)
	})

	const contextChanges = [
		{
			name: 'account identity',
			change: () => saveToken(accountToken(2), false),
		},
		{
			name: 'API server',
			change: () => { window.API_URL = 'https://other.example' },
		},
		{
			name: 'session epoch',
			change: () => {
				removeToken()
				saveToken(accountToken(1), false)
			},
		},
	]
	it.each(contextChanges)('rejects a confirmation after its $name changes without navigation', async ({change}) => {
		const {vm, modal} = await openConfirmation()
		const request = captureClientRequestContext()
		change()
		expect(isClientRequestContextCurrent(request)).toBe(false)

		await vm.deleteTask()
		await flushPromises()
		expect(sdk.tasksDelete).not.toHaveBeenCalled()
		expect(modal.props('enabled')).toBe(false)
	})

	it.each([undefined, '/projects/1'])('does not navigate or emit close when deletion finishes after unmount (backdrop %s)', async backdrop => {
		const pending = deferred<{data: Record<string, never>}>()
		sdk.tasksDelete.mockReturnValue(pending.promise)
		const {vm} = await openConfirmation(backdrop)
		const deletion = vm.deleteTask()
		await flushPromises()
		expect(sdk.tasksDelete).toHaveBeenCalledOnce()
		await router.push('/elsewhere')
		expect(host!.findComponent(TaskDetailView).exists()).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/elsewhere')
		pending.resolve({data: {}})
		await deletion
		await flushPromises()

		expect(router.currentRoute.value.fullPath).toBe('/elsewhere')
		expect(wrapper!.emitted('close')).toBeUndefined()
		wrapper = undefined
	})

	it('does not navigate after leaving and returning to the same task during deletion', async () => {
		const pending = deferred<{data: Record<string, never>}>()
		sdk.tasksDelete.mockReturnValue(pending.promise)
		const {vm} = await openConfirmation()
		const deletion = vm.deleteTask()
		await flushPromises()
		await router.push('/elsewhere')
		await router.push('/tasks/1')
		await flushPromises()
		pending.resolve({data: {}})
		await deletion
		await flushPromises()

		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		const current = host!.findComponent(TaskDetailView)
		expect(current.find('.task-view-deleted').exists()).toBe(true)
		expect(current.find('.task-view').exists()).toBe(false)
	})

	it('accepts a renewed token for the same account and navigates after the confirmed deletion', async () => {
		const {vm, modal} = await openConfirmation()
		const request = captureClientRequestContext()
		saveToken(accountToken(1, 'renewed'), false)
		expect(isClientRequestContextCurrent(request)).toBe(true)
		await vm.deleteTask()
		await flushPromises()

		expect(sdk.tasksDelete).toHaveBeenCalledOnce()
		expect(sdk.tasksDelete.mock.calls[0][0].path).toEqual({task: 1})
		expect(modal.props('enabled')).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/projects/1')
	})

	it('keeps a failed confirmation available for an explicit retry', async () => {
		sdk.tasksDelete.mockRejectedValueOnce(new Error('offline'))
		const {vm, modal} = await openConfirmation()
		await vm.deleteTask()
		await flushPromises()
		expect(modal.props('enabled')).toBe(true)
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')

		await vm.deleteTask()
		await flushPromises()
		expect(sdk.tasksDelete).toHaveBeenCalledTimes(2)
		expect(router.currentRoute.value.fullPath).toBe('/projects/1')
	})
})
