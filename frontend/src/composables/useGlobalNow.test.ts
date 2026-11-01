import {afterEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'

import {GLOBAL_NOW_INTERVAL, useGlobalNow} from './useGlobalNow'

function setVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, 'visibilityState', {
		value: state,
		configurable: true,
	})
	document.dispatchEvent(new Event('visibilitychange'))
}

describe('useGlobalNow', () => {
	afterEach(() => {
		setVisibility('visible')
		vi.useRealTimers()
	})

	it('stops ticking in a hidden tab and shows the real time once visible again', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-03-01T09:00:00Z'))
		const {now} = useGlobalNow()
		const changes = vi.fn()
		const {watch} = await import('vue')
		watch(now, changes)

		setVisibility('hidden')
		await nextTick()
		changes.mockClear()
		await vi.advanceTimersByTimeAsync(5 * GLOBAL_NOW_INTERVAL)
		expect(changes).not.toHaveBeenCalled()

		setVisibility('visible')
		await nextTick()
		expect(now.value.toISOString()).toBe('2026-03-01T09:05:00.000Z')

		await vi.advanceTimersByTimeAsync(GLOBAL_NOW_INTERVAL)
		expect(now.value.toISOString()).toBe('2026-03-01T09:06:00.000Z')
	})
})
