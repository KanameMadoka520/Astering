import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {VueQueryPlugin, useQuery} from '@tanstack/vue-query'
import {createPinia, setActivePinia} from 'pinia'
import {defineComponent} from 'vue'

const sdk = vi.hoisted(() => ({
	tcyShowcaseSettings: vi.fn(),
	tcyShowcaseSave: vi.fn(),
	tcyShowcasePreview: vi.fn(),
	tcyShowcasePublish: vi.fn(),
	tcyShowcaseUnpublish: vi.fn(),
	tcyShowcasePublic: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import {showcaseSettingsQuery, usePublishShowcase, useUnpublishShowcase} from './tcyShowcase'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {useAuthStore} from '@/stores/auth'

const defaults = queryClient.getDefaultOptions()
const key = showcaseSettingsQuery().queryKey

beforeAll(() => {
	queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
})

afterAll(() => {
	queryClient.setDefaultOptions(defaults)
})

beforeEach(() => {
	vi.resetAllMocks()
	setActivePinia(createPinia())
	useAuthStore().setSession({id: 1, username: 'me', type: AUTH_TYPES.USER, exp: 0})
})

afterEach(() => {
	queryClient.clear()
})

// The settings page keeps the query mounted, so the follow-up refetch really runs.
function mountSettings() {
	let actions!: {publish: ReturnType<typeof usePublishShowcase>, unpublish: ReturnType<typeof useUnpublishShowcase>}
	const wrapper = mount(defineComponent({
		setup() {
			useQuery(showcaseSettingsQuery())
			actions = {publish: usePublishShowcase(), unpublish: useUnpublishShowcase()}
			return () => null
		},
	}), {global: {plugins: [[VueQueryPlugin, {queryClient}]]}})
	return {wrapper, actions}
}

describe('tcyShowcase', () => {
	it('lets the settings page show its own load error', () => {
		expect(showcaseSettingsQuery().meta?.handlesError).toBe(true)
	})

	it('shows the page as taken down when the refetch after taking it down fails', async () => {
		sdk.tcyShowcaseSettings.mockResolvedValueOnce({data: {draft: {slug: 'tcy'}, published: {slug: 'tcy'}}})
		const {wrapper, actions} = mountSettings()
		await flushPromises()

		sdk.tcyShowcaseSettings.mockRejectedValue(new Error('offline'))
		sdk.tcyShowcaseUnpublish.mockResolvedValue({data: {draft: {slug: 'tcy'}}})
		await actions.unpublish.mutateAsync()
		await flushPromises()

		expect(sdk.tcyShowcaseSettings).toHaveBeenCalledTimes(2)
		expect(queryClient.getQueryData<{published?: unknown}>(key)?.published).toBeUndefined()
		wrapper.unmount()
	})

	it('shows the page as published when the refetch after publishing fails', async () => {
		sdk.tcyShowcaseSettings.mockResolvedValueOnce({data: {draft: {slug: 'tcy'}}})
		const {wrapper, actions} = mountSettings()
		await flushPromises()

		sdk.tcyShowcaseSettings.mockRejectedValue(new Error('offline'))
		sdk.tcyShowcasePublish.mockResolvedValue({data: {draft: {slug: 'tcy'}, published: {slug: 'tcy'}}})
		await actions.publish.mutateAsync({slug: 'tcy'} as never)
		await flushPromises()

		expect(queryClient.getQueryData<{published?: unknown}>(key)?.published).toEqual({slug: 'tcy'})
		wrapper.unmount()
	})
})
