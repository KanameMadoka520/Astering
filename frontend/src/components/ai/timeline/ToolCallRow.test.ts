import {describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'
import type {Action, Operation} from '@/client/generated'

vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key, n: String})}))

import ToolCallRow from './ToolCallRow.vue'

const cancelled: Action = {
	tool: 'create_task', success: false,
	result: JSON.stringify({success: false, code: 'STEERING_REPLAN', executed: false}),
}
const rejected: Operation = {tool: 'create_task', status: 'rejected', error_code: 'STEERING_REPLAN'}

function row(props: {action?: Action, operation?: Operation}) {
	return mount(ToolCallRow, {
		props: {label: 'Create task', defaultOpen: true, ...props},
		global: {stubs: {Icon: true, WebSearchEvidence: true}},
	})
}

describe('tool plans superseded by steering', () => {
	it.each([{action: cancelled}, {operation: rejected}])('explains that a superseded plan never executed: %j', props => {
		const wrapper = row(props)
		expect(wrapper.classes()).toContain('is-skipped')
		expect(wrapper.find('.tool-state').text()).toBe('aronaSteer.skippedTool')
		expect(wrapper.find('.tool-note').text()).toBe('aronaSteer.skippedNote')
		expect(wrapper.classes()).not.toContain('is-failed')
		expect(wrapper.classes()).not.toContain('is-rejected')
		wrapper.unmount()
	})

	it('preserves real errors and manual review rejections', () => {
		const failure = row({action: {...cancelled, result: '{"success":false,"code":"PROVIDER_ERROR"}'}})
		expect(failure.classes()).toContain('is-failed')
		failure.unmount()
		const manual = row({operation: {...rejected, error_code: 'USER_REJECTED'}})
		expect(manual.classes()).toContain('is-rejected')
		expect(manual.find('.tool-note').text()).toBe('aronaRun.rejectedNote')
		manual.unmount()
	})
})


describe('external MCP timeline source', () => {
	it('keeps an external tool visibly attributed even when its name matches a native tool', () => {
		const wrapper = row({operation: {
			tool: 'call_mcp_tool',
			arguments: '{"server_id":"server-id","tool_name":"delete_task"}',
			external: {server_id: 'server-id', server_name: 'Named fixture', tool: 'delete_task'},
		}})
		expect(wrapper.find('summary [title="Named fixture · delete_task"]').exists()).toBe(true)
		wrapper.unmount()
	})

	it('shows the call source from persisted action arguments without a settings or catalog request', () => {
		const wrapper = row({action: {
			tool: 'call_mcp_tool',
			arguments: '{"server_id":"server-id","tool_name":"list_fixture"}',
			success: true,
		}})
		expect(wrapper.find('summary [title="server-id · list_fixture"]').exists()).toBe(true)
		wrapper.unmount()
	})
})
