import {queryOptions} from '@tanstack/vue-query'
import {systemStatus} from '@/client/generated'

// The sidebar's meters are a glance; the measurement details are read closely while open.
export const SYSTEM_STATUS_INTERVAL = 60_000
export const SYSTEM_STATUS_DETAIL_INTERVAL = 5000

export function systemStatusQuery(enabled: boolean, detailed = false) {
	const interval = detailed ? SYSTEM_STATUS_DETAIL_INTERVAL : SYSTEM_STATUS_INTERVAL
	return queryOptions({
		queryKey: ['system-status'],
		queryFn: async ({signal}) => (await systemStatus({signal})).data!,
		enabled,
		staleTime: interval,
		refetchInterval: interval,
		refetchIntervalInBackground: false,
		retry: false,
		meta: {handlesError: true},
	})
}
