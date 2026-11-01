import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsDelete: vi.fn(),
	projectTasksList: vi.fn(),
	tasksList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ProjectSettingsDelete from '@/views/project/settings/ProjectSettingsDelete.vue'
import XButton from '@/components/input/Button.vue'
import Loading from '@/components/misc/Loading.vue'
import Modal from '@/components/misc/Modal.vue'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined
let router: Router

function project(id: number, extra: Record<string, unknown> = {}) {
	return {id, title: id === 42 ? 'Test' : `Project ${id}`, parent_project_id: 0, is_archived: false, max_permission: 2, position: id, ...extra}
}

function list(items: unknown[]) {
	return {data: {items, total_pages: 1}}
}

function taskTotal(total: number) {
	return {data: {items: [], total, page: 1, per_page: 1, total_pages: total}}
}

beforeAll(() => {
	queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
})

afterAll(() => {
	queryClient.setDefaultOptions(defaults)
})

beforeEach(() => {
	vi.resetAllMocks()
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
	useAuthStore().setSession({id: 1, username: 'me', type: AUTH_TYPES.USER, exp: 0})
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.projectsList.mockResolvedValue(list([project(42)]))
	document.body.innerHTML = ''
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountModal() {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: {template: '<div />'}},
			{path: '/projects/:projectId/settings/delete', name: 'project.settings.delete', component: ProjectSettingsDelete},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push('/projects/42/settings/delete')
	await router.isReady()
	wrapper = mount(ProjectSettingsDelete, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {Modal, XButton},
			directives: {cy: testid},
			stubs: {Icon: true},
		},
	})
	await flushPromises()
	return wrapper
}

function dialogText() {
	return document.querySelector('dialog.modal-dialog:not([data-closing])')?.textContent ?? ''
}

function confirmButton() {
	const found = document.querySelector<HTMLButtonElement>('dialog.modal-dialog .actions .is-primary')
	if (!found) throw new Error('No confirm button')
	return found
}

describe('ProjectSettingsDelete', () => {
	it('shows the loader while the task count is pending', async () => {
		sdk.projectTasksList.mockReturnValue(new Promise(() => {}))
		sdk.tasksList.mockReturnValue(new Promise(() => {}))
		await mountModal()

		expect(wrapper!.findComponent(Loading).exists()).toBe(true)
		expect(dialogText()).not.toContain('does not contain any tasks')
	})

	it('shows the task count once the query resolved', async () => {
		sdk.projectTasksList.mockResolvedValue(taskTotal(3))
		sdk.tasksList.mockResolvedValue(taskTotal(3))
		await mountModal()

		expect(wrapper!.findComponent(Loading).exists()).toBe(false)
		expect(dialogText()).toContain('irrevocably remove approx. 3 tasks')
		expect(dialogText()).toContain('Delete “Test”?')
	})

	it('counts the tasks of every project inside it, archived ones included', async () => {
		sdk.projectsList.mockResolvedValue(list([
			project(42),
			project(43, {parent_project_id: 42}),
			project(44, {parent_project_id: 43, is_archived: true}),
			project(45),
		]))
		const totals: Record<number, number> = {42: 1, 43: 2, 44: 4, 45: 100}
		sdk.projectTasksList.mockImplementation(async ({path}: {path: {project: number}}) => taskTotal(totals[path.project] ?? 0))
		sdk.tasksList.mockResolvedValue(taskTotal(1))
		await mountModal()

		const counted = sdk.projectTasksList.mock.calls.map(([options]) => options.path.project).sort()
		expect(counted).toEqual([42, 43, 44])
		expect(dialogText()).toContain('approx. 7 tasks and 3 projects')
	})

	it('says when it could not count the tasks instead of spinning', async () => {
		sdk.projectTasksList.mockRejectedValue(new Error('offline'))
		sdk.tasksList.mockRejectedValue(new Error('offline'))
		await mountModal()

		expect(wrapper!.findComponent(Loading).exists()).toBe(false)
		const alert = document.querySelector('dialog.modal-dialog [role="alert"]')
		expect(alert?.textContent).toContain('Couldn\'t count the tasks.')
		expect(dialogText()).not.toContain('safe to delete')
	})

	it('sends one delete request for a double click and keeps the dialog open when it fails', async () => {
		sdk.projectTasksList.mockResolvedValue(taskTotal(0))
		sdk.tasksList.mockResolvedValue(taskTotal(0))
		sdk.projectsDelete.mockRejectedValue(new Error('offline'))
		await mountModal()

		const confirm = confirmButton()
		confirm.click()
		confirm.click()
		await flushPromises()

		expect(sdk.projectsDelete).toHaveBeenCalledTimes(1)
		expect(router.currentRoute.value.name).toBe('project.settings.delete')
		expect(dialogText()).toContain('Delete “Test”?')
	})
})
