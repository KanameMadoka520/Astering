import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, RouterView, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsRead: vi.fn(),
	projectsUpdate: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/components/input/AsyncEditor', () => ({default: defineComponent({template: '<div />'})}))

import ProjectSettingsEdit from './ProjectSettingsEdit.vue'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'
import {useBaseStore} from '@/stores/base'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined
let router: Router
const EditStub = defineComponent({
	emits: ['primary'],
	template: '<div><button data-save @click="$emit(\'primary\')">Save</button><slot /></div>',
})

function project(id: number) {
	return {id, title: `Project ${id}`, parent_project_id: 0, max_permission: 2, position: id}
}

beforeAll(() => {
	queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
})
afterAll(() => { queryClient.setDefaultOptions(defaults) })
beforeEach(() => {
	vi.resetAllMocks()
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
	useAuthStore().setSession({id: 1, username: 'me', type: AUTH_TYPES.USER, exp: 0})
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.projectsRead.mockImplementation(({path}: {path: {id: number}}) => Promise.resolve({data: project(path.id)}))
	sdk.projectsList.mockResolvedValue({data: {items: [project(42), project(43)], total_pages: 1}})
})
afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
})

async function mountEditor() {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/:projectId/settings/edit', name: 'project.settings.edit', component: ProjectSettingsEdit, props: route => ({projectId: Number(route.params.projectId)})},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push('/projects/42/settings/edit')
	await router.isReady()
	wrapper = mount(RouterView, {
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			stubs: {CreateEdit: EditStub, FormField: {template: '<div><slot /></div>'}, ProjectSearch: true, ColorPicker: true},
			directives: {focus: () => {}, tooltip: () => {}},
		},
	})
	await flushPromises()
}

describe('ProjectSettingsEdit request identity', () => {
	it.each([false, true])('keeps the current editor when an old save finishes (returned to source: %s)', async returnToSource => {
		let finish!: (value: unknown) => void
		sdk.projectsUpdate.mockReturnValue(new Promise(resolve => { finish = resolve }))
		await mountEditor()
		const originalEditor = wrapper!.getComponent(ProjectSettingsEdit).vm.$.uid
		await wrapper!.get('[data-save]').trigger('click')
		await flushPromises()
		expect(sdk.projectsUpdate.mock.calls[0][0].path).toEqual({id: 42})

		await router.push('/projects/43/settings/edit')
		await flushPromises()
		if (returnToSource) {
			await router.push('/projects/42/settings/edit')
			await flushPromises()
		}
		const currentId = returnToSource ? 42 : 43
		useBaseStore().setCurrentProject({id: currentId})
		expect(wrapper!.getComponent(ProjectSettingsEdit).vm.$.uid).toBe(originalEditor)
		finish({data: {...project(42), title: 'Saved source'}})
		await flushPromises()

		expect(router.currentRoute.value.fullPath).toBe(`/projects/${currentId}/settings/edit`)
		expect(useBaseStore().currentProjectId).toBe(currentId)
	})
})
