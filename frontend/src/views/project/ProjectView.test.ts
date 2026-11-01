import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({projectsRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/stores/base', () => ({useBaseStore: () => ({setCurrentProject: vi.fn()})}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => ({authenticated: true, settings: {frontend_settings: {default_view: 'first'}}})}))
vi.mock('@/helpers/projectView', () => ({saveProjectView: vi.fn()}))
vi.mock('@/modules/projectHistory', () => ({saveProjectToHistory: vi.fn()}))

import ProjectView from './ProjectView.vue'
import {error as toastError} from '@/message'

let wrapper: VueWrapper | undefined

async function mountView() {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/:projectId/:viewId', name: 'project.view', component: {render: () => null}},
			{path: '/projects', name: 'projects.index', component: {render: () => null}},
		],
	})
	await router.push('/projects/5/0')
	wrapper = mount(ProjectView, {
		props: {projectId: 5, viewId: 0},
		global: {
			plugins: [router, [VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}]],
			mocks: {$t: (key: string) => key},
			stubs: {ProjectList: true, ProjectGantt: true, ProjectTable: true, ProjectKanban: true, Icon: true, XButton: {template: '<button type="button" @click="$emit(\'click\')"><slot /></button>', emits: ['click']}},
		},
	})
	await flushPromises()
	return wrapper
}

beforeEach(() => {
	sdk.projectsRead.mockReset()
	vi.mocked(toastError).mockClear()
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

describe('ProjectView load failures', () => {
	it('says the project is gone or not shared any more instead of a blank page', async () => {
		sdk.projectsRead.mockRejectedValue({status: 404, message: 'Not found'})
		const view = await mountView()

		expect(view.find('[role="alert"]').text()).toContain('project.loadError.missing')
		expect(view.find('a').text()).toContain('project.loadError.toProjects')
		expect(view.find('[role="alert"] button').exists()).toBe(false)
		expect(toastError).not.toHaveBeenCalled()
	})

	it('offers a retry when loading failed for another reason', async () => {
		sdk.projectsRead.mockRejectedValueOnce({status: 500, message: 'Server error'})
		const view = await mountView()

		expect(view.find('[role="alert"]').text()).toContain('project.loadError.failed')
		sdk.projectsRead.mockResolvedValueOnce({data: {id: 5, title: 'Garden', views: []}})
		await view.find('[role="alert"] button').trigger('click')
		await flushPromises()
		expect(sdk.projectsRead).toHaveBeenCalledTimes(2)
		expect(view.find('[role="alert"]').exists()).toBe(false)
	})
})
