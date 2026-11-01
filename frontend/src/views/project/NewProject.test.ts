import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'
import {defineComponent} from 'vue'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsCreate: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import NewProject from './NewProject.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import type {ProjectResponse} from '@/client/queries/projects'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

const ProjectSearchStub = defineComponent({
	name: 'ProjectSearch',
	props: ['modelValue', 'filter'],
	emits: ['update:modelValue'],
	template: '<div />',
})

function project(id: number, extra: Record<string, unknown> = {}) {
	return {id, title: `Project ${id}`, parent_project_id: 0, is_archived: false, max_permission: 2, position: id, ...extra}
}

const projects = [
	project(5, {title: 'Family'}),
	project(6, {title: 'Read only', max_permission: 0}),
	project(7, {title: 'Writable', max_permission: 1}),
]

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
	sdk.projectsList.mockResolvedValue({data: {items: projects, total_pages: 1}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountNew(parentProjectId?: number) {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/new', name: 'project.create', component: NewProject},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push('/projects/new')
	await router.isReady()
	wrapper = mount(NewProject, {
		attachTo: document.body,
		props: {parentProjectId},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Card, Modal},
			directives: {cy: testid, focus: {}, tooltip: {}},
			stubs: {Icon: true, ProjectSearch: ProjectSearchStub, ColorPicker: true},
		},
	})
	await flushPromises()
	return wrapper
}

describe('NewProject: the parent project', () => {
	it('offers only parents the user can write to', async () => {
		await mountNew()

		const filter = wrapper!.findComponent({name: 'ProjectSearch'}).props('filter') as ((project: ProjectResponse) => boolean) | undefined
		expect(filter).toBeTypeOf('function')
		expect(projects.filter(candidate => filter!(candidate as unknown as ProjectResponse)).map(candidate => candidate.id)).toEqual([5, 7])
	})

	it('says that everyone with access to the parent can open the new project', async () => {
		await mountNew(5)

		expect(document.querySelector('dialog.modal-dialog')?.textContent)
			.toContain('Everyone who can open “Family” can open this project too.')
	})

	it('says nothing about access for a top-level project', async () => {
		await mountNew()

		expect(document.querySelector('dialog.modal-dialog')?.textContent).not.toContain('Everyone who can open')
	})
})
