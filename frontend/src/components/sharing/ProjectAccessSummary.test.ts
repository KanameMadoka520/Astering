import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectUsersList: vi.fn(),
	projectTeamsList: vi.fn(),
	sharesList: vi.fn(),
	projectsList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ProjectAccessSummary from './ProjectAccessSummary.vue'
import XButton from '@/components/input/Button.vue'
import {linkShareKeys} from '@/client/queries/linkShares'
import {projectShareKeys} from '@/client/queries/projectShares'
import {normalizeProject, projectKeys, type ProjectResponse} from '@/client/queries/projects'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'

const ME = {id: 1, username: 'me'}
const SAM = {id: 2, username: 'sam', name: 'Sam'}

function project(id: number, parentId: number, extra: Partial<ProjectResponse> = {}) {
	return normalizeProject({id, title: `P${id}`, owner: ME, parent_project_id: parentId, max_permission: 2, ...extra})
}

type Shares = Record<number, unknown[]>
const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

function page(items: unknown[]) {
	return {data: {items, total_pages: 1}}
}

function serve(list: ReturnType<typeof vi.fn>, shares: Shares) {
	list.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page(shares[path.project] ?? [])))
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
	useAuthStore().setSession({id: ME.id, username: ME.username, type: AUTH_TYPES.USER, exp: 0})
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	serve(sdk.projectUsersList, {})
	serve(sdk.projectTeamsList, {})
	serve(sdk.sharesList, {})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
})

async function mountSummary(current: ProjectResponse, list: ProjectResponse[], userIsAdmin = true) {
	sdk.projectsList.mockResolvedValue(page(list))
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: {template: '<div />'}},
			{path: '/projects/:projectId/settings/share', name: 'project.settings.share', component: {template: '<div />'}},
		],
	})
	wrapper = mount(ProjectAccessSummary, {
		props: {project: current, userIsAdmin},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton},
			stubs: {Icon: true},
		},
	})
	await flushPromises()
	return wrapper
}

