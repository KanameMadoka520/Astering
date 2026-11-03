import {beforeEach, describe, expect, it, vi} from 'vitest'
import {CancelledError} from '@tanstack/vue-query'

import {queryClient, retryRead} from './queryClient'
import {error} from '@/message'

vi.mock('@/message', () => ({error: vi.fn()}))

function failingQuery(queryKey: string[], cause: unknown) {
	return queryClient.fetchQuery({
		queryKey,
		queryFn: async () => {
			throw cause
		},
		retry: false,
	})
}

describe('queryClient', () => {
	it.each([400, 401, 403, 404, 409, 422, 429])('does not repeat a read rejected with HTTP %s', async status => {
		const read = vi.fn().mockRejectedValue({status})
		await expect(queryClient.fetchQuery({queryKey: ['rejected', String(status)], queryFn: read})).rejects.toEqual({status})
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('retries transport and temporary server failures only once', () => {
		for (const cause of [new TypeError('Failed to fetch'), {status: 408}, {status: 502}, {status: 503}]) {
			expect(retryRead(0, cause)).toBe(true)
			expect(retryRead(1, cause)).toBe(false)
		}
		expect(retryRead(0, new CancelledError())).toBe(false)
		expect(retryRead(0, new DOMException('Client request context changed', 'AbortError'))).toBe(false)
	})

	beforeEach(() => {
		queryClient.clear()
		vi.mocked(error).mockClear()
	})

	it('reports a failed read', async () => {
		const cause = {
			status: 500,
			detail: 'boom',
		}

		await expect(failingQuery(['fails'], cause)).rejects.toBe(cause)

		expect(error).toHaveBeenCalledExactlyOnceWith(cause)
	})

	it('stays silent for a cancelled read', async () => {
		await expect(failingQuery(['cancelled'], new CancelledError())).rejects.toThrow()

		expect(error).not.toHaveBeenCalled()
	})

	it('stays silent for a request context abort', async () => {
		const cause = new DOMException('Client request context changed', 'AbortError')

		await expect(failingQuery(['aborted'], cause)).rejects.toBe(cause)

		expect(error).not.toHaveBeenCalled()
	})

	it('stays silent for a query that reports its own failures', async () => {
		const cause = {
			status: 404,
			detail: 'gone',
		}

		await expect(queryClient.fetchQuery({
			queryKey: ['handled'],
			queryFn: async () => {
				throw cause
			},
			retry: false,
			meta: {handlesError: true},
		})).rejects.toBe(cause)

		expect(error).not.toHaveBeenCalled()
	})
})
