import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	projectUsersList: vi.fn(),
	projectUsersCreate: vi.fn(),
	projectUsersUpdate: vi.fn(),
	projectUsersDelete: vi.fn(),
	projectTeamsList: vi.fn(),
	projectTeamsCreate: vi.fn(),
	projectTeamsUpdate: vi.fn(),
	projectTeamsDelete: vi.fn(),
	projectsList: vi.fn(),
	usersSearch: vi.fn(),
	teamsList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
const message = vi.hoisted(() => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/message', () => message)

import UserSharing from './UserSharing.vue'
import TeamSharing from './TeamSharing.vue'
import XButton from '@/components/input/Button.vue'
import Modal from '@/components/misc/Modal.vue'
import {projectShareKeys} from '@/client/queries/projectShares'
import {normalizeProject} from '@/client/queries/projects'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const ME = {id: 1, username: 'me'}
const parent = normalizeProject({id: 1, title: 'Parent', owner: ME, parent_project_id: 0, max_permission: 2})
const child = normalizeProject({id: 2, title: 'Child', owner: ME, parent_project_id: 1, max_permission: 2})

type Kind = 'user' | 'team'
const kinds = {
	user: {component: UserSharing, list: sdk.projectUsersList, remove: sdk.projectUsersDelete, noun: 'users'},
	team: {component: TeamSharing, list: sdk.projectTeamsList, remove: sdk.projectTeamsDelete, noun: 'teams'},
} as const

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

function page<T>(items: T[]) {
	return {data: {items, total_pages: 1}}
}

function never() {
	return new Promise(() => {})
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
	sdk.projectsList.mockResolvedValue(page([parent, child]))
	sdk.projectUsersList.mockResolvedValue(page([]))
	sdk.projectTeamsList.mockResolvedValue(page([]))
	sdk.userShow.mockReturnValue(never())
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

let router: ReturnType<typeof createRouter>

function mountSharing(kind: Kind, project = child) {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: {template: '<div />'}},
			{path: '/projects/:projectId/settings/share', name: 'project.settings.share', component: {template: '<div />'}},
			{path: '/teams/:id/edit', name: 'teams.edit', component: {template: '<div />'}},
		],
	})
	wrapper = mount(kinds[kind].component, {
		attachTo: document.body,
		props: {
			// The pre-v35 components took a bare id; passing both keeps this test runnable against them.
			projectId: project.id,
			project,
			userIsAdmin: true,
		},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Modal},
			directives: {cy: testid, tooltip: {}},
			stubs: {Icon: true, Multiselect: true},
		},
	})
	return wrapper
}

function buttonNamed(name: string) {
	const button = [...document.querySelectorAll('button')].find(candidate =>
		candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)
	if (!button) throw new Error(`No button "${name}"`)
	return button
}

describe.each(['user', 'team'] as const)('%s share list', kind => {
	const {list, noun} = kinds[kind]

	it('does not claim the project is unshared while the list is loading', async () => {
		list.mockReturnValue(never())
		mountSharing(kind)
		await flushPromises()

		expect(wrapper!.text()).not.toMatch(/Not shared/)
		expect(wrapper!.find('[role="status"]').exists()).toBe(true)
	})

	it('shows a retryable error instead of "not shared" when the list fails', async () => {
		list.mockRejectedValue(new Error('offline'))
		mountSharing(kind)
		await flushPromises()

		expect(wrapper!.text()).not.toMatch(/Not shared/)
		const alert = wrapper!.find('[role="alert"]')
		expect(alert.exists()).toBe(true)
		expect(alert.text()).toContain('Couldn\'t check who this project is shared with.')
		// The inline error replaces the global toast.
		expect(message.error).not.toHaveBeenCalled()

		list.mockResolvedValue(page([]))
		await alert.find('button').trigger('click')
		await flushPromises()

		expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
		expect(wrapper!.text()).toContain(`Not shared directly with any ${noun} yet.`)
	})

	it('does not repeat an old empty list when refreshing it fails', async () => {
		// An earlier visit left an empty list in the cache; since then someone may have been added.
		queryClient.setQueryData(projectShareKeys[noun](child.id), [], {updatedAt: 0})
		list.mockRejectedValue(new Error('offline'))
		mountSharing(kind)
		await flushPromises()

		expect(list).toHaveBeenCalled()
		expect(wrapper!.text()).not.toMatch(/Not shared/)
		expect(wrapper!.find('[role="alert"]').exists()).toBe(true)
	})
})

