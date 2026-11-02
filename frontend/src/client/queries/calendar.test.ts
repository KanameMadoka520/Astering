import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver} from '@tanstack/vue-query'
import {
	calendarTasksQuery,
	invalidateCalendarTasks,
	type CalendarTaskOptions,
	type CalendarTasksResponse,
} from './calendar'
import {invalidateTaskMembership} from './taskCache'
import {applyServerTaskUpdated} from './taskMutations'

const sdk = vi.hoisted(() => ({tasksCalendar: vi.fn()}))
vi.mock('@/client/generated', () => sdk)

const window: CalendarTaskOptions = {
	from: '2026-11-01',
	to: '2026-11-08',
	timezone: 'Asia/Shanghai',
}

function response(title = 'Meeting', page = 1, pages = 1) {
	return {
		data: {
			from: window.from,
			to: window.to,
			timezone: window.timezone,
			days: [{date: '2026-11-01', start_at: '2026-10-31T16:00:00Z', end_at: '2026-11-01T16:00:00Z'}],
			items: [{id: page, title, project_id: 1}],
			total: pages,
			page,
			per_page: 1,
			total_pages: pages,
		},
	}
}

function gate<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

const options = (query: CalendarTaskOptions) => calendarTasksQuery(query) as unknown as
	ConstructorParameters<typeof QueryObserver<CalendarTasksResponse>>[1]

describe('calendar shared query', () => {
	beforeEach(() => vi.resetAllMocks())

	it('loads only the requested window through SDK pagination and retains server day boundaries', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tasksCalendar.mockImplementation(async ({query}) => response(`Page ${query.page}`, query.page, 2))
		try {
			const data = await client.fetchQuery(calendarTasksQuery({...window, projectId: 8, done: 'all'}))
			expect(data.items.map(item => item.title)).toEqual(['Page 1', 'Page 2'])
			expect(data.days).toEqual(response().data.days)
			expect(sdk.tasksCalendar).toHaveBeenCalledTimes(2)
			expect(sdk.tasksCalendar.mock.calls.map(([request]) => request.query)).toEqual([1, 2].map(page => ({
				...window,
				project_id: 8,
				done: 'all',
				page,
			})))
		} finally { client.clear() }
	})

	it('refreshes a mounted calendar through ordinary task membership reconciliation', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tasksCalendar.mockResolvedValue(response())
		const observer = new QueryObserver<CalendarTasksResponse>(client, options(window))
		const unsubscribe = observer.subscribe(() => {})
		try {
			await vi.waitFor(() => expect(observer.getCurrentResult().data?.items[0].title).toBe('Meeting'))
			sdk.tasksCalendar.mockResolvedValue(response('Rescheduled'))
			await invalidateTaskMembership(client, 1)
			expect(observer.getCurrentResult().data?.items[0].title).toBe('Rescheduled')
			expect(sdk.tasksCalendar).toHaveBeenCalledTimes(2)
		} finally { unsubscribe(); client.clear() }
	})

	it('does not lose a write arriving before the first calendar GET commits', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const initial = gate<ReturnType<typeof response>>()
		sdk.tasksCalendar.mockReturnValueOnce(initial.promise).mockResolvedValue(response('New schedule'))
		const observer = new QueryObserver<CalendarTasksResponse>(client, options(window))
		const unsubscribe = observer.subscribe(() => {})
		try {
			await vi.waitFor(() => expect(sdk.tasksCalendar).toHaveBeenCalledTimes(1))
			const refresh = invalidateCalendarTasks(client)
			initial.resolve(response('Old snapshot'))
			await refresh
			expect(observer.getCurrentResult().data?.items[0].title).toBe('New schedule')
			expect(sdk.tasksCalendar).toHaveBeenCalledTimes(2)
		} finally { unsubscribe(); client.clear() }
	})

	it('refreshes calendar membership after an Arona task receipt without replacing the observer', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		sdk.tasksCalendar.mockResolvedValue(response())
		const observer = new QueryObserver<CalendarTasksResponse>(client, options(window))
		const unsubscribe = observer.subscribe(() => {})
		try {
			await vi.waitFor(() => expect(observer.getCurrentResult().data?.items[0].title).toBe('Meeting'))
			sdk.tasksCalendar.mockResolvedValue(response('Changed by Arona'))
			await applyServerTaskUpdated(client, {
				id: 1,
				project_id: 1,
				title: 'Changed by Arona',
				start_date: '2026-11-03T01:00:00Z',
				end_date: '2026-11-03T02:00:00Z',
			})
			expect(observer.getCurrentResult().data?.items[0].title).toBe('Changed by Arona')
			expect(sdk.tasksCalendar).toHaveBeenCalledTimes(2)
		} finally { unsubscribe(); client.clear() }
	})

	it('keeps a late response in its own date window when navigation starts a new query', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const first = gate<ReturnType<typeof response>>()
		sdk.tasksCalendar.mockReturnValueOnce(first.promise).mockResolvedValue(response('December'))
		const observer = new QueryObserver<CalendarTasksResponse>(client, options(window))
		const unsubscribe = observer.subscribe(() => {})
		try {
			await vi.waitFor(() => expect(sdk.tasksCalendar).toHaveBeenCalledTimes(1))
			observer.setOptions(options({...window, from: '2026-12-01', to: '2026-12-08'}))
			await vi.waitFor(() => expect(observer.getCurrentResult().data?.items[0].title).toBe('December'))
			first.resolve(response('Late November'))
			await vi.waitFor(() => expect(sdk.tasksCalendar).toHaveBeenCalledTimes(2))
			expect(observer.getCurrentResult().data?.items[0].title).toBe('December')
		} finally { unsubscribe(); client.clear() }
	})
})
