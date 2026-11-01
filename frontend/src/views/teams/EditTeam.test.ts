import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	teamsRead: vi.fn(),
	teamsList: vi.fn(),
	teamsUpdate: vi.fn(),
	teamsDelete: vi.fn(),
	teamsMembersAdd: vi.fn(),
	teamsMembersRemove: vi.fn(),
	teamsMembersToggleAdmin: vi.fn(),
	compassSpacesList: vi.fn(),
	usersSearch: vi.fn(),
	userShow: vi.fn(),
	projectsList: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import EditTeam from './EditTeam.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const ME = {id: 1, username: 'me'}
const SAM = {id: 2, username: 'sam'}
const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined
let router: Router

function team(members: {id: number, username: string, admin: boolean}[], extra: Record<string, unknown> = {}) {
	return {data: {id: 3, name: 'Crew', max_permission: 2, members, ...extra}}
}

function spaces(items: unknown[]) {
	return {data: {items, total_pages: 1}}
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
	sdk.teamsRead.mockResolvedValue(team([{...ME, admin: true}, {...SAM, admin: false}]))
	sdk.compassSpacesList.mockResolvedValue(spaces([
		{id: 11, team_id: 3, title: 'Shared sky', entry_count: 12},
		{id: 12, team_id: 0, title: 'My own sky', entry_count: 4},
		{id: 13, team_id: 8, title: 'Other team sky', entry_count: 1},
	]))
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountTeam() {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: {template: '<div />'}},
			{path: '/teams', name: 'teams.index', component: {template: '<div />'}},
			{path: '/teams/:id/edit', name: 'teams.edit', component: EditTeam},
		],
	})
	await router.push('/teams/3/edit')
	await router.isReady()
	wrapper = mount(EditTeam, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Card, Modal},
			directives: {cy: testid, focus: {}, tooltip: {}},
			stubs: {
				Icon: true,
				EditTeamForm: true,
				Multiselect: true,
				User: {props: ['user'], template: '<span>{{ user.username }}</span>'},
			},
		},
	})
	await flushPromises()
	return wrapper
}

function button(name: string, root: ParentNode = document) {
	const found = [...root.querySelectorAll('button')].find(candidate =>
		candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)
	if (!found) throw new Error(`No button "${name}"`)
	return found
}

function openDialog() {
	return document.querySelector('dialog.modal-dialog:not([data-closing])')
}

describe('EditTeam: deleting the team', () => {
	it('names the Compass spaces that are deleted with the team', async () => {
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()

		const text = openDialog()?.textContent ?? ''
		expect(text).toContain('Delete “Crew”?')
		expect(text).toContain('Shared sky')
		expect(text).toContain('12 entries')
		expect(text).not.toContain('My own sky')
		expect(text).not.toContain('Other team sky')
		// Members keep their accounts.
		expect(text).not.toContain('all of its members')
	})

	it('says when it could not check for Compass spaces', async () => {
		sdk.compassSpacesList.mockRejectedValue(new Error('offline'))
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()

		const text = openDialog()?.textContent ?? ''
		expect(text).toContain('Couldn\'t load the Compass spaces you can open.')
		expect(text).toContain('Every Compass space that belongs to this team is deleted permanently with it')
		expect(text).not.toContain('No Compass spaces')
	})

	it('warns about the team\'s Compass spaces even when none are visible', async () => {
		// The list only holds spaces the viewer can open, so an empty one proves nothing.
		sdk.compassSpacesList.mockResolvedValue(spaces([{id: 12, team_id: 0, title: 'My own sky', entry_count: 4}]))
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()

		const text = openDialog()?.textContent ?? ''
		expect(text).toContain('Every Compass space that belongs to this team is deleted permanently with it')
		expect(text).not.toContain('No Compass spaces')
	})

	it('says other spaces may exist when the viewer is not in the team', async () => {
		// An instance admin can delete any team but only opens the spaces of teams they are in.
		sdk.teamsRead.mockResolvedValue(team([{...SAM, admin: true}, {id: 4, username: 'kim', admin: false}]))
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()

		expect(openDialog()?.textContent).toContain('The team may have other spaces you can\'t open; they are deleted too.')
	})

	it('asks for an acknowledgement before deleting', async () => {
		sdk.teamsDelete.mockReturnValue(new Promise(() => {}))
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()

		primary(openDialog()).click()
		await flushPromises()
		expect(sdk.teamsDelete).not.toHaveBeenCalled()
		expect(openDialog()?.querySelector('[role="alert"]')?.textContent).toContain('Tick the box above to confirm.')

		acknowledge()
		await flushPromises()
		primary(openDialog()).click()
		await flushPromises()
		expect(sdk.teamsDelete).toHaveBeenCalledTimes(1)
	})
})

function acknowledge() {
	const checkbox = openDialog()?.querySelector<HTMLInputElement>('input[type="checkbox"]')
	if (!checkbox) throw new Error('No acknowledgement checkbox')
	checkbox.click()
}

function primary(dialog: Element | null) {
	const found = dialog?.querySelector<HTMLButtonElement>('.actions .is-primary')
	if (!found) throw new Error('No confirm button')
	return found
}

