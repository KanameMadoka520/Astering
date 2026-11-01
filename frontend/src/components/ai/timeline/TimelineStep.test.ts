import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, nextTick, ref} from 'vue'
import {mount} from '@vue/test-utils'

vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string, values?: {value?: string}) => values?.value ?? key,
		n: (value: number) => value.toFixed(0),
	}),
}))

import {provideAronaPresenting} from '@/composables/useAronaPresentation'
import TimelineStep from './TimelineStep.vue'

const T0 = Date.parse('2026-01-01T00:00:00Z')

function mountStep(presenting = ref(true)) {
	const Host = defineComponent({
		setup() {
			provideAronaPresenting(presenting)
			return () => h(TimelineStep, {
				step: {round: 1, started: new Date(T0 - 1000).toISOString()},
				actions: [],
				operations: [],
				live: true,
				streaming: true,
				hideText: false,
				multiRound: true,
			})
		},
	})
	const wrapper = mount(Host, {global: {stubs: {Icon: true, CacheUsage: true}}})
	return {
		header: () => wrapper.find('.step-meta summary').text(),
		presenting,
	}
}

describe('TimelineStep clock', () => {
	beforeEach(() => {
		vi.useFakeTimers({now: T0})
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('ticks while the streaming round is on screen', async () => {
		const {header} = mountStep()
		expect(header()).toMatch(/· 1$/)

		vi.advanceTimersByTime(2000)
		await nextTick()

		expect(header()).toMatch(/· 3$/)
	})

	it('stands still while hidden and shows the real elapsed time at once when shown', async () => {
		const {header, presenting} = mountStep(ref(false))
		expect(header()).toMatch(/· 1$/)

		vi.advanceTimersByTime(3000)
		await nextTick()
		expect(header()).toMatch(/· 1$/)

		presenting.value = true
		await nextTick()
		expect(header()).toMatch(/· 4$/)
	})
})

describe('TimelineStep steering cancellations', () => {
	it('summarizes superseded plans separately from failed tools or user decisions', () => {
		const wrapper = mount(TimelineStep, {
			props: {
				step: {round: 1},
				operations: [],
				live: false,
				streaming: false,
				hideText: false,
				multiRound: false,
				actions: Array.from({length: 4}, () => ({
					round: 1, tool: 'create_task', success: false,
					result: '{"success":false,"code":"STEERING_REPLAN","executed":false}',
				})),
			},
			global: {stubs: {Icon: true, CacheUsage: true, ToolCallRow: true}},
		})
		expect(wrapper.text()).toContain('aronaSteer.skippedCount')
		expect(wrapper.text()).not.toContain('aronaRun.failedCount')
		expect(wrapper.text()).not.toContain('aronaRun.rejectedCount')
		wrapper.unmount()
	})
})
