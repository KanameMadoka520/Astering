import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ProjectCard from './ProjectCard.vue'
import ProjectAccessBadge from '@/components/sharing/ProjectAccessBadge.vue'
import {normalizeProject, type ProjectResponse} from '@/client/queries/projects'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const ME = {id: 1, username: 'me', name: ''}
const SAM = {id: 7, username: 'sam', name: 'Sam'}

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

function project(id: number, parent: number, owner: typeof ME, title = `Project ${id}`): ProjectResponse {
	return normalizeProject({id, title, parent_project_id: parent, owner, max_permission: 0, position: id})
}

const team = project(10, 0, SAM, 'Team')
const mineInTeam = project(11, 10, ME, 'Mine in team')
const theirs = project(12, 0, SAM, 'Their project')
const mine = project(13, 0, ME, 'Mine')
const mineInMine = project(14, 13, ME, 'Mine inside mine')
const orphan = project(15, 99, ME, 'Under a hidden parent')

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
	const authStore = useAuthStore()
	authStore.setSession({id: ME.id, username: ME.username, type: AUTH_TYPES.USER, exp: 0})
	authStore.setAuthenticated(true)
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.projectsList.mockResolvedValue({data: {items: [team, mineInTeam, theirs, mine, mineInMine, orphan], total_pages: 1}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
})

async function mountCard(shown: ProjectResponse) {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}}],
	})
	wrapper = mount(ProjectCard, {
		props: {project: shown},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			stubs: {Icon: true, ProjectSettingsDropdown: true},
		},
	})
	await flushPromises()
	return wrapper
}

describe('ProjectCard: who else can open it', () => {
	it('says a project is shared with you and who owns it', async () => {
		await mountCard(theirs)

		expect(wrapper!.find('.project-access-badge').text()).toBe('Shared with you · Owner: Sam')
	})

	it('says your project sits inside someone else\'s project', async () => {
		await mountCard(mineInTeam)

		const badge = wrapper!.find('.project-access-badge')
		expect(badge.text()).toContain('In a shared project')
		expect(badge.text()).toContain('People with access to “Team” can open it.')
	})

	it('says so when the parent is a project you can\'t open', async () => {
		await mountCard(orphan)

		expect(wrapper!.find('.project-access-badge').text()).toContain('People with access to its parent project can open it.')
	})

	it('claims nothing about your own project in your own tree', async () => {
		await mountCard(mineInMine)

		expect(wrapper!.find('.project-access-badge').exists()).toBe(false)
		expect(wrapper!.text()).not.toMatch(/private/i)
	})

	it('shows nothing to a link-share visitor', async () => {
		const authStore = useAuthStore()
		authStore.setSession({id: 5, type: AUTH_TYPES.LINK_SHARE, exp: 0})
		authStore.setAuthenticated(true)
		await mountCard(theirs)

		expect(wrapper!.find('.project-access-badge').exists()).toBe(false)
	})
})

describe('ProjectAccessBadge: compact', () => {
	it('keeps the words for screen readers and the tooltip', async () => {
		const router = createRouter({history: createMemoryHistory(), routes: [{path: '/', component: {template: '<div />'}}]})
		wrapper = mount(ProjectAccessBadge, {
			props: {project: mineInTeam, compact: true},
			global: {plugins: [i18n, router, [VueQueryPlugin, {queryClient}]], stubs: {Icon: true}},
		})
		await flushPromises()

		const badge = wrapper.find('.project-access-badge')
		expect(badge.attributes('title')).toBe('In a shared project People with access to “Team” can open it.')
		expect(badge.find('.project-access-badge__label').classes()).toContain('is-sr-only')
	})
})
