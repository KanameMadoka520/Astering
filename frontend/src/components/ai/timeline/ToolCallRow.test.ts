import {describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'
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


describe('manual task-order receipts', () => {
	it('shows the manual-order entry while raw tool details stay collapsed and preserves current filters on demand', async () => {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{
				name: 'project.view',
				path: '/projects/:projectId/:viewId',
				component: {template: '<div />'},
			}],
		})
		await router.push('/projects/1/4?sort=title:asc&s=Needle&page=2&filter=done=false')
		const argumentsValue = {
			project_id: 1,
			view_id: 4,
			bucket_id: 0,
			task_ids: [3],
		}
		const result = {
			...argumentsValue,
			view_kind: 'list',
			changed_positions: [{
				task_id: 3,
				project_view_id: 4,
				position: 50,
			}],
			order_version: 'a'.repeat(64),
			position_recalculated: false,
			manual_order_saved: true,
			verified: true,
		}
		const wrapper = mount(ToolCallRow, {
			props: {
				label: 'Order',
				defaultOpen: false,
				action: {
					tool: 'reorder_view_tasks',
					success: true,
					arguments: JSON.stringify(argumentsValue),
					result: JSON.stringify(result),
				},
			},
			global: {
				plugins: [router],
				stubs: {Icon: true},
			},
		})
		expect(wrapper.find('details').attributes('open')).toBeUndefined()
		expect(wrapper.find('.tool-body').exists()).toBe(false)
		const link = wrapper.get('.task-order-view-link')
		expect(link.text()).toBe('agent.taskOrder.viewManual')
		expect(router.currentRoute.value.query.page).toBe('2')
		await link.trigger('click')
		await vi.waitFor(() => expect(router.currentRoute.value.query.sort).toBe('position:asc'))
		expect(router.currentRoute.value.query).toMatchObject({s: 'Needle', filter: 'done=false'})
		expect(router.currentRoute.value.query.page).toBeUndefined()
		wrapper.unmount()
	})
})
