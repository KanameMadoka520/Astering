import {describe, expect, it, vi} from 'vitest'
import {defineComponent, h, type PropType} from 'vue'
import {mount} from '@vue/test-utils'
import type {Action, ModelStep, Operation} from '@/client/generated'
import TurnTimeline from './TurnTimeline.vue'

vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))

function action(round: number | undefined, result = '{}'): Action {
	return {
		round,
		tool: 'create_task',
		arguments: '{"title":"Synthetic task"}',
		result,
		success: true,
	}
}

function setup(steps: ModelStep[], actions: Action[]) {
	const renders = new Map<number | undefined, number>()
	const Step = defineComponent({
		name: 'ObservedTimelineStep',
		props: {
			step: {type: Object as PropType<ModelStep>, required: true},
			actions: {type: Array as PropType<readonly Action[]>, required: true},
			operations: {type: Array as PropType<readonly Operation[]>, required: true},
			rejected: {type: Array as PropType<readonly Operation[]>, required: true},
			live: Boolean,
			streaming: Boolean,
			hideText: Boolean,
			multiRound: Boolean,
		},
		setup(props) {
			return () => {
				const round = props.step.round
				renders.set(round, (renders.get(round) ?? 0) + 1)
				return h('div', {class: 'observed-step'}, `${round}: ${props.actions.length}`)
			}
		},
	})
	const wrapper = mount(TurnTimeline, {
		props: {
			steps,
			actions,
			operations: [],
			running: true,
			streamingIndex: steps.length - 1,
			hideLastText: false,
		},
		global: {
			stubs: {
				TimelineStep: Step,
				CompactionMarker: true,
				SubagentRow: true,
				Icon: true,
			},
		},
	})
	return {
		wrapper,
		renders,
		stepAt: (index: number) => wrapper.findAllComponents(Step)[index],
	}
}

describe('TurnTimeline round isolation', () => {
	it('updates only the affected round when a tool receipt lands in a 40-round, 200-receipt turn', async () => {
		const steps = Array.from({length: 40}, (_, index) => ({round: index + 1}))
		const actions = steps.flatMap(step => Array.from({length: 5}, () => action(step.round)))
		const {wrapper, renders, stepAt} = setup(steps, actions)
		const before = new Map(renders)

		await wrapper.setProps({actions: [...actions, action(40, '{"id":201}')]})

		for (let round = 1; round < 40; round++) {
			expect(renders.get(round), `settled round ${round}`).toBe(before.get(round))
		}
		expect(renders.get(40)).toBe(before.get(40)! + 1)
		expect(stepAt(0).props('actions')).toEqual(actions.slice(0, 5))
		expect(stepAt(39).props('actions')).toHaveLength(6)
		wrapper.unmount()
	})

	it('updates an edited earlier receipt without waking an unchanged live round, and clears removed receipts', async () => {
		const steps = [{round: 1}, {round: 2}]
		const actions = [action(1), action(2)]
		const {wrapper, renders, stepAt} = setup(steps, actions)
		const liveActions = stepAt(1).props('actions')
		const changed = {...actions[0], result: '{"updated":true}'}
		const liveBefore = renders.get(2)

		await wrapper.setProps({actions: [changed, actions[1]]})

		expect(stepAt(0).props('actions')).toEqual([changed])
		expect(renders.get(2)).toBe(liveBefore)
		expect(stepAt(1).props('actions')).toBe(liveActions)

		await wrapper.setProps({actions: [actions[1]]})
		expect(stepAt(0).props('actions')).toEqual([])
		expect(renders.get(2)).toBe(liveBefore)
		wrapper.unmount()
	})

	it('keeps settled rounds still while the live text streams', async () => {
		const steps = [{round: 1, text: 'Earlier reply'}, {round: 2, text: ''}]
		const {wrapper, renders} = setup(steps, [action(1), action(2)])
		const before = renders.get(1)
		for (let frame = 1; frame <= 10; frame++) {
			await wrapper.setProps({steps: [steps[0], {...steps[1], text: 'word '.repeat(frame)}]})
		}
		expect(renders.get(1)).toBe(before)
		expect(renders.get(2)).toBe(11)
		wrapper.unmount()
	})

	it('keeps round-less legacy receipts separate and does not deduplicate repeated tools or receipt IDs', async () => {
		const legacy = {...action(undefined), result_ref: 'same-id'}
		const current = {...action(1), result_ref: 'same-id'}
		const actions = [legacy, current, legacy, current, action(99)]
		const {wrapper, stepAt} = setup([{}, {round: 1}], actions)

		expect(stepAt(0).props('actions')).toEqual([legacy, legacy])
		expect(stepAt(1).props('actions')).toEqual([current, current])
		await wrapper.setProps({actions: [current]})
		expect(stepAt(0).props('actions')).toEqual([])
		expect(stepAt(1).props('actions')).toEqual([current])
		wrapper.unmount()
	})

	it('keeps manual review decisions attached to their own call and excludes already settled cancellation receipts', async () => {
		const toolCall = (id: string) => ({
			id,
			function: {name: 'create_task', arguments: '{"title":"Synthetic task"}'},
		})
		const steps = [{round: 1, tool_calls: [toolCall('a')]}, {round: 2, tool_calls: [toolCall('b')]}]
		const cancelled: Operation = {
			id: 'op-cancelled',
			tool: 'create_task',
			arguments: '{"title":"Synthetic task"}',
			status: 'rejected',
			error_code: 'STEERING_REPLAN',
		}
		const rejected = {...cancelled, id: 'op-rejected', error_code: 'USER_REJECTED'}
		const cancelledAction = {
			...action(1, '{"success":false,"code":"STEERING_REPLAN","executed":false}'),
			result_ref: cancelled.id,
			success: false,
		}
		const {wrapper, stepAt} = setup(steps, [cancelledAction])
		await wrapper.setProps({rejected: [cancelled, rejected]})
		expect(stepAt(0).props('rejected')).toEqual([])
		expect(stepAt(1).props('rejected')).toEqual([rejected])
		expect(stepAt(0).props('actions')).toEqual([cancelledAction])
		expect(stepAt(1).props('actions')).toEqual([])
		wrapper.unmount()
	})
})
