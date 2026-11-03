import {CancelledError, QueryCache, QueryClient} from '@tanstack/vue-query'

import {isRequestContextAbort} from '@/client/requestContext'
import {error} from '@/message'

// Repeating a denied or invalid request only adds another round trip on a slow connection.
// Transport failures and temporary server failures still get one automatic retry.
export function retryRead(failureCount: number, cause: unknown): boolean {
	if (failureCount >= 1 || cause instanceof CancelledError || isRequestContextAbort(cause)) return false
	const status = (cause as {status?: unknown} | null)?.status
	return typeof status !== 'number' || status === 408 || status >= 500
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (cause, query) => {
			if (query.meta?.handlesError) return
			if (cause instanceof CancelledError || isRequestContextAbort(cause)) return
			error(cause)
		},
	}),
	defaultOptions: {
		queries: {
			staleTime: 60_000,
			retry: retryRead,
			refetchOnWindowFocus: false,
		},
		mutations: {
			retry: false,
		},
	},
})
