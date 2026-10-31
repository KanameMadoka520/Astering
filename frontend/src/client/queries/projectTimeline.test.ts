import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver} from '@tanstack/vue-query'

import {
	normalizeProjectTimeline,
	projectTimelineQuery,
	type ProjectTimelineQuery,
	type ProjectTimelineResponse,
} from './projectTimeline'
import {invalidateTaskMembership} from './taskCache'

const sdk = vi.hoisted(() => ({
	projectTimeline: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)

const base: ProjectTimelineQuery = {
	year: 2026,
	timezone: 'UTC',
	status: 'all',
	page: 1,
}

function response(query: ProjectTimelineQuery, title = 'Website') {
	return {
		data: {
			year: query.year,
			today: '2026-10-31',
			days: {'2026-02-05': {scheduled_projects: 1, elapsed_projects: 1, deadlines: 0}},
			items: [{id: 1, title, scheduled_spans: [{start: '2026-02-01', end: '2026-02-10'}], elapsed_spans: null}],
			total: 1,
			page: 1,
			total_pages: 1,
		},
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return {promise, resolve}
}

type Observer = QueryObserver<ProjectTimelineResponse>

// vue-query option types accept refs; the observer used here takes the plain core options.
const options = (query: ProjectTimelineQuery) => projectTimelineQuery(query) as unknown as ConstructorParameters<typeof QueryObserver<ProjectTimelineResponse>>[1]

async function settle(observer: Observer) {
	await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false))
}

describe('project timeline query', () => {
	beforeEach(() => {
		vi.resetAllMocks()
		sdk.projectTimeline.mockImplementation(async ({query}: {query: ProjectTimelineQuery}) => response(query))
	})

	it('fills absent collections so the view never guards against null', () => {
		const data = normalizeProjectTimeline({year: 2026, items: [{id: 2, scheduled_spans: null}]})
		expect(data.days).toEqual({})
		expect(data.items[0].scheduled_spans).toEqual([])
		expect(data.items[0].elapsed_spans).toEqual([])
		expect(data.items[0].deadline_days).toEqual([])
		expect(normalizeProjectTimeline({year: 2026}).items).toEqual([])
	})

	it('keeps the year on screen while a day or page reloads, but not across years or filters', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const observer = new QueryObserver<ProjectTimelineResponse>(client, options(base))
		const unsubscribe = observer.subscribe(() => {})
		await settle(observer)
		const first = observer.getCurrentResult().data

		const gate = deferred()
		sdk.projectTimeline.mockImplementation(async ({query}: {query: ProjectTimelineQuery}) => {
			await gate.promise
			return response(query, 'Later')
		})
		observer.setOptions(options({...base, day: '2026-02-05'}))
		expect(observer.getCurrentResult().isPlaceholderData).toBe(true)
		expect(observer.getCurrentResult().data).toBe(first)

		observer.setOptions(options({...base, status: 'archived'}))
		expect(observer.getCurrentResult().data).toBeUndefined()
		observer.setOptions(options({...base, year: 2025}))
		expect(observer.getCurrentResult().data).toBeUndefined()

		gate.resolve()
		await settle(observer)
		unsubscribe()
	})

	it('refetches a mounted timeline once after a task change and leaves unmounted ones for their next visit', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const mounted = new QueryObserver<ProjectTimelineResponse>(client, options(base))
		const unsubscribe = mounted.subscribe(() => {})
		await settle(mounted)
		const other = projectTimelineQuery({...base, year: 2024})
		await client.prefetchQuery(other)
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(2)

		await invalidateTaskMembership(client, 1)
		await settle(mounted)
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(3)
		expect(sdk.projectTimeline.mock.lastCall?.[0].query.year).toBe(2026)
		expect(client.getQueryState(other.queryKey)?.isInvalidated).toBe(true)
		// Content stayed visible: the refresh replaced data, it never went back to a pending state.
		expect(mounted.getCurrentResult().status).toBe('success')
		unsubscribe()
	})
})