describe('removing a direct share', () => {
	it('says when the user keeps access through a parent project', async () => {
		sdk.projectUsersList.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page(path.project === child.id
			? [{id: 9, username: 'sam', permission: 0}]
			: [{id: 9, username: 'sam', permission: 1}])))
		mountSharing('user')
		await flushPromises()

		buttonNamed('Remove this user').click()
		await flushPromises()

		const dialog = document.querySelector('dialog.modal-dialog:not([data-closing])')
		expect(dialog?.textContent).toContain('Remove sam?')
		expect(dialog?.textContent).toContain('sam keeps at least Read & write access through the parent project “Parent”.')
	})

	it('says when the team keeps access through a parent project', async () => {
		sdk.projectTeamsList.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page(path.project === child.id
			? [{id: 5, name: 'Ops', permission: 0}]
			: [{id: 5, name: 'Ops', permission: 2}])))
		mountSharing('team')
		await flushPromises()

		buttonNamed('Remove this team').click()
		await flushPromises()

		const dialog = document.querySelector('dialog.modal-dialog:not([data-closing])')
		expect(dialog?.textContent).toContain('Remove Ops?')
		expect(dialog?.textContent).toContain('Ops keeps at least Admin access through the parent project “Parent”.')
	})
})

describe('admin access on any parent project applies', () => {
	const grand = normalizeProject({id: 10, title: 'Grand', owner: ME, parent_project_id: 0, max_permission: 2})
	const mid = normalizeProject({id: 11, title: 'Mid', owner: ME, parent_project_id: 10, max_permission: 2})
	const leaf = normalizeProject({id: 12, title: 'Leaf', owner: ME, parent_project_id: 11, max_permission: 2})

	beforeEach(() => {
		sdk.projectsList.mockResolvedValue(page([grand, mid, leaf]))
	})

	it('names the admin grant of a farther parent over a nearer read grant for a user', async () => {
		sdk.projectUsersList.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page([
			{id: 9, username: 'sam', permission: path.project === grand.id ? 2 : 0},
		])))
		mountSharing('user', leaf)
		await flushPromises()

		buttonNamed('Remove this user').click()
		await flushPromises()

		expect(document.querySelector('dialog.modal-dialog:not([data-closing])')?.textContent)
			.toContain('sam keeps at least Admin access through the parent project “Grand”.')
	})

	it('treats the owner of a farther parent as an admin there', async () => {
		const sam = {id: 9, username: 'sam'}
		sdk.projectsList.mockResolvedValue(page([{...grand, owner: sam}, mid, leaf]))
		sdk.projectUsersList.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page(
			path.project === grand.id ? [] : [{...sam, permission: 0}],
		)))
		mountSharing('user', leaf)
		await flushPromises()

		buttonNamed('Remove this user').click()
		await flushPromises()

		expect(document.querySelector('dialog.modal-dialog:not([data-closing])')?.textContent)
			.toContain('sam keeps at least Admin access through the parent project “Grand”.')
	})

	it('names the admin grant of a farther parent over a nearer read grant for a team', async () => {
		sdk.projectTeamsList.mockImplementation(({path}: {path: {project: number}}) => Promise.resolve(page([
			{id: 5, name: 'Ops', permission: path.project === grand.id ? 2 : 0},
		])))
		mountSharing('team', leaf)
		await flushPromises()

		buttonNamed('Remove this team').click()
		await flushPromises()

		expect(document.querySelector('dialog.modal-dialog:not([data-closing])')?.textContent)
			.toContain('Ops keeps at least Admin access through the parent project “Grand”.')
	})
})

