import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {queryOptions, useQuery, type QueryClient} from '@tanstack/vue-query'
import {
	tasksCalendar,
	type CalendarTask,
	type CalendarDayBoundary,
	type CalendarTasksResponse as CalendarPage,
} from '@/client/generated'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {fetchAllPages} from './fetchAllPages'

export type CalendarTaskItem = CalendarTask
export type CalendarDay = Required<CalendarDayBoundary>
export type CalendarTasksResponse = Omit<CalendarPage, 'items' | 'days'> & {
	items: CalendarTaskItem[]
	days: CalendarDay[]
}

export type CalendarTaskOptions = {
	from: string
	to: string
	timezone: string
	projectId?: number
	done?: 'all' | 'open' | 'done'
}

export const calendarKeys = {
	all: ['calendar-tasks'] as const,
	window: (options: CalendarTaskOptions) => [...calendarKeys.all, options] as const,
}

export function calendarTasksQuery(options: CalendarTaskOptions) {
	return queryOptions({
		queryKey: calendarKeys.window(options),
		queryFn: async ({signal}): Promise<CalendarTasksResponse> => {
			let first: CalendarPage | undefined
			const items = await fetchAllPages<CalendarTaskItem>(async page => {
				signal.throwIfAborted()
				const data = (await tasksCalendar({
					query: {
						from: options.from,
						to: options.to,
						timezone: options.timezone,
						project_id: options.projectId,
						done: options.done ?? 'open',
						page,
					},
					signal,
				})).data!
				first ??= data
				return data
			})
			signal.throwIfAborted()
			return {
				...first!,
				items: [...new Map(items.map(item => [item.id, item])).values()],
				days: (first?.days ?? []).map(day => ({
					date: day.date ?? '',
					start_at: day.start_at ?? '',
					end_at: day.end_at ?? '',
				})),
			}
		},
		staleTime: 30_000,
		gcTime: 120_000,
		meta: {handlesError: true},
	})
}

export function useCalendarTasksQuery(options: MaybeRefOrGetter<CalendarTaskOptions>) {
	return useQuery(computed(() => calendarTasksQuery(toValue(options))))
}

/** An initial GET has no cached data for TanStack to cancel and refetch on invalidation. */
export async function invalidateCalendarTasks(client: QueryClient) {
	const context = captureClientRequestContext()
	const initial = client.getQueryCache().findAll({queryKey: calendarKeys.all, type: 'active'})
		.filter(query => query.state.data === undefined && query.state.fetchStatus === 'fetching')
		.map(query => query.promise?.catch(() => undefined))
	await client.invalidateQueries({queryKey: calendarKeys.all})
	if (!initial.length) return
	await Promise.all(initial)
	if (isClientRequestContextCurrent(context)) {
		await client.invalidateQueries({queryKey: calendarKeys.all})
	}
}
