import {describe, expect, it} from 'vitest'
import {defineComponent, h, nextTick, reactive, shallowRef, type PropType} from 'vue'
import {mount} from '@vue/test-utils'
import type {ChatTurn} from '@/client/generated'
import ChatThread from './ChatThread.vue'

function turn(id: string, text = ''): ChatTurn {
	return {
		id,
		request_id: `r-${id}`,
		prompt: `Prompt ${id}`,
		status: 'running',
		result: {reply: text},
	}
}

// Under jsdom and happy-dom TransitionGroup does not measure its children, so counting the renders of its slot is the
// observable proxy for the per-frame getBoundingClientRect/getComputedStyle work it does in a browser.
function setup() {
	let groupRenders = 0
	const GroupStub = defineComponent({
		setup(_, {slots}) {
			return () => {
				groupRenders++
				return h('div', {class: 'group'}, slots.default?.())
			}
		},
	})
	const cardTurns = new Map<string, ChatTurn>()
	const CardStub = defineComponent({
		name: 'ChatTurnCardStub',
		props: {
			turn: {type: Object as PropType<ChatTurn>, required: true},
			sending: Boolean,
		},
		emits: ['review', 'fork'],
		setup(props) {
			return () => {
				cardTurns.set(props.turn.id!, props.turn)
				return h('article', {class: ['card', {sending: props.sending}]}, props.turn.result?.reply)
			}
		},
	})
	const turns = shallowRef<ChatTurn[]>([turn('1', 'Done'), turn('2', '')])
	const wrapper = mount(ChatThread, {
		props: {
			readTurns: () => turns.value,
			busy: false,
			reveal: true,
		},
		global: {
			stubs: {
				// Test utils stubs transition groups under this name by default.
				'transition-group': GroupStub,
				ChatTurnCard: CardStub,
			},
		},
	})
	return {
		wrapper,
		turns,
		cardTurns,
		CardStub,
		groupRenders: () => groupRenders,
	}
}

describe('ChatThread', () => {
	it('does not re-render the transition group while the running turn streams', async () => {
		const {wrapper, turns, cardTurns, groupRenders} = setup()
		const before = groupRenders()
		expect(before).toBeGreaterThan(0)
		const finished = turns.value[0]

		for (let frame = 1; frame <= 10; frame++) {
			turns.value = [finished, turn('2', 'word '.repeat(frame))]
			await nextTick()
		}

		expect(groupRenders()).toBe(before)
		expect(cardTurns.get('2')).toBe(turns.value[1])
		expect(wrapper.findAll('.card').at(-1)?.text()).toBe('word '.repeat(10).trim())
	})

	it('renders the group once when a turn is appended', async () => {
		const {wrapper, turns, groupRenders} = setup()
		const before = groupRenders()

		turns.value = [...turns.value, turn('3', 'New')]
		await nextTick()

		expect(groupRenders()).toBe(before + 1)
		expect(wrapper.findAll('.card')).toHaveLength(3)
	})

	it('marks only the pending turn as sending and passes review and fork up', async () => {
		const {wrapper, turns, CardStub} = setup()
		// Like the assistant's pending message: a reactive object, the same one in the turn list and the prop.
		const pending = reactive(turn('3', 'Sending'))
		turns.value = [...turns.value, pending]
		await wrapper.setProps({pendingTurn: pending})

		expect(wrapper.findAll('.card').map(card => card.classes('sending'))).toEqual([false, false, true])

		const cards = wrapper.findAllComponents(CardStub)
		cards[1].vm.$emit('fork', '2')
		cards[0].vm.$emit('review', {decision: 'approve'})
		expect(wrapper.emitted('fork')).toEqual([['2']])
		expect(wrapper.emitted('review')).toEqual([[{decision: 'approve'}]])
	})
})