describe('team names in the share list', () => {
	it('links only teams the viewer can open', async () => {
		// With public teams, a share can name a team the viewer isn't in; its team page would answer 403.
		sdk.projectTeamsList.mockResolvedValue(page([
			{id: 5, name: 'Public crew', permission: 0},
			{id: 6, name: 'My crew', permission: 0},
		]))
		sdk.teamsList.mockResolvedValue(page([{id: 6, name: 'My crew'}]))
		mountSharing('team')
		await flushPromises()

		const links = wrapper!.findAll('a').map(link => link.text())
		expect(links).toEqual(['My crew'])
		expect(wrapper!.text()).toContain('Public crew')
	})
})

describe('your own share', () => {
	const SAM = {id: 7, username: 'sam'}
	const theirs = normalizeProject({id: 2, title: 'Their project', owner: SAM, parent_project_id: 0, max_permission: 2})

	beforeEach(() => {
		sdk.projectsList.mockResolvedValue(page([theirs]))
		sdk.projectUsersList.mockResolvedValue(page([{...ME, permission: 2}, {id: 9, username: 'kim', permission: 0}]))
	})

	it('asks before lowering your own permission', async () => {
		sdk.projectUsersUpdate.mockResolvedValue({data: {...ME, permission: 0}})
		mountSharing('user', theirs)
		await flushPromises()

		const select = wrapper!.find<HTMLSelectElement>('select[aria-label="Permission for me"]')
		await select.setValue('0')
		await flushPromises()
		expect(sdk.projectUsersUpdate).not.toHaveBeenCalled()
		const dialog = document.querySelector('dialog.modal-dialog:not([data-closing])')
		expect(dialog?.textContent).toContain('Lower your own permission to Read only?')

		dialog!.querySelector<HTMLButtonElement>('.actions .is-primary')!.click()
		await flushPromises()
		expect(sdk.projectUsersUpdate).toHaveBeenCalledTimes(1)
	})

	it('puts your permission back when you cancel lowering it', async () => {
		mountSharing('user', theirs)
		await flushPromises()

		const select = wrapper!.find<HTMLSelectElement>('select[aria-label="Permission for me"]')
		await select.setValue('0')
		await flushPromises()
		buttonNamed('Cancel').click()
		await flushPromises()

		expect(sdk.projectUsersUpdate).not.toHaveBeenCalled()
		expect(select.element.value).toBe('2')
	})

	it('changes someone else\'s permission straight away', async () => {
		sdk.projectUsersUpdate.mockResolvedValue({data: {id: 9, username: 'kim', permission: 1}})
		mountSharing('user', theirs)
		await flushPromises()

		await wrapper!.find('select[aria-label="Permission for kim"]').setValue('1')
		await flushPromises()
		expect(sdk.projectUsersUpdate).toHaveBeenCalledTimes(1)
	})

	it('asks before removing your own access and leaves the project afterwards', async () => {
		sdk.projectUsersDelete.mockResolvedValue({})
		mountSharing('user', theirs)
		await flushPromises()

		const rows = wrapper!.findAll('tbody tr')
		const own = rows.find(row => row.text().includes('me'))!
		await own.find('button[aria-label="Remove this user"]').trigger('click')
		await flushPromises()

		const dialog = document.querySelector('dialog.modal-dialog:not([data-closing])')
		expect(dialog?.textContent).toContain('Remove your own access?')
		expect(dialog?.textContent).toContain('You won\'t be able to open “Their project” unless you have access another way.')
		dialog!.querySelector<HTMLButtonElement>('.actions .is-primary')!.click()
		await flushPromises()

		expect(sdk.projectUsersDelete).toHaveBeenCalledTimes(1)
		expect(router.currentRoute.value.name).toBe('home')
	})
})
