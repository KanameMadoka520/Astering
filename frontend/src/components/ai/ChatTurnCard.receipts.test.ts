import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'
import type {Action, ChatTurn, ModelStep} from '@/client/generated'
import {useAronaDisplayPreferences} from '@/composables/useAronaDisplayPreferences'
import ChatTurnCard from './ChatTurnCard.vue'

vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string) => key,
		n: String,
	}),
}))

enableAutoUnmount(afterEach)
beforeEach(() => useAronaDisplayPreferences().reset())
afterEach(() => useAronaDisplayPreferences().reset())

const success: Action = {
	round: 1,
	tool: 'create_task',
	arguments: '{"title":"Synthetic task"}',
	result: '{"id":3}',
	success: true,
}
const failed: Action = {
	round: 1,
	tool: 'update_task',
	arguments: '{"id":3,"title":"Changed task"}',
	result: '{"success":false,"code":"FIXTURE_ERROR"}',
	success: false,
}

async function card(actions: Action[], steps: ModelStep[] = []) {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{
			name: 'project.view',
			path: '/projects/:projectId/:viewId',
			component: {template: '<div />'},
		}],
	})
	await router.push('/projects/1/4?sort=title:asc&s=Task&page=2')
	const turn: ChatTurn = {
		id: 'receipts-turn',
		prompt: 'Synthetic request',
		status: 'completed',
		result: {
			reply: 'Saved.',
			actions,
			steps,
		},
	}
	const wrapper = mount(ChatTurnCard, {
		props: {
			turn,
			busy: false,
		},
		global: {
			plugins: [router],
			stubs: {
				AronaAvatar: true,
				AgentReviewCard: true,
				ChatAttachmentCard: true,
				MarkdownBlock: true,
				MessageTimestamp: true,
				TurnSteering: true,
				OutputSpeed: true,
				RunStatus: true,
				WebSearchEvidence: true,
				BaseButton: true,
				XButton: true,
				Icon: true,
			},
		},
	})
	return {wrapper, router}
}

describe('ChatTurnCard receipts without model steps', () => {
	it('shows actual succeeded and failed tool summaries with collapsed details without inventing a model round', async () => {
		const {wrapper} = await card([success, failed])
		const rows = wrapper.findAll('.tool-row')
		expect(rows).toHaveLength(2)
		expect(rows[0].classes()).toContain('is-succeeded')
		expect(rows[1].classes()).toContain('is-failed')
		expect(rows[0].get('summary').text()).toContain('tcymc.text.create_task')
		expect(rows[1].get('summary').text()).toContain('tcymc.text.update_task')
		expect(wrapper.find('.tool-body').exists()).toBe(false)
		expect(wrapper.find('.timeline-step').exists()).toBe(false)
		expect(wrapper.find('.step-meta').exists()).toBe(false)
	})

	it('uses the normal real timeline when a saved step exists, displaying each receipt once', async () => {
		const {wrapper} = await card([success, failed], [{round: 1}])
		expect(wrapper.findAll('.timeline-step')).toHaveLength(1)
		expect(wrapper.findAll('.tool-row')).toHaveLength(2)
		expect(wrapper.find('.action-receipts').exists()).toBe(false)
	})

	it('follows the existing display preference while retaining a visible summary', async () => {
		const {wrapper} = await card([success])
		useAronaDisplayPreferences().update({expandToolDetails: true})
		await nextTick()
		expect(wrapper.get('.tool-disclosure').attributes('open')).toBeDefined()
		expect(JSON.parse(wrapper.get('.tool-body pre').text())).toEqual({title: 'Synthetic task'})
		useAronaDisplayPreferences().update({expandToolDetails: false})
		await nextTick()
		expect(wrapper.get('.tool-disclosure').attributes('open')).toBeUndefined()
		expect(wrapper.get('summary').isVisible()).toBe(true)
		expect(wrapper.find('.tool-body').exists()).toBe(false)
	})

	it('keeps the validated manual-order receipt usable without model steps or expanded raw parameters', async () => {
		const args = {
			project_id: 1,
			view_id: 4,
			bucket_id: 8,
			task_ids: [3],
		}
		const result = {
			...args,
			view_kind: 'kanban',
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
		const {wrapper, router} = await card([{
			...success,
			tool: 'reorder_view_tasks',
			arguments: JSON.stringify(args),
			result: JSON.stringify(result),
		}])
		const link = wrapper.get('.task-order-view-link')
		expect(link.isVisible()).toBe(true)
		expect(wrapper.find('.tool-body').exists()).toBe(false)
		expect(router.currentRoute.value.query.sort).toBe('title:asc')
		await link.trigger('click')
		await vi.waitFor(() => expect(router.currentRoute.value.query.sort).toBe('position:asc'))
		expect(router.currentRoute.value.query.s).toBe('Task')
		expect(router.currentRoute.value.query.page).toBeUndefined()
	})
})
