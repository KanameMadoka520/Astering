import {queryOptions} from '@tanstack/vue-query'
import {systemUsageAccess, systemUsageUsers, type SystemUsageUsersData} from '@/client/generated'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'

export type ScopedUsage<T> = {
	context: ClientRequestContext,
	data: T,
}

// A mounted observer can retain its old result after QueryClient.clear().
// Fence the value as well as the HTTP request before rendering private data.
export function currentSiteUsageData<T>(value: ScopedUsage<T> | undefined): T | undefined {
	return value && isClientRequestContextCurrent(value.context) ? value.data : undefined
}

export function siteUsageAccessQuery(context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: ['site-usage', 'access', context],
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await systemUsageAccess({signal})
			assertClientRequestContext(context)
			return {context, data}
		},
		staleTime: 0,
		refetchOnMount: 'always',
		refetchOnWindowFocus: true,
		retry: false,
		meta: {handlesError: true},
	})
}

export function siteUsageUsersQuery(
	query: NonNullable<SystemUsageUsersData['query']>,
	context = captureClientRequestContext(),
) {
	return queryOptions({
		queryKey: ['site-usage', 'users', context, query],
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await systemUsageUsers({query, signal})
			assertClientRequestContext(context)
			return {context, data}
		},
		staleTime: 0,
		gcTime: 60_000,
		refetchOnMount: 'always',
		refetchInterval: 60_000,
		retry: false,
		meta: {handlesError: true},
	})
}
