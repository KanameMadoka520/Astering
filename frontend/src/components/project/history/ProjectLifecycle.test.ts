import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({projectHistory: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projectsArray: []})}))

import ProjectLifecycle from './ProjectLifecycle.vue'
import en from '@/i18n/lang/en.json'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
let wrapper: VueWrapper | undefined
let client: QueryClient

function history() {
	return {data: {
		year: 2026,
		projects: 1,
		milestones: 1,
		active_days: 1,
		days: {'2026-03-02': 1},
		items: [{id: 1, project_id: 4, title: 'Garden shed', kind: 'created', occurred_at: '2026-03-02T10:00:00Z', created: '2026-03-02T10:00:00Z'}],
		page: 1,
		total: 1,
		total_pages: 1,
	}}
}

async function mountView() {
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/projects/history', name: 'projects.history', component: {template: '<div />'}},
		{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
	]})
	await router.push('/projects/history?year=2026')
	await router.isReady()
	client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	wrapper = mount(ProjectLifecycle, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient: client}]],
			stubs: {Icon: true, ProjectStatusBadges: true, XButton: {template: '<button type="button"><slot /></button>'}},
		},
	})
	await flushPromises()
	return wrapper
}

beforeEach(() => {
	setActivePinia(createPinia())
	sdk.projectHistory.mockReset()
	document.body.innerHTML = ''
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

describe('ProjectLifecycle', () => {
	it('keeps the records on screen when a background refresh fails, and says so', async () => {
		sdk.projectHistory.mockResolvedValueOnce(history())
		const view = await mountView()
		expect(view.text()).toContain('Garden shed')

		sdk.projectHistory.mockRejectedValueOnce(new Error('Server error'))
		await client.refetchQueries({queryKey: ['project-history']})
		await flushPromises()

		expect(view.text()).toContain('Garden shed')
		expect(view.find('.history-stale-error').exists()).toBe(true)
	})

	it('shows the error alone when nothing has loaded yet', async () => {
		sdk.projectHistory.mockRejectedValueOnce(new Error('Server error'))
		const view = await mountView()

		expect(view.find('.history-state[role="alert"]').exists()).toBe(true)
		expect(view.text()).not.toContain('Garden shed')
	})
})
