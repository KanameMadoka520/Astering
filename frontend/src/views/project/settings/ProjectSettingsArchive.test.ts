import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsUpdate: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
const message = vi.hoisted(() => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/message', () => message)

import ProjectSettingsArchive from '@/views/project/settings/ProjectSettingsArchive.vue'
import XButton from '@/components/input/Button.vue'
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
let errors: unknown[] = []

function project(id: number, extra: Record<string, unknown> = {}) {
	return {id, title: `Project ${id}`, parent_project_id: 0, is_archived: false, max_permission: 2, position: id, ...extra}
}

function list(items: unknown[]) {
	return {data: {items, total_pages: 1}}
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
	errors = []
	document.body.innerHTML = ''
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountModal(path = '/projects/42/settings/archive') {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/:projectId/settings/archive', name: 'project.settings.archive', component: ProjectSettingsArchive},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
			{path: '/tasks/by/upcoming', name: 'tasks.range', component: {template: '<div />'}},
		],
	})
	await router.push(path)
	await router.isReady()
	wrapper = mount(ProjectSettingsArchive, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {Modal, XButton},
			directives: {cy: testid},
			stubs: {Icon: true},
			config: {
				errorHandler(err) {
					errors.push(err)
				},
			},
		},
	})
	await flushPromises()
	return wrapper
}

function dialogText() {
	return document.querySelector('dialog.modal-dialog')?.textContent ?? ''
}

function confirmButton() {
	const found = document.querySelector<HTMLButtonElement>('dialog.modal-dialog .actions .is-primary')
	if (!found) throw new Error('No confirm button')
	return found
}

function errorMessages() {
	return errors.map(e => (e instanceof Error ? e.message : String(e)))
}

describe('ProjectSettingsArchive', () => {
	it('renders without the project being loaded', async () => {
		sdk.projectsList.mockReturnValue(new Promise(() => {}))
		await mountModal()

		expect(errorMessages()).toEqual([])
		expect(dialogText()).toContain('Archive this project')
	})

	// Re-rendering with the projectId gone used to throw, which leaves Vue with a
	// half-patched subTree and breaks every later navigation (FRONTEND-OSS-2DJ).
	it('does not throw when the route changes away while still mounted', async () => {
		sdk.projectsList.mockResolvedValue(list([project(42, {title: 'Test', is_archived: true})]))
		await mountModal()

		expect(dialogText()).toContain('Un-Archive this project')
		expect(document.title).toBe('Archive "Test" | vikunja-x · -x edition')

		await router.push('/tasks/by/upcoming')
		await flushPromises()

		expect(errorMessages()).toEqual([])
	})

	it('sends one archive request for a double click and keeps the target state', async () => {
		sdk.projectsList.mockResolvedValue(list([project(42)]))
		sdk.projectsUpdate.mockReturnValue(new Promise(() => {}))
		await mountModal()

		const confirm = confirmButton()
		confirm.click()
		await flushPromises()
		confirm.click()
		confirm.click()
		await flushPromises()

		expect(sdk.projectsUpdate).toHaveBeenCalledTimes(1)
		expect(sdk.projectsUpdate.mock.calls[0][0].body.is_archived).toBe(true)
		// The optimistic patch must not flip the dialog to "Un-Archive" mid-request.
		expect(dialogText()).not.toContain('Un-Archive')
	})

	it('keeps the dialog open and stays on the page when archiving fails', async () => {
		sdk.projectsList.mockResolvedValue(list([project(42)]))
		sdk.projectsUpdate.mockRejectedValue(new Error('offline'))
		await mountModal()

		confirmButton().click()
		await flushPromises()

		expect(router.currentRoute.value.name).toBe('project.settings.archive')
		expect(document.querySelector('dialog.modal-dialog:not([data-closing])')).not.toBeNull()
		expect(message.success).not.toHaveBeenCalled()
	})

	it('says the project was unarchived after unarchiving', async () => {
		sdk.projectsList.mockResolvedValue(list([project(42, {is_archived: true})]))
		sdk.projectsUpdate.mockResolvedValue({data: project(42, {is_archived: false})})
		await mountModal()

		confirmButton().click()
		await flushPromises()

		expect(message.success).toHaveBeenCalledWith({message: 'The project was unarchived.'})
		// The dialog closes once the list refetch the archive change triggers has settled.
		await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project.index'))
	})

	it('says that every project inside it is archived too', async () => {
		sdk.projectsList.mockResolvedValue(list([
			project(42),
			project(43, {parent_project_id: 42}),
			project(44, {parent_project_id: 43}),
		]))
		await mountModal()

		expect(dialogText()).toContain('The 2 projects inside it are archived too.')
	})
})
