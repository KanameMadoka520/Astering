import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	teamsList: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ListTeams from './ListTeams.vue'
import NewTeam from './NewTeam.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import {queryClient} from '@/client/queryClient'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'

const DESCRIPTION = 'A team is a group of people. Creating one shares nothing; you choose which projects and Compass spaces to share with it.'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

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
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.teamsList.mockResolvedValue({data: {items: [{id: 1, name: 'Ops'}], total_pages: 1}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountView(component: typeof ListTeams | typeof NewTeam) {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/teams', name: 'teams.index', component: {template: '<div />'}},
			{path: '/teams/new', name: 'teams.create', component: {template: '<div />'}},
			{path: '/teams/:id/edit', name: 'teams.edit', component: {template: '<div />'}},
		],
	})
	await router.push('/teams')
	await router.isReady()
	wrapper = mount(component, {
		attachTo: document.body,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Card},
			directives: {cy: testid, focus: {}, tooltip: {}},
			stubs: {Icon: true},
		},
	})
	await flushPromises()
	return wrapper
}

describe('teams: what a team is', () => {
	it('says on the teams page that creating a team shares nothing', async () => {
		await mountView(ListTeams)

		expect(wrapper!.find('.page-header__description').text()).toBe(DESCRIPTION)
	})

	it('says it again where a team is created', async () => {
		await mountView(NewTeam)

		expect(document.body.textContent).toContain(DESCRIPTION)
	})
})
