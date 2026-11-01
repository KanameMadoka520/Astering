import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'
import {defineComponent} from 'vue'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	projectsRead: vi.fn(),
	projectsDuplicate: vi.fn(),
	projectUsersList: vi.fn(),
	projectTeamsList: vi.fn(),
	sharesList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ProjectSettingsDuplicate from './ProjectSettingsDuplicate.vue'
import XButton from '@/components/input/Button.vue'
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
	template: '<div />',
})
const CreateEditStub = defineComponent({
	name: 'CreateEdit',
	emits: ['primary'],
	template: '<div><slot /><button class="primary" @click="$emit(\'primary\')">Duplicate</button></div>',
})

function project(id: number, extra: Record<string, unknown> = {}) {
	return {id, title: `Project ${id}`, parent_project_id: 0, is_archived: false, max_permission: 2, position: id, ...extra}
}

function page(items: unknown[]) {
	return {data: {items, total_pages: 1}}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => resolve = r)
	return {promise, resolve}
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
	sdk.projectsRead.mockResolvedValue({data: project(101, {parent_project_id: 100})})
	sdk.projectsList.mockResolvedValue(page([project(100, {title: 'Parent Project'}), project(101, {parent_project_id: 100})]))
	sdk.projectUsersList.mockResolvedValue(page([{id: 2, username: 'sam', permission: 1}, {id: 3, username: 'kim', permission: 0}]))
	sdk.projectTeamsList.mockResolvedValue(page([{id: 5, name: 'Ops', permission: 0}]))
	sdk.sharesList.mockResolvedValue(page([{id: 9, hash: 'abc', permission: 0}]))
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountDuplicate() {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/:projectId/settings/duplicate', name: 'project.settings.duplicate', component: ProjectSettingsDuplicate},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push('/projects/101/settings/duplicate')
	await router.isReady()
	wrapper = mount(ProjectSettingsDuplicate, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton},
			directives: {cy: testid},
			stubs: {Icon: true, CreateEdit: CreateEditStub, ProjectSearch: ProjectSearchStub},
		},
	})
	await flushPromises()
	return wrapper
}

describe('ProjectSettingsDuplicate', () => {
	it('selects the parent when navigation projects load after project detail', async () => {
		const projects = deferred<unknown>()
		sdk.projectsList.mockReturnValue(projects.promise)
		await mountDuplicate()

		const projectSearch = wrapper!.findComponent({name: 'ProjectSearch'})
		expect(projectSearch.props('modelValue') == null).toBe(true)

		projects.resolve(page([project(100, {title: 'Parent Project'}), project(101, {parent_project_id: 100})]))
		await flushPromises()

		expect(projectSearch.props('modelValue')).toMatchObject({id: 100, title: 'Parent Project'})
	})

	it('does not copy shares unless asked to', async () => {
		sdk.projectsDuplicate.mockResolvedValue({data: {duplicated_project: project(200)}})
		await mountDuplicate()

		const checkbox = wrapper!.get<HTMLInputElement>('input[type="checkbox"]')
		expect(checkbox.element.checked).toBe(false)
		await wrapper!.get('button.primary').trigger('click')
		await flushPromises()

		expect(sdk.projectsDuplicate).toHaveBeenCalledTimes(1)
		expect(sdk.projectsDuplicate.mock.calls[0][0].body.duplicate_shares).toBe(false)
	})

	it('says who would get access to the copy when shares are copied', async () => {
		await mountDuplicate()

		expect(wrapper!.text()).toContain('2 people, 1 team and 1 public link would also get access to the copy.')
	})

	it('does not guess the public links when they cannot be listed', async () => {
		sdk.projectsRead.mockResolvedValue({data: project(101, {parent_project_id: 100, max_permission: 1})})
		await mountDuplicate()

		expect(sdk.sharesList).not.toHaveBeenCalled()
		expect(wrapper!.text()).toContain('2 people and 1 team would also get access to the copy')
		expect(wrapper!.text()).toContain('public links')
	})
})
