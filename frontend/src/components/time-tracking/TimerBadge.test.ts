import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'

const tracking = vi.hoisted(() => ({active: undefined as undefined | import('vue').Ref<{start_time: string} | null>}))
vi.mock('@/composables/useTimeTracking', async () => {
	const {computed, ref} = await import('vue')
	tracking.active = ref(null)
	return {useTimeTracking: () => ({
		activeTimer: tracking.active,
		hasActiveTimer: computed(() => tracking.active!.value !== null),
	})}
})
vi.mock('@/client/queries/timeEntries', () => ({useStopTimerMutation: () => ({mutateAsync: vi.fn()})}))

import TimerBadge from './TimerBadge.vue'

enableAutoUnmount(afterEach)

describe('TimerBadge', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-03-01T09:00:00Z'))
		tracking.active!.value = null
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('ticks only while a timer runs', async () => {
		const intervals = vi.spyOn(globalThis, 'setInterval')
		const cleared = vi.spyOn(globalThis, 'clearInterval')
		const wrapper = mount(TimerBadge, {
			global: {
				stubs: {
					RouterLink: {template: '<a><slot /></a>'},
					Icon: true,
				},
				directives: {
					tooltip: {},
					cy: {},
				},
				mocks: {$t: (key: string) => key},
			},
		})
		expect(intervals).not.toHaveBeenCalled()

		tracking.active!.value = {start_time: '2026-03-01T08:59:00Z'}
		await nextTick()
		expect(wrapper.find('.timer-badge__elapsed').text()).toBe('01:00')
		await vi.advanceTimersByTimeAsync(5000)
		expect(wrapper.find('.timer-badge__elapsed').text()).toBe('01:05')
		expect(intervals).toHaveBeenCalledTimes(1)

		tracking.active!.value = null
		await nextTick()
		expect(cleared).toHaveBeenCalledWith(intervals.mock.results[0]?.value)
	})
})
