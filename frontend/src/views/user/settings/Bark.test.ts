import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({barkSettings: vi.fn(), barkSave: vi.fn(), barkTest: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useTitle', () => ({useTitle: vi.fn()}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))

import Bark from './Bark.vue'

let wrapper: VueWrapper | undefined
let queryClient: QueryClient

async function setup() {
	queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
	wrapper = mount(Bark, {
		global: {
			plugins: [[VueQueryPlugin, {queryClient}]],
			mocks: {$t: (key: string) => key},
			stubs: {
				Card: {props: ['title', 'loading'], template: '<section class="card" :data-loading="loading"><slot /></section>'},
				PageHeader: true,
				Icon: true,
				XButton: {template: '<button type="button"><slot /></button>'},
			},
		},
	})
	await flushPromises()
	return wrapper
}

beforeEach(() => {
	setActivePinia(createPinia())
	Object.values(sdk).forEach(fn => fn.mockReset())
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

describe('Bark settings', () => {
	it('does not claim there were no deliveries when the settings failed to load, and offers a retry', async () => {
		sdk.barkSettings.mockRejectedValue(new Error('Server error'))
		const view = await setup()

		expect(view.text()).not.toContain('bark.empty')
		expect(view.text()).toContain('bark.deliveriesUnknown')
		expect(view.find('.load-error').exists()).toBe(true)
		// The page shows the failure itself, so the global error toast stays quiet on every poll.
		expect(queryClient.getQueryCache().find({queryKey: ['personal-bark']})?.meta?.handlesError).toBe(true)

		sdk.barkSettings.mockResolvedValueOnce({data: {settings: {enabled: false, has_key: false}, deliveries: []}})
		await view.find('.load-error button').trigger('click')
		await flushPromises()
		expect(view.text()).toContain('bark.empty')
	})

	it('says it is loading, not "no deliveries", before the first answer', async () => {
		sdk.barkSettings.mockReturnValue(new Promise(() => {}))
		const view = await setup()

		expect(view.text()).not.toContain('bark.empty')
		expect(view.text()).toContain('misc.loading')
	})
})
