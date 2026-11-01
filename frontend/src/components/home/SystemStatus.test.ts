import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'

const sdk = vi.hoisted(() => ({systemStatus: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/stores/base', () => ({useBaseStore: () => ({menuActive: true})}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import SystemStatus from './SystemStatus.vue'

enableAutoUnmount(afterEach)

describe('SystemStatus', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		sdk.systemStatus.mockReset().mockImplementation(async () => ({data: {
			healthy: true,
			host_metrics_available: true,
			version: 'v1',
			uptime_seconds: 60,
		}}))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('refreshes the sidebar meters once a minute, and every few seconds while its details are open', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const wrapper = mount(SystemStatus, {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		await flushPromises()
		sdk.systemStatus.mockClear()

		await vi.advanceTimersByTimeAsync(60_000)
		expect(sdk.systemStatus).toHaveBeenCalledTimes(1)

		const details = wrapper.find('details').element as HTMLDetailsElement
		details.open = true
		details.dispatchEvent(new Event('toggle'))
		await flushPromises()
		sdk.systemStatus.mockClear()

		await vi.advanceTimersByTimeAsync(20_000)
		expect(sdk.systemStatus).toHaveBeenCalledTimes(4)
	})
})
