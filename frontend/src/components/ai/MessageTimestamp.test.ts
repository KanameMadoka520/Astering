import {afterEach, describe, expect, it, vi} from 'vitest'
import {mount, type VueWrapper} from '@vue/test-utils'
import {nextTick} from 'vue'

import MessageTimestamp from './MessageTimestamp.vue'

const originalTimeZone = process.env.TZ
const mounted: VueWrapper[] = []

function mountTimestamp(props: {value?: string | null, label?: string, hideLabel?: boolean}) {
	const wrapper = mount(MessageTimestamp, {
		props: {
			label: 'Replied',
			...props,
		},
	})
	mounted.push(wrapper)
	return wrapper
}

afterEach(() => {
	mounted.splice(0).forEach(wrapper => wrapper.unmount())
	vi.useRealTimers()
	process.env.TZ = originalTimeZone
})

describe('MessageTimestamp', () => {
	it('renders a machine readable GMT+8 time with the zone visible', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
		const time = mountTimestamp({value: '2026-11-01T06:03:27Z'}).find('time')

		// The server's instant, so end-to-end checks can match it.
		expect(time.attributes('datetime')).toBe('2026-11-01T06:03:27.000Z')
		expect(time.attributes('title')).toBe('Replied 2026-11-01 14:03:27 GMT+8')
		expect(time.text()).toBe('Replied 14:03 GMT+8')
		expect(time.find('.message-time-label').text()).toBe('Replied')
		expect(time.find('.is-sr-only').exists()).toBe(false)
	})

	it.each([
		['2026-11-01T06:03:27.123456789Z', '2026-11-01T06:03:27.123Z'],
		['2026-11-01T14:03:27.5+08:00', '2026-11-01T06:03:27.500Z'],
	])('keeps the instant of %s as a valid HTML datetime', (value, datetime) => {
		const time = mountTimestamp({value}).find('time')
		expect(time.attributes('datetime')).toBe(datetime)
		expect(Date.parse(time.attributes('datetime')!)).toBe(Math.floor(Date.parse(value)))
	})

	it('keeps a hidden label for screen readers', () => {
		const time = mountTimestamp({
			value: '2026-11-01T06:03:27Z',
			label: '回复于',
			hideLabel: true,
		}).find('time')

		expect(time.find('.is-sr-only').text()).toBe('回复于')
		expect(time.find('.message-time-label').exists()).toBe(false)
		expect(time.text()).toContain('回复于')
		expect(time.text()).toContain('GMT+8')
		expect(time.attributes('title')).toBe('回复于 2026-11-01 14:03:27 GMT+8')
	})

	it.each([
		undefined,
		null,
		'',
		'garbage',
		'0001-01-01T00:00:00Z',
	])('renders nothing for %j', value => {
		const wrapper = mountTimestamp({value})
		expect(wrapper.find('time').exists()).toBe(false)
		expect(wrapper.text()).toBe('')
		expect(wrapper.html()).not.toContain('Invalid Date')
	})

	it('appears once the value becomes a real instant', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
		const wrapper = mountTimestamp({value: ''})
		expect(wrapper.find('time').exists()).toBe(false)

		await wrapper.setProps({value: '2026-11-01T06:03:27Z'})
		expect(wrapper.find('time').text()).toBe('Replied 14:03 GMT+8')
	})

	it('adds the date once GMT+8 midnight passes', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T15:59:00Z'))
		const time = mountTimestamp({value: '2026-11-01T15:00:00Z'}).find('time')
		expect(time.text()).toBe('Replied 23:00 GMT+8')

		vi.advanceTimersByTime(2 * 60_000)
		await nextTick()
		expect(time.text()).toBe('Replied 11-01 23:00 GMT+8')
		expect(vi.getTimerCount()).toBe(1)
	})

	it('adds the year once the GMT+8 year changes', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-12-31T15:59:00Z'))
		const time = mountTimestamp({value: '2026-12-31T15:00:00Z'}).find('time')
		expect(time.text()).toBe('Replied 23:00 GMT+8')

		vi.advanceTimersByTime(2 * 60_000)
		await nextTick()
		expect(time.text()).toBe('Replied 2026-12-31 23:00 GMT+8')
	})

	it.each([
		['a visible tab', () => document.dispatchEvent(new Event('visibilitychange'))],
		['a page restored from the back-forward cache', () => window.dispatchEvent(new Event('pageshow'))],
		['a focused window', () => window.dispatchEvent(new Event('focus'))],
	])('reads the day again on the return to %s after sleep', async (_, returnToPage) => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T15:00:00Z'))
		const time = mountTimestamp({value: '2026-11-01T14:00:00Z'}).find('time')
		expect(time.text()).toBe('Replied 22:00 GMT+8')

		// The clock jumps a day while no timer fires, as after a suspended laptop wakes up.
		vi.setSystemTime(new Date('2026-11-02T15:00:00Z'))
		returnToPage()
		await nextTick()
		expect(time.text()).toBe('Replied 11-01 22:00 GMT+8')
		expect(vi.getTimerCount()).toBe(1)
	})

	it('listens for the page\'s return once for all timestamps, and stops once none is shown', () => {
		const added = [vi.spyOn(document, 'addEventListener'), vi.spyOn(window, 'addEventListener')]
		const removed = [vi.spyOn(document, 'removeEventListener'), vi.spyOn(window, 'removeEventListener')]
		const calls = (spies: typeof added) => spies.flatMap(spy => spy.mock.calls)
			.filter(([type]) => ['visibilitychange', 'pageshow', 'focus'].includes(type))
		const first = mountTimestamp({value: '2026-11-01T14:00:00Z'})
		const second = mountTimestamp({value: '2026-11-01T15:00:00Z'})
		const listeners = calls(added)
		expect(listeners.map(([type]) => type).sort()).toEqual(['focus', 'pageshow', 'visibilitychange'])
		expect(listeners.every(([, listener]) => typeof listener === 'function')).toBe(true)

		first.unmount()
		expect(calls(removed)).toEqual([])
		second.unmount()
		mounted.splice(0)
		expect(calls(removed)).toEqual(listeners)
		for (const spy of [...added, ...removed]) spy.mockRestore()
	})

	it('resyncs the shared day when the first timestamp mounts', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2027-03-05T04:00:00Z'))
		expect(mountTimestamp({value: '2027-03-05T03:00:00Z'}).find('time').text()).toBe('Replied 11:00 GMT+8')
	})

	it('shares one midnight timer between all timestamps', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
		expect(vi.getTimerCount()).toBe(0)

		const first = mountTimestamp({value: '2026-11-01T06:03:27Z'})
		const second = mountTimestamp({value: '2026-10-31T06:03:27Z'})
		expect(vi.getTimerCount()).toBe(1)

		// Within the same GMT+8 day nothing ticks, so nothing re-renders.
		vi.advanceTimersByTime(3600_000)
		await nextTick()
		expect(vi.getTimerCount()).toBe(1)
		expect(first.find('time').text()).toBe('Replied 14:03 GMT+8')
		expect(second.find('time').text()).toBe('Replied 10-31 14:03 GMT+8')

		first.unmount()
		expect(vi.getTimerCount()).toBe(1)
		second.unmount()
		expect(vi.getTimerCount()).toBe(0)
		mounted.splice(0)
	})

	it('ignores the browser time zone', () => {
		process.env.TZ = 'America/New_York'
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-01T08:00:00Z'))
		// Proves the runtime switched zones before checking that the component did not follow it.
		expect(new Date('2026-11-01T06:03:27Z').getHours()).toBe(1)

		expect(mountTimestamp({value: '2026-11-01T06:03:27Z'}).find('time').text()).toBe('Replied 14:03 GMT+8')
	})

	it('uses the GMT+8 day as today even when the browser is still on the previous day', () => {
		process.env.TZ = 'America/New_York'
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-31T20:00:00Z'))
		expect(new Date().getDate()).toBe(31)

		const time = mountTimestamp({value: '2026-10-31T17:03:27Z'}).find('time')
		expect(time.text()).toBe('Replied 01:03 GMT+8')
		expect(time.attributes('datetime')).toBe('2026-10-31T17:03:27.000Z')
	})
})