describe('EditTeam: confirmations stay open until the change succeeds', () => {
	it('keeps the delete dialog open when deleting fails and sends one request for a double click', async () => {
		sdk.teamsDelete.mockRejectedValue(new Error('offline'))
		await mountTeam()
		button('Delete the team').click()
		await flushPromises()
		acknowledge()
		await flushPromises()

		const confirm = primary(openDialog())
		confirm.click()
		confirm.click()
		await flushPromises()

		expect(sdk.teamsDelete).toHaveBeenCalledTimes(1)
		expect(openDialog()?.textContent).toContain('Delete “Crew”?')
		expect(router.currentRoute.value.name).toBe('teams.edit')
	})

	it('names the member and keeps the dialog open when removing fails', async () => {
		sdk.teamsMembersRemove.mockRejectedValue(new Error('offline'))
		await mountTeam()
		button('Remove a user from the team').click()
		await flushPromises()

		expect(openDialog()?.textContent).toContain('Remove sam from Crew?')
		const confirm = primary(openDialog())
		confirm.click()
		confirm.click()
		await flushPromises()

		expect(sdk.teamsMembersRemove).toHaveBeenCalledTimes(1)
		expect(openDialog()?.textContent).toContain('Remove sam from Crew?')
	})

	it('keeps the leave dialog open when leaving fails', async () => {
		sdk.teamsMembersRemove.mockRejectedValue(new Error('offline'))
		await mountTeam()
		button('Leave team').click()
		await flushPromises()

		primary(openDialog()).click()
		await flushPromises()

		expect(sdk.teamsMembersRemove).toHaveBeenCalledTimes(1)
		expect(openDialog()?.textContent).toContain('Leave “Crew”?')
		expect(router.currentRoute.value.name).toBe('teams.edit')
	})
})

describe('EditTeam: leaving', () => {
	it('warns the only admin that nobody could manage the team', async () => {
		await mountTeam()
		button('Leave team').click()
		await flushPromises()

		expect(openDialog()?.textContent).toContain('You\'re the only admin of this team.')
	})

	it('does not warn when another admin remains', async () => {
		sdk.teamsRead.mockResolvedValue(team([{...ME, admin: true}, {...SAM, admin: true}]))
		await mountTeam()
		button('Leave team').click()
		await flushPromises()

		expect(openDialog()?.textContent).not.toContain('only admin')
	})

	it('offers deleting instead of leaving to the only member', async () => {
		sdk.teamsRead.mockResolvedValue(team([{...ME, admin: true}]))
		await mountTeam()

		expect(() => button('Leave team')).toThrow()
		expect(wrapper!.text()).toContain('You\'re the only member of this team. To leave it, delete the team.')
	})

	it('names the Compass spaces the member loses', async () => {
		await mountTeam()
		button('Leave team').click()
		await flushPromises()

		expect(openDialog()?.textContent).toContain('You also lose access to the Compass space shared with this team: Shared sky.')
	})
})

describe('EditTeam: states and managed teams', () => {
	it('does not show an empty member table when the team fails to load', async () => {
		sdk.teamsRead.mockRejectedValue(new Error('offline'))
		await mountTeam()

		expect(wrapper!.find('[role="alert"]').exists()).toBe(true)
		expect(wrapper!.find('table').exists()).toBe(false)
	})

	it('does not offer removing members of a team managed by the sign-in provider', async () => {
		sdk.teamsRead.mockResolvedValue(team([{...ME, admin: true}, {...SAM, admin: false}], {external_id: 'oidc-crew'}))
		await mountTeam()

		expect(() => button('Remove a user from the team')).toThrow()
		expect(wrapper!.text()).toContain('Members of this team are managed by your sign-in provider.')
	})

	it('asks before making someone an admin', async () => {
		sdk.teamsMembersToggleAdmin.mockResolvedValue({data: {admin: true}})
		await mountTeam()
		button('Make Admin').click()
		await flushPromises()

		expect(sdk.teamsMembersToggleAdmin).not.toHaveBeenCalled()
		expect(openDialog()?.textContent).toContain('Make sam an admin?')
		primary(openDialog()).click()
		await flushPromises()
		expect(sdk.teamsMembersToggleAdmin).toHaveBeenCalledTimes(1)
	})
})

describe('EditTeam: sending twice', () => {
	it('adds a member once when the add form is sent twice', async () => {
		sdk.teamsMembersAdd.mockReturnValue(new Promise(() => {}))
		await mountTeam()
		wrapper!.findComponent({name: 'Multiselect'}).vm.$emit('update:modelValue', {id: 5, username: 'kim'})
		await flushPromises()

		// Two Enter presses before the page has re-rendered.
		const form = wrapper!.find('form.team-members__add').element
		form.dispatchEvent(new Event('submit', {cancelable: true}))
		form.dispatchEvent(new Event('submit', {cancelable: true}))
		await flushPromises()

		expect(sdk.teamsMembersAdd).toHaveBeenCalledTimes(1)
	})

	it('saves the team once when the form is sent twice', async () => {
		sdk.teamsUpdate.mockReturnValue(new Promise(() => {}))
		await mountTeam()

		const form = wrapper!.findComponent({name: 'EditTeamForm'})
		form.vm.$emit('save', {name: 'Crew 2', description: '', is_public: false})
		form.vm.$emit('save', {name: 'Crew 2', description: '', is_public: false})
		await flushPromises()

		expect(sdk.teamsUpdate).toHaveBeenCalledTimes(1)
	})
})
