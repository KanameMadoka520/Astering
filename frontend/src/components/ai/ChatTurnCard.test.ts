import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, shallowRef, type PropType} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import type {ChatTurn} from '@/client/generated'
import type {LocalSteer} from '@/helpers/turnSteering'
import {provideSteeringOutbox} from './steeringOutbox'
import ChatTurnCard from './ChatTurnCard.vue'

vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string, values?: object) => values ? `${key} ${JSON.stringify(values)}` : key,
	}),
}))

// Every timestamp shares one day: unmounted cards let the next test's clock set it afresh.
enableAutoUnmount(afterEach)
const originalTimeZone = process.env.TZ
afterEach(() => {
	vi.useRealTimers()
	process.env.TZ = originalTimeZone
})

// The card inside an assistant view, which provides the instructions this tab is still sending.
function mountCard(turn: ChatTurn, outbox = shallowRef<readonly LocalSteer[]>([])) {
	const Host = defineComponent({
		props: {turn: {type: Object as PropType<ChatTurn>, required: true}},
		setup(props) {
			provideSteeringOutbox(outbox)
			return () => h(ChatTurnCard, {
				turn: props.turn,
				busy: false,
				conversationId: 'c1',
			})
		},
	})
	return mount(Host, {
		props: {turn},
		global: {
			stubs: {
				AronaAvatar: true,
				AgentReviewCard: true,
				ChatAttachmentCard: true,
				MarkdownBlock: true,
				OutputSpeed: true,
				RunStatus: true,
				TurnTimeline: true,
				WebSearchEvidence: true,
				BaseButton: true,
				XButton: true,
				Icon: true,
			},
		},
	})
}

function turn(fields: Partial<ChatTurn> = {}): ChatTurn {
	return {
		id: 't1',
		request_id: 'r1',
		prompt: 'Plan my week',
		status: 'completed',
		started: '2026-10-31T16:20:00Z',
		finished: '2026-10-31T16:30:05Z',
		result: {
			reply: 'Done',
			steps: [{text: 'Looking at your tasks'}],
		},
		...fields,
	}
}

// Browser in Los Angeles, where it is still Nov 1; GMT+8 is already at Nov 2 10:00.
function elsewhereOnNovemberSecond() {
	process.env.TZ = 'America/Los_Angeles'
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-11-02T02:00:00Z'))
}

describe('ChatTurnCard times', () => {
	it('shows when a completed reply finished, in GMT+8 whatever the browser zone, with the day', () => {
		elsewhereOnNovemberSecond()
		// Proves the zone switch took effect: in Los Angeles the reply finished on Oct 31.
		expect(new Date('2026-10-31T16:30:05Z').getDate()).toBe(31)
		const wrapper = mountCard(turn())

		const replied = wrapper.find('.assistant-identity time')
		expect(replied.text()).toBe('aronaTime.replied 11-01 00:30 GMT+8')
		expect(replied.attributes('datetime')).toBe('2026-10-31T16:30:05.000Z')
		expect(replied.attributes('title')).toBe('aronaTime.replied 2026-11-01 00:30:05 GMT+8')

		const sent = wrapper.find('.user-meta time')
		expect(sent.text()).toBe('aronaTime.sent 11-01 00:20 GMT+8')
		expect(sent.find('.is-sr-only').text()).toBe('aronaTime.sent')
	})

	it('drops the date for a reply of today, as GMT+8 counts it', () => {
		process.env.TZ = 'America/Los_Angeles'
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-31T23:00:00Z'))
		expect(mountCard(turn()).find('.assistant-identity time').text()).toBe('aronaTime.replied 00:30 GMT+8')
	})

	it('gives a running turn no reply time, even with a start and a stale finish', () => {
		elsewhereOnNovemberSecond()
		const wrapper = mountCard(turn({status: 'running'}))
		expect(wrapper.find('.assistant-identity time').exists()).toBe(false)
		expect(wrapper.find('.user-meta time').exists()).toBe(true)
	})

	it('gives a message still being sent no time at all', () => {
		elsewhereOnNovemberSecond()
		const wrapper = mountCard(turn({
			status: 'running',
			started: undefined,
			finished: undefined,
		}))
		expect(wrapper.findAll('time')).toHaveLength(0)
	})

	it.each<[ChatTurn['status'], string]>([
		['failed', 'aronaTime.failed'],
		['stopped', 'aronaTime.stopped'],
		['interrupted', 'aronaTime.interrupted'],
		['awaiting_approval', 'aronaTime.paused'],
		['awaiting_input', 'aronaTime.paused'],
		['paused', 'aronaTime.paused'],
	])('names the end of a %s turn as %s', (status, label) => {
		elsewhereOnNovemberSecond()
		const time = mountCard(turn({status})).find('.assistant-identity time')
		expect(time.text()).toBe(`${label} 11-01 00:30 GMT+8`)
	})

	it.each([
		['missing', undefined],
		['empty', ''],
		['unparseable', 'yesterday'],
		['Go zero time', '0001-01-01T00:00:00Z'],
	])('shows no time for a %s timestamp instead of inventing one', (_name, value) => {
		elsewhereOnNovemberSecond()
		const wrapper = mountCard(turn({
			started: value,
			finished: value,
		}))
		expect(wrapper.findAll('time')).toHaveLength(0)
		expect(wrapper.text()).not.toContain('Invalid Date')
		expect(wrapper.text()).not.toContain('NaN')
	})
})

