/* eslint-disable vue/one-component-per-file -- Native control stubs isolate asynchronous ownership, not product behavior. */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {removeToken} from '@/helpers/auth'

const sdk = vi.hoisted(() => ({
	tcyAiMcpSettings: vi.fn(),
	tcyAiMcpSaveSettings: vi.fn(),
	tcyAiMcpTest: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import MCPSettingsPanel from './MCPSettingsPanel.vue'
import {mcpSettingsKey, normalizeMCPConnection, type MCPSettings} from '@/client/queries/tcyMcp'

enableAutoUnmount(afterEach)

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return {promise, resolve, reject}
}
function saved(): MCPSettings {
	return {
		revision: 1,
		connections: ['a', 'b'].map(id => normalizeMCPConnection({
			id,
			name: `Saved ${id}`,
			url: `https://${id}.example/mcp`,
			has_key: true,
			revision: `revision-${id}`,
		})),
	}
}
const Button = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
function panel() {
	const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const wrapper = mount(MCPSettingsPanel, {
		props: {active: true},
		global: {
			mocks: {$t: (key: string) => key},
			plugins: [[VueQueryPlugin, {queryClient: client}]],
			stubs: {
				XButton: Button,
				RouterLink: true,
				Icon: true,
				Modal: true,
			},
		},
	})
	return {wrapper, client}
}
const testCatalog = {
	endpoint: 'https://a.example/mcp',
	server_name: 'Fixture',
	tools: [{name: 'list_fixture', description: 'Untrusted fixture', read_only: false, destructive: true}],
	matched: 1,
}

beforeEach(() => {
	vi.resetAllMocks()
	removeToken()
	sdk.tcyAiMcpSettings.mockResolvedValue({data: saved()})
})

describe('MCP per-connection save authority', () => {
	it('saves only one card against the saved revision and preserves edits made while it is pending', async () => {
		const pending = deferred<{data: MCPSettings}>()
		sdk.tcyAiMcpSaveSettings.mockReturnValue(pending.promise)
		const {wrapper} = panel()
		await flushPromises()
		const cards = wrapper.findAll('form')
		await cards[0].get('input[aria-label="tcy.mcp.name"]').setValue('Submitted a')
		await cards[1].get('input[type="password"]').setValue('unsaved-b-secret')
		await cards[0].trigger('submit')
		await flushPromises()
		const body = sdk.tcyAiMcpSaveSettings.mock.calls[0][0].body
		expect(body.revision).toBe(1)
		expect(body.connections[0].name).toBe('Submitted a')
		expect(body.connections[1]).toMatchObject({name: 'Saved b', api_key: ''})
		await cards[0].get('input[aria-label="tcy.mcp.name"]').setValue('Newer a draft')
		const result = saved()
		result.revision = 2
		result.connections[0].name = 'Submitted a'
		sdk.tcyAiMcpSettings.mockResolvedValue({data: result})
		pending.resolve({data: result})
		await flushPromises()
		expect(cards[0].get('input[aria-label="tcy.mcp.name"]').element).toHaveProperty('value', 'Newer a draft')
		expect(cards[1].get('input[type="password"]').element).toHaveProperty('value', 'unsaved-b-secret')
		expect(wrapper.emitted('dirty')?.slice(-1)[0]).toEqual([true])
		await cards[0].trigger('submit')
		await flushPromises()
		expect(sdk.tcyAiMcpSaveSettings.mock.calls[1][0].body.revision).toBe(2)
	})

	it('keeps all local drafts after a revision conflict and rebases an explicit refresh', async () => {
		sdk.tcyAiMcpSaveSettings.mockRejectedValue(new Error('revision conflict'))
		const {wrapper} = panel()
		await flushPromises()
		const first = wrapper.findAll('form')[0]
		await first.get('input[aria-label="tcy.mcp.name"]').setValue('Local draft')
		const remote = saved()
		remote.revision = 2
		remote.connections[1].name = 'Other window b'
		sdk.tcyAiMcpSettings.mockResolvedValue({data: remote})
		await first.trigger('submit')
		await flushPromises()
		expect(first.get('[role="alert"]').text()).toBe('revision conflict')
		const refresh = wrapper.findAll('button').find(button => button.text() === 'tcy.mcp.refreshSaved')!
		await refresh.trigger('click')
		await flushPromises()
		expect(first.get('input[aria-label="tcy.mcp.name"]').element).toHaveProperty('value', 'Local draft')
		expect(wrapper.findAll('form')[1].get('input[aria-label="tcy.mcp.name"]').element).toHaveProperty('value', 'Other window b')
	})

	it('rejects a save completion after the authentication session changes', async () => {
		const pending = deferred<{data: MCPSettings}>()
		sdk.tcyAiMcpSaveSettings.mockReturnValue(pending.promise)
		const {wrapper, client} = panel()
		await flushPromises()
		const first = wrapper.findAll('form')[0]
		await first.get('input[aria-label="tcy.mcp.name"]').setValue('Old owner draft')
		await first.trigger('submit')
		await flushPromises()
		removeToken()
		pending.resolve({data: {...saved(), revision: 2}})
		await flushPromises()
		expect(client.getQueryData<MCPSettings>(mcpSettingsKey)?.revision).toBe(1)
		expect(first.get('input[aria-label="tcy.mcp.name"]').element).toHaveProperty('value', 'Old owner draft')
		await first.trigger('submit')
		await flushPromises()
		expect(sdk.tcyAiMcpSaveSettings).toHaveBeenCalledTimes(1)
	})
})

describe('MCP catalog request identity', () => {
	it('retains a tested catalog while editing trust choices, without granting remote read hints', async () => {
		sdk.tcyAiMcpTest.mockResolvedValue({data: testCatalog})
		const {wrapper} = panel()
		await flushPromises()
		expect(sdk.tcyAiMcpTest).not.toHaveBeenCalled()
		const first = wrapper.findAll('form')[0]
		const test = first.findAll('button').find(button => button.text() === 'tcy.mcp.testConnection')!
		await test.trigger('click')
		await flushPromises()
		const trust = first.get('input[aria-label="tcy.mcp.trustTool"]')
		expect(trust.element).toHaveProperty('checked', false)
		await trust.setValue(true)
		expect(first.findAll('.mcp-tool-list li')).toHaveLength(1)
		expect(first.get('textarea').element).toHaveProperty('value', 'list_fixture')
		expect(sdk.tcyAiMcpTest).toHaveBeenCalledTimes(1)
	})

	it('drops a late catalog after the destination or key has changed', async () => {
		const pending = deferred<{data: typeof testCatalog}>()
		sdk.tcyAiMcpTest.mockReturnValue(pending.promise)
		const {wrapper} = panel()
		await flushPromises()
		const first = wrapper.findAll('form')[0]
		await first.findAll('button').find(button => button.text() === 'tcy.mcp.testConnection')!.trigger('click')
		await flushPromises()
		await first.get('input[type="url"]').setValue('https://different.example/mcp')
		pending.resolve({data: testCatalog})
		await flushPromises()
		expect(first.find('.mcp-tool-list').exists()).toBe(false)
		expect(first.get('input[type="password"]').attributes('placeholder')).toBe('tcy.mcp.keyPlaceholder')
	})
})