describe('ProjectAccessSummary', () => {
	it('shows a team that can open the project through its parent', async () => {
		const parent = project(1, 0, {title: 'Parent'})
		const child = project(2, 1, {title: 'Child'})
		serve(sdk.projectTeamsList, {1: [{id: 5, name: 'Ops', permission: 1}]})
		await mountSummary(child, [parent, child])

		const text = wrapper!.text()
		expect(text).toContain('Through the parent project “Parent”')
		expect(text).toContain('Ops')
		expect(text).toContain('Read & write')
		expect(text).not.toMatch(/Not shared with anyone/)
		const manage = wrapper!.find('a[href="/projects/1/settings/share"]')
		expect(manage.text()).toBe('Manage sharing of “Parent”')
	})

	it('names the parent\'s admins when the user cannot manage the parent', async () => {
		const parent = project(1, 0, {title: 'Parent', owner: SAM, max_permission: 1})
		const child = project(2, 1)
		await mountSummary(child, [parent, child])

		expect(wrapper!.text()).toContain('Sam · owner of “Parent”')
		expect(wrapper!.text()).toContain('Sharing of “Parent” is managed by its admins.')
		expect(wrapper!.find('a[href="/projects/1/settings/share"]').exists()).toBe(false)
	})

	it('does not guess when the parent\'s shares cannot be read', async () => {
		const parent = project(1, 0, {title: 'Parent'})
		const child = project(2, 1)
		sdk.projectTeamsList.mockImplementation(({path}: {path: {project: number}}) => path.project === 1
			? Promise.reject(new Error('offline'))
			: Promise.resolve(page([])))
		await mountSummary(child, [parent, child])

		const alert = wrapper!.find('[role="alert"]')
		expect(alert.text()).toContain('Couldn\'t check all access to this project.')
		expect(wrapper!.text()).not.toMatch(/Not shared with anyone/)

		serve(sdk.projectTeamsList, {})
		await alert.find('button').trigger('click')
		await flushPromises()
		expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
		expect(wrapper!.text()).toContain('Not shared with anyone else, directly or through a parent project.')
	})

	it('only says "not shared" when every source is known to be empty', async () => {
		const solo = project(3, 0)
		await mountSummary(solo, [solo])

		expect(wrapper!.text()).toContain('Not shared with anyone else, directly or through a parent project.')
		expect(wrapper!.text()).not.toMatch(/Private|Only you/)
		expect(wrapper!.text()).not.toContain('Site administrators')
	})

	it('mentions site administrators when the admin panel is enabled', async () => {
		useConfigStore().enabled_pro_features = ['admin_panel']
		const solo = project(3, 0)
		await mountSummary(solo, [solo])

		expect(wrapper!.text()).toContain('Site administrators can open every project on this site.')
	})

	it('does not say "not shared" while a direct share exists', async () => {
		const solo = project(3, 0)
		serve(sdk.sharesList, {3: [{id: 4, hash: 'abc', permission: 0}]})
		await mountSummary(solo, [solo])

		expect(wrapper!.text()).not.toMatch(/Not shared with anyone/)
	})

	it('says a project owned by someone else is shared with you', async () => {
		const theirs = project(4, 0, {owner: SAM, max_permission: 0})
		await mountSummary(theirs, [theirs], false)

		expect(wrapper!.text()).toContain('Owner: Sam')
		expect(wrapper!.text()).toContain('Shared with you (Read only).')
		expect(wrapper!.text()).not.toMatch(/Not shared with anyone/)
		// Only project admins may list link shares.
		expect(sdk.sharesList).not.toHaveBeenCalled()
	})

	it('explains a parent project the user cannot open', async () => {
		const child = project(2, 1)
		await mountSummary(child, [child])

		expect(wrapper!.text()).toContain('This project is inside a parent project you can\'t open.')
		expect(wrapper!.text()).not.toMatch(/Not shared with anyone/)
	})

	it('discloses the projects inside it', async () => {
		const top = project(1, 0)
		const inner = project(2, 1, {title: 'Diary'})
		const deeper = project(3, 2, {title: 'Health'})
		await mountSummary(top, [top, inner, deeper])

		expect(wrapper!.text()).toContain('Everyone who can open this project can also open the 2 projects inside it.')
		expect(wrapper!.text()).toContain('Diary')
		expect(wrapper!.text()).toContain('Health')
	})

	it.each(['users', 'teams', 'links'] as const)('withholds "not shared" when refreshing cached empty %s fails', async source => {
		const solo = project(3, 0)
		// An earlier visit cached empty lists; another admin may have shared the project since.
		queryClient.setQueryData(projectShareKeys.users(3), [], {updatedAt: 0})
		queryClient.setQueryData(projectShareKeys.teams(3), [], {updatedAt: 0})
		queryClient.setQueryData(linkShareKeys.list(3), [], {updatedAt: 0})
		const list = {users: sdk.projectUsersList, teams: sdk.projectTeamsList, links: sdk.sharesList}[source]
		list.mockRejectedValue(new Error('offline'))
		await mountSummary(solo, [solo])

		expect(list).toHaveBeenCalled()
		expect(wrapper!.text()).not.toMatch(/Not shared with anyone/)
	})

	it('withholds "not shared" when refreshing a cached project list fails', async () => {
		const solo = project(3, 0)
		queryClient.setQueryData(projectKeys.list(), {projects: [solo], favoriteProject: null, savedFilterProjects: []}, {updatedAt: 0})
		sdk.projectsList.mockRejectedValue(new Error('offline'))
		wrapper = mount(ProjectAccessSummary, {
			props: {project: solo, userIsAdmin: true},
			global: {
				plugins: [i18n, createRouter({history: createMemoryHistory(), routes: [{path: '/', component: {template: '<div />'}}]}), [VueQueryPlugin, {queryClient}]],
				components: {XButton},
				stubs: {Icon: true},
			},
		})
		await flushPromises()

		expect(sdk.projectsList).toHaveBeenCalled()
		expect(wrapper.text()).not.toMatch(/Not shared with anyone/)
		expect(wrapper.find('[role="alert"]').text()).toContain('Couldn\'t check all access to this project.')
	})

	it('explains how access is inherited even when grants are listed', async () => {
		const parent = project(1, 0, {title: 'Parent'})
		const child = project(2, 1, {title: 'Child'})
		serve(sdk.projectTeamsList, {1: [{id: 5, name: 'Ops', permission: 1}]})
		await mountSummary(child, [parent, child])

		expect(wrapper!.text()).toContain('Admin access on any parent project always applies')
		expect(wrapper!.text()).toContain('Nothing is shared until you share it')
	})
})
