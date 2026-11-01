import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {reactive} from 'vue'
import {createMemoryHistory, createRouter, RouterLink} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

vi.mock('@/stores/auth', () => ({useAuthStore: () => reactive({info: {id: 1}, isLinkShareAuth: false})}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => 'https://tasks.example.com/api/v1/'}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import CompassHero from './CompassHero.vue'
import {normalizeCompassSpace} from '@/client/queries/compass'
import {compassDraftKey} from '@/helpers/compass/drafts'
import {compassAccountNamespace} from '@/helpers/compass/storage'

const space = normalizeCompassSpace({id: 3, title: 'Letters', max_permission: 2})
let wrapper: VueWrapper | undefined

async function mountHero() {
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/', component: {render: () => null}},
		{path: '/compass/spaces/:spaceId/write', name: 'compass.entry.new', component: {render: () => null}},
		{path: '/compass/spaces/:spaceId/settings', name: 'compass.space.settings', component: {render: () => null}},
	]})
	await router.push('/')
	wrapper = mount(CompassHero, {
		props: {space},
		global: {
			plugins: [router, [VueQueryPlugin, {queryClient: new QueryClient()}]],
			mocks: {$t: (key: string) => key},
			stubs: {
				Icon: true,
				CompassSkyHeader: {template: '<div><slot /></div>'},
				CompassSpaceSwitcher: true,
				CompassSpaceExport: true,
				RouterLink,
			},
		},
	})
	await flushPromises()
	return wrapper
}

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	localStorage.clear()
})

describe('CompassHero', () => {
	it('points to a new entry kept unsaved on this device', async () => {
		localStorage.setItem(compassDraftKey(compassAccountNamespace('https://tasks.example.com/api/v1/', 1), 3, 0), JSON.stringify({
			v: 1,
			spaceId: 3,
			entryId: 0,
			baseRevision: 0,
			savedAt: '2026-10-30T08:00:00Z',
			fields: {kind: 'note', title: 'Half a thought', subtitle: '', content: '', quote: '', category: '', tags: [], theme: 'inherit', pinned: false},
		}))
		const hero = await mountHero()

		const notice = hero.find('.compass-hero__draft')
		expect(notice.text()).toContain('compass.hero.newDraft')
		expect(notice.find('a').attributes('href')).toBe('/compass/spaces/3/write')
	})

	it('says who can open the space and where it is kept, as text rather than a tooltip', async () => {
		const hero = await mountHero()

		const privacy = hero.find('details.compass-hero__privacy')
		expect(privacy.find('summary').text()).toBe('compass.hero.privacyTitle')
		expect(privacy.text()).toContain('compass.space.personalHint')
		expect(privacy.text()).toContain('compass.space.storageNote')
		expect(hero.find('.compass-hero__draft').exists()).toBe(false)
	})
})
