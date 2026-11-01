import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, shallowMount, type VueWrapper} from '@vue/test-utils'
import {reactive, ref} from 'vue'
import {createMemoryHistory, createRouter, RouterLink} from 'vue-router'

import type {ProjectResponse} from '@/client/queries/projects'

const currentProject = ref<ProjectResponse | null>(null)
vi.mock('@/composables/useCurrentProject', () => ({useCurrentProject: () => ({currentProject})}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => reactive({projects: {}})}))
vi.mock('@/composables/useSidebarResize', () => ({useSidebarResize: () => ({sidebarWidthStyle: ref(''), isMobile: ref(false)})}))
vi.mock('@/stores/base', () => ({useBaseStore: () => ({background: null, menuActive: false})}))
vi.mock('@/stores/guidedTour', () => ({useGuidedTourStore: () => ({show: vi.fn()})}))
vi.mock('@/stores/config', () => ({useConfigStore: () => ({legal: {}, isProFeatureEnabled: () => false})}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => reactive({authUser: true, info: {id: 1, is_admin: false}, userDisplayName: 'Me'})}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key}),
}))

import AppHeader from './AppHeader.vue'

let wrapper: VueWrapper | undefined

function project(ownerId: number): ProjectResponse {
	return {id: 9, title: 'Garden', description: '', hex_color: '', owner: {id: ownerId, username: `user${ownerId}`, name: 'Robin'}, max_permission: 1, views: []} as unknown as ProjectResponse
}

async function mountHeader() {
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/', name: 'home', component: {render: () => null}},
		{path: '/projects/:projectId/settings/share', name: 'project.settings.share', component: {render: () => null}},
	]})
	await router.push('/')
	wrapper = shallowMount(AppHeader, {
		global: {
			plugins: [router],
			mocks: {$t: (key: string) => key},
			stubs: {RouterLink},
		},
	})
	await flushPromises()
	return wrapper
}

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	currentProject.value = null
})

describe('AppHeader project access badge', () => {
	it('links a project someone else owns to its share page and names it', async () => {
		currentProject.value = project(2)
		const view = await mountHeader()

		const link = view.find('a.project-access-link')
		expect(link.exists()).toBe(true)
		expect(link.attributes('href')).toBe('/projects/9/settings/share')
		expect(link.attributes('aria-label')).toContain('project.share.badge.viewAccess')
		expect(link.attributes('aria-label')).toContain('project.share.badge.sharedWithYou')
	})

	it('shows nothing for an own project in an own tree', async () => {
		currentProject.value = project(1)
		const view = await mountHeader()

		expect(view.find('a.project-access-link').exists()).toBe(false)
	})
})
