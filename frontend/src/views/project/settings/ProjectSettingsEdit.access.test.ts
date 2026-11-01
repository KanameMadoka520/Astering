import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'
import {defineComponent} from 'vue'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsRead: vi.fn(),
	projectsUpdate: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))
// The rich text editor is irrelevant here and heavy to load.
vi.mock('@/components/input/AsyncEditor', () => ({default: defineComponent({name: 'AsyncEditor', render: () => null})}))

import ProjectSettingsEdit from './ProjectSettingsEdit.vue'
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
import {useBaseStore} from '@/stores/base'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined
let router: Router

const ProjectSearchStub = defineComponent({
	name: 'ProjectSearch',
	props: ['modelValue', 'filter'],
	emits: ['update:modelValue'],
	template: '<div class="project-search-stub" />',
})

function project(id: number, extra: Record<string, unknown> = {}) {
	return {id, title: `Project ${id}`, parent_project_id: 0, is_archived: false, max_permission: 2, position: id, views: [], ...extra}
}

function page(items: unknown[]) {
	return {data: {items, total_pages: 1}}
}

const projects = [
	project(100, {title: 'Old home'}),
	project(101, {title: 'Moving', parent_project_id: 100}),
	project(102, {parent_project_id: 101}),
	project(103, {parent_project_id: 102}),
	project(104, {title: 'Read only', max_permission: 0}),
	project(105, {title: 'Team space', max_permission: 1}),
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
	sdk.projectsList.mockResolvedValue(page(projects))
	sdk.projectsRead.mockResolvedValue({data: projects[1]})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountEdit() {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/:projectId/settings/edit', name: 'project.settings.edit', component: ProjectSettingsEdit},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
			{path: '/projects/:projectId/settings/delete', name: 'project.settings.delete', component: {template: '<div />'}},
		],
	})
	await router.push('/projects/101/settings/edit')
	await router.isReady()
	wrapper = mount(ProjectSettingsEdit, {
		attachTo: document.body,
		props: {projectId: 101},
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

function dialogText() {
	return document.querySelector('dialog.modal-dialog')?.textContent ?? ''
}

describe('ProjectSettingsEdit: the parent project', () => {
	it('offers only parents the user can write to, outside this project', async () => {
		await mountEdit()

		const filter = wrapper!.findComponent({name: 'ProjectSearch'}).props('filter') as ((project: ProjectResponse) => boolean) | undefined
		expect(filter).toBeTypeOf('function')
		const offered = projects.filter(candidate => filter!(candidate as unknown as ProjectResponse)).map(candidate => candidate.id)
		expect(offered).toEqual([100, 105])
	})

	it('says who gains and loses access when the parent changes', async () => {
		await mountEdit()

		wrapper!.findComponent({name: 'ProjectSearch'}).vm.$emit('update:modelValue', projects[5])
		await flushPromises()

		expect(dialogText()).toContain('After the move, everyone who can open “Team space” can open this project and the 2 projects inside it.')
		expect(dialogText()).toContain('Access that came from “Old home” ends.')
	})

	it('shows the parent as text to people who cannot move the project', async () => {
		sdk.projectsRead.mockResolvedValue({data: {...projects[1], max_permission: 1}})
		await mountEdit()

		expect(wrapper!.findComponent({name: 'ProjectSearch'}).exists()).toBe(false)
		expect(dialogText()).toContain('Old home')
		expect(dialogText()).toContain('Only project admins can move a project.')
	})

	it('says when the parent is a project the user cannot open', async () => {
		sdk.projectsList.mockResolvedValue(page(projects.slice(1)))
		await mountEdit()

		expect(dialogText()).toContain('Inside a project you can\'t open.')
	})
})

describe('ProjectSettingsEdit: saving', () => {
	it('does not step back once more when a save finishes after the dialog is gone', async () => {
		let resolveSave!: (value: unknown) => void
		sdk.projectsUpdate.mockReturnValue(new Promise(resolve => resolveSave = resolve))
		await mountEdit()
		// In the app the base store exists from startup; create it the same way here.
		mount(defineComponent({setup: () => {
			useBaseStore()
			return () => null
		}}), {global: {plugins: [i18n, router, [VueQueryPlugin, {queryClient}]]}})

		const save = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save')
		save!.click()
		await vi.waitFor(() => expect(sdk.projectsUpdate).toHaveBeenCalledTimes(1))
		// Unmounting the test app resets the router's current route, so watch the calls instead.
		const back = vi.spyOn(router, 'back')
		const push = vi.spyOn(router, 'push')
		wrapper!.unmount()
		wrapper = undefined
		resolveSave({data: projects[1]})
		await flushPromises()

		expect(back).not.toHaveBeenCalled()
		expect(push).not.toHaveBeenCalled()
	})
})