describe('ChatTurnCard instructions added while running', () => {
	const steering: ChatTurn['steering'] = [
		{
			id: 's2',
			request_id: 'r-b',
			message: 'Skip Friday',
			created: '2026-11-01T06:10:00Z',
			applied_at: '2026-11-01T06:11:30Z',
			status: 'applied',
		},
		// Accepted later although its clock reads earlier: the server's order stands.
		{
			id: 's1',
			request_id: 'r-a',
			message: 'Also check due dates',
			created: '2026-11-01T06:05:00Z',
			status: 'pending',
		},
	]
	const rows = (wrapper: ReturnType<typeof mountCard>) => wrapper.findAll('.turn-steering li')

	it('lists them below the unchanged request, in the server\'s order, with their status and times', () => {
		elsewhereOnNovemberSecond()
		const wrapper = mountCard(turn({status: 'running', steering}))

		expect(wrapper.find('.user-message p').text()).toBe('Plan my week')
		// The run's interim rounds still render: instructions never replace the timeline.
		expect(wrapper.findComponent({name: 'TurnTimeline'}).props('steps')).toHaveLength(1)
		expect(rows(wrapper).map(row => [row.attributes('data-steering-id'), row.attributes('data-steering-status')]))
			.toEqual([['s2', 'applied'], ['s1', 'pending']])

		const [applied, pending] = rows(wrapper)
		expect(applied.find('.steer-bubble').text()).toBe('aronaSteer.badgeSkip Friday')
		expect(applied.find('.steer-status').text()).toBe('aronaSteer.statusApplied aronaTime.applied 11-01 14:11 GMT+8')
		expect(applied.find('time').text()).toBe('aronaTime.added 11-01 14:10 GMT+8')
		expect(pending.find('.steer-status').text()).toBe('aronaSteer.statusPending')
		expect(pending.find('time').attributes('datetime')).toBe('2026-11-01T06:05:00.000Z')
	})

	it('is a read-only history', () => {
		const list = mountCard(turn({steering})).find('.turn-steering')
		// Also catches stubbed XButton/BaseButton controls, which render as *-button-stub tags.
		expect(list.html()).not.toMatch(/button|<input|<textarea|<select|contenteditable/i)
	})

	it('says a pending instruction of an ended run was not yet applied, keeping the server status', () => {
		const [, pending] = rows(mountCard(turn({status: 'stopped', steering})))
		expect(pending.find('.steer-status').text()).toBe('aronaSteer.statusMissed')
		expect(pending.attributes('data-steering-status')).toBe('pending')
	})

	it('shows this tab\'s unconfirmed instruction once, and hands it over to the server\'s row', async () => {
		const outbox = shallowRef<readonly LocalSteer[]>([
			{
				chat: 'c1',
				turn: 't1',
				request_id: 'r-c',
				message: 'Then summarize',
				state: 'sending',
			},
			{
				chat: 'c1',
				turn: 'another-turn',
				request_id: 'r-x',
				message: 'Not for this turn',
				state: 'sending',
			},
			{
				chat: 'c2',
				turn: 't1',
				request_id: 'r-y',
				message: 'Not for this conversation',
				state: 'sending',
			},
		])
		const wrapper = mountCard(turn({status: 'running', steering}), outbox)
		const local = rows(wrapper).at(-1)!
		expect(rows(wrapper)).toHaveLength(3)
		expect(local.find('.steer-bubble').text()).toBe('aronaSteer.badgeThen summarize')
		expect(local.find('.steer-status').text()).toBe('aronaSteer.statusSending')
		expect(local.attributes('data-steering-id')).toBeUndefined()
		expect(local.attributes('data-steering-status')).toBeUndefined()

		await wrapper.setProps({
			turn: turn({
				status: 'running',
				steering: [
					...steering!,
					{
						id: 's3',
						request_id: 'r-c',
						message: 'Then summarize',
						created: '2026-11-01T06:12:00Z',
						status: 'pending',
					},
				],
			}),
		})
		expect(rows(wrapper).map(row => row.attributes('data-steering-id'))).toEqual(['s2', 's1', 's3'])
		expect(wrapper.text().match(/Then summarize/g)).toHaveLength(1)
	})

	it('renders nothing for a turn without instructions', () => {
		expect(mountCard(turn()).find('.turn-steering').exists()).toBe(false)
	})
})
