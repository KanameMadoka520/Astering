/* eslint-disable vue/one-component-per-file -- The popup stub exposes its slot without a browser popover. */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {removeToken} from '@/helpers/auth'

const sdk = vi.hoisted(() => ({tcyAiMcpSettings: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))
import MCPSessionPicker from './MCPSessionPicker.vue'
import {mcpSettingsKey, normalizeMCPConnection, type MCPSettings} from '@/client/queries/tcyMcp'

enableAutoUnmount(afterEach)
const Popup = defineComponent({
	setup: (_, {slots}) => () => h('div', [
		slots.trigger?.({toggle: () => {}}),
		slots.content?.({close: () => {}}),
	]),
})
function settings(): MCPSettings {
	return {
		revision: 1,
		connections: [normalizeMCPConnection({id: 'enabled', name: 'Enabled', enabled: true, has_key: true})],
	}
}
function picker(ids: string[], data?: MCPSettings) {
	const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	if (data) client.setQueryData(mcpSettingsKey, data)
	const wrapper = mount(MCPSessionPicker, {
		props: {modelValue: ids},
		global: {
			mocks: {$t: (key: string) => key},
			plugins: [[VueQueryPlugin, {queryClient: client}]],
			stubs: {Popup, Icon: true, RouterLink: true},
		},
	})
	return {wrapper, client}
}
beforeEach(() => {
	vi.resetAllMocks()
	removeToken()
})

describe('conversation MCP selection freshness', () => {
	it('does not automatically fetch settings or tool directories for an unselected closed picker', async () => {
		const {wrapper} = picker([])
		await flushPromises()
		expect(sdk.tcyAiMcpSettings).not.toHaveBeenCalled()
		expect(wrapper.emitted('update:modelValue')).toBeUndefined()
	})

	it('validates a restored choice even when fresh settings are already cached', async () => {
		const {wrapper} = picker(['enabled', 'deleted'], settings())
		await flushPromises()
		expect(wrapper.emitted('update:modelValue')).toEqual([[['enabled']]])
		expect(sdk.tcyAiMcpSettings).not.toHaveBeenCalled()
	})

	it('preserves a choice while loading fails, then drops it only after a confirmed disable', async () => {
		sdk.tcyAiMcpSettings.mockRejectedValue(new Error('offline'))
		const {wrapper, client} = picker(['enabled'])
		await flushPromises()
		expect(wrapper.emitted('update:modelValue')).toBeUndefined()
		const confirmed = settings()
		confirmed.connections[0].enabled = false
		client.setQueryData(mcpSettingsKey, confirmed)
		await flushPromises()
		expect(wrapper.emitted('update:modelValue')).toEqual([[[]]])
	})

	it('ignores late settings from a previous authentication session', async () => {
		const {wrapper, client} = picker(['enabled'], settings())
		await flushPromises()
		removeToken()
		client.setQueryData(mcpSettingsKey, {...settings(), connections: []})
		await flushPromises()
		expect(wrapper.emitted('update:modelValue')).toBeUndefined()
	})
})
