import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchAllPages} from './fetchAllPages'
import {retryRead} from '@/client/queryClient'

afterEach(() => vi.useRealTimers())

describe('fetchAllPages', () => {
	it('requests each page until total_pages and concatenates items', async () => {
		const fetchPage = vi.fn()
			.mockResolvedValueOnce({items: [1], total_pages: 3})
			.mockResolvedValueOnce({items: null, total_pages: 3})
			.mockResolvedValueOnce({items: [3], total_pages: 3})
		expect(await fetchAllPages(fetchPage)).toEqual([1, 3])
		expect(fetchPage.mock.calls).toEqual([[1], [2], [3]])
	})

	it('cancels during the retry delay without issuing another request or leaking its timer', async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const read = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
		const pending = fetchAllPages(read, {signal: controller.signal, retryPage: retryRead})
		const result = expect(pending).rejects.toMatchObject({name: 'AbortError'})
		await Promise.resolve()
		controller.abort()
		await result
		await vi.advanceTimersByTimeAsync(2000)
		expect(read).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('retains the default no-inner-retry contract for existing callers', async () => {
		const read = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
		await expect(fetchAllPages(read)).rejects.toThrow('Failed to fetch')
		expect(read).toHaveBeenCalledOnce()
	})

})
