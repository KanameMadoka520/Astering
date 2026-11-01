import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {defineComponent, h, reactive} from 'vue'
import {createMemoryHistory, createRouter, RouterLink} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

vi.mock('@/stores/auth', () => ({useAuthStore: () => reactive({info: {id: 1}, isLinkShareAuth: false})}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => 'https://tasks.example.com/api/v1/'}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key}),
}))

import CompassEntryActions from './CompassEntryActions.vue'
import {provideCompassEntryCommands} from './useCompassEntryCommands'
import {normalizeCompassEntry} from '@/client/queries/compass'
import {compassDraftKey} from '@/helpers/compass/drafts'
import {compassAccountNamespace} from '@/helpers/compass/storage'
import {DEFAULT_COMPASS_READING_PREFS} from '@/helpers/compass/storage'

const entry = normalizeCompassEntry({id: 7, space_id: 3, title: 'Letters to myself', content: '<p>Dear me,</p>', revision: 2, state: 'active', max_permission: 1})
const draftKey = compassDraftKey(compassAccountNamespace('https://tasks.example.com/api/v1/', 1), 3, 7)

let wrapper: VueWrapper | undefined

async function mountActions() {
	const Reader = defineComponent({
		setup() {
			provideCompassEntryCommands(() => entry, () => {})
			return () => h(CompassEntryActions, {entry, prefs: DEFAULT_COMPASS_READING_PREFS})
		},
	})
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/', component: {render: () => null}},
		{path: '/compass/entries/:entryId/edit', name: 'compass.entry.edit', component: {render: () => null}},
		{path: '/compass/entries/:entryId/history', name: 'compass.entry.history', component: {render: () => null}},
	]})
	await router.push('/')
	wrapper = mount(Reader, {
		global: {
			plugins: [router, [VueQueryPlugin, {queryClient: new QueryClient()}]],
			mocks: {$t: (key: string) => key},
			stubs: {Icon: true, Dropdown: true, CompassReadingSettings: true, CompassPermanentDeleteDialog: true, RouterLink},
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

describe('CompassEntryActions with a draft kept on this device', () => {
	it('offers to continue the draft and says it is only on this device', async () => {
		localStorage.setItem(draftKey, JSON.stringify({
			v: 1,
			spaceId: 3,
			entryId: 7,
			baseRevision: 2,
			savedAt: '2026-10-30T08:00:00Z',
			fields: {kind: 'note', title: 'Letters to my future self', subtitle: '', content: '<p>Dear me,</p>', quote: '', category: '', tags: [], theme: 'inherit', pinned: false},
		}))
		const view = await mountActions()

		const edit = view.find('a[href="/compass/entries/7/edit"]')
		expect(edit.text()).toBe('compass.actions.continueDraft')
		const note = view.find('.compass-actions__draft')
		expect(note.text()).toContain('compass.reader.draftWaitingSince')
		expect(edit.attributes('aria-describedby')).toBe(note.attributes('id'))
	})

	it('just says Edit without a draft', async () => {
		const view = await mountActions()

		expect(view.find('a[href="/compass/entries/7/edit"]').text()).toBe('compass.actions.edit')
		expect(view.find('.compass-actions__draft').exists()).toBe(false)
	})
})
