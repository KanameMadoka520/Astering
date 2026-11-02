import {beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'
import type {Task} from '@/client/generated'
import {normalizeTask, taskKeys, type PaginatedTaskResponse, type TaskResponse} from './tasks'
import {kanbanKeys, normalizeBucket, type BoardData} from './kanban'
import {
	checkInTaskRoutineMutationOptions,
	configureTaskRoutineMutationOptions,
	refreshTaskRoutinesMutationOptions,
	setTaskRoutineProgressMutationOptions,
	normalizeTaskRoutineHistory,
	taskRoutineKeys,
	taskRoutineQuery,
} from './taskRoutines'

const sdk = vi.hoisted(() => ({
	taskRoutineCheckIn: vi.fn(),
	taskRoutineHistory: vi.fn(),
	taskRoutineProgress: vi.fn(),
	taskRoutineRead: vi.fn(),
	taskRoutineUpdate: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => 1,
	assertClientRequestContext: vi.fn(),
	isClientRequestContextCurrent: vi.fn(() => true),
	isRequestContextAbort: () => false,
}))

type RoutineTask = TaskResponse & {routine?: Record<string, unknown> | null}

const pending = {enabled: true, paused: false, timezone: 'Asia/Shanghai', revision: 2, date: '2026-11-01', completed_today: false}
const checkedIn = {...pending, completed_today: true, completed_at: '2026-11-01T08:30:00+08:00', completed_by_id: 1}

const listKey = taskKeys.list({project: 1})
const boardKey = kanbanKeys.board(1, 4)

function seed(client: QueryClient) {
	const task = normalizeTask({id: 3, project_id: 1, title: 'Water the plants', bucket_id: 8, done: false, routine: pending} as Task)
	client.setQueryData<PaginatedTaskResponse>(listKey, {items: [task], total: 1, page: 1, per_page: 50, total_pages: 1})
	client.setQueryData<BoardData>(boardKey, {
		buckets: [normalizeBucket({id: 8, count: 1, tasks: [task]}), normalizeBucket({id: 9, count: 0, tasks: []})],
		pages: {8: 1},
	})
	client.setQueryData(taskKeys.detail(3), task)
	client.setQueryData(taskRoutineKeys.summary(3), pending)
	client.setQueryData(taskRoutineKeys.history(3, 2026, 11), {items: []})
}

function run<TData, TInput>(client: QueryClient, options: unknown, input: TInput): Promise<TData> {
	return client.getMutationCache().build(client, options as never).execute(input as never) as Promise<TData>
}

describe('routine check-in', () => {
	let client: QueryClient

	beforeEach(() => {
		vi.clearAllMocks()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		seed(client)
	})

	it('sends today\'s date and patches every copy without touching done or the bucket', async () => {
		sdk.taskRoutineCheckIn.mockResolvedValue({data: {id: 3, project_id: 1, title: 'Water the plants', done: false, routine: checkedIn}})
		await run(client, checkInTaskRoutineMutationOptions(), {taskId: 3, date: '2026-11-01', completed: true})

		expect(sdk.taskRoutineCheckIn).toHaveBeenCalledWith({path: {task: 3}, body: {date: '2026-11-01', completed: true}})
		const listed = client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0] as RoutineTask
		const board = client.getQueryData<BoardData>(boardKey)!
		expect(listed.routine).toMatchObject({completed_today: true})
		expect(listed.done).toBe(false)
		expect(board.buckets.map(bucket => bucket.tasks.map(task => task.id))).toEqual([[3], []])
		expect((board.buckets[0].tasks[0] as RoutineTask).routine).toMatchObject({completed_today: true})
		expect((client.getQueryData(taskKeys.detail(3)) as RoutineTask).routine).toMatchObject({completed_today: true})
		expect(client.getQueryData(taskRoutineKeys.summary(3))).toMatchObject({completed_today: true, completed_at: '2026-11-01T08:30:00+08:00'})
		expect(client.getQueryState(taskRoutineKeys.history(3, 2026, 11))?.isInvalidated).toBe(true)
		// Membership did not change, so lists are not marked stale.
		expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	})

	it('keeps the old state when the server rejects the day', async () => {
		sdk.taskRoutineCheckIn.mockRejectedValue(Object.assign(new Error('day changed'), {status: 409}))
		await expect(run(client, checkInTaskRoutineMutationOptions(), {taskId: 3, date: '2026-10-31', completed: true})).rejects.toThrow()
		const listed = client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0] as RoutineTask
		expect(listed.routine).toMatchObject({completed_today: false})
	})

	it('drops a summary read that a later check-in overtook', async () => {
		let answer: (value: unknown) => void = () => {}
		sdk.taskRoutineRead.mockReturnValue(new Promise(resolve => {answer = resolve}))
		const refresh = run(client, refreshTaskRoutinesMutationOptions(), [3])
		sdk.taskRoutineCheckIn.mockResolvedValue({data: {id: 3, project_id: 1, done: false, routine: checkedIn}})
		await run(client, checkInTaskRoutineMutationOptions(), {taskId: 3, date: '2026-11-01', completed: true})
		answer({data: pending})
		await refresh

		const listed = client.getQueryData<PaginatedTaskResponse>(listKey)!.items[0] as RoutineTask
		expect(listed.routine).toMatchObject({completed_today: true})
	})

	it('applies a fresh summary read to every copy', async () => {
		sdk.taskRoutineRead.mockResolvedValue({data: {...pending, date: '2026-11-02'}})
		await run(client, refreshTaskRoutinesMutationOptions(), [3, 3])
		expect(sdk.taskRoutineRead).toHaveBeenCalledTimes(1)
		const card = client.getQueryData<BoardData>(boardKey)!.buckets[0].tasks[0] as RoutineTask
		expect(card.routine).toMatchObject({date: '2026-11-02'})
		expect(client.getQueryData(taskRoutineKeys.summary(3))).toMatchObject({date: '2026-11-02'})
	})
})

describe('routine settings', () => {
	it('sends the revision it read and patches the returned task', async () => {
		const client = new QueryClient()
		seed(client)
		sdk.taskRoutineUpdate.mockResolvedValue({data: {id: 3, project_id: 1, done: false, routine: {...pending, paused: true, revision: 3}}})
		await run(client, configureTaskRoutineMutationOptions(), {taskId: 3, enabled: true, paused: true, timezone: 'Asia/Shanghai', revision: 2})
		expect(sdk.taskRoutineUpdate).toHaveBeenCalledWith({
			path: {task: 3},
			body: {enabled: true, paused: true, timezone: 'Asia/Shanghai', revision: 2},
		})
		expect(client.getQueryData(taskRoutineKeys.summary(3))).toMatchObject({paused: true, revision: 3})
	})

	it('reads a task without a routine as disabled', async () => {
		const client = new QueryClient()
		sdk.taskRoutineRead.mockResolvedValue({data: {enabled: false, revision: 0, timezone: 'Europe/Berlin'}})
		const routine = await client.fetchQuery(taskRoutineQuery(5))
		expect(routine).toMatchObject({enabled: false, revision: 0, timezone: 'Europe/Berlin', completed_today: false})
	})

	it('keeps calendar and quota fields when pausing and sends an absolute amount with its period revision', async () => {
		const client = new QueryClient()
		seed(client)
		const calendar = {
			enabled: true,
			paused: true,
			timezone: 'Asia/Shanghai',
			revision: 2,
			period: 'weekly' as const,
			reset_hour: 6,
			reset_minute: 30,
			week_start: 1,
			month_day: 31,
			target: 5,
			unit: 'sessions',
		}
		sdk.taskRoutineUpdate.mockResolvedValue({data: {id: 3, project_id: 1, routine: {...pending, ...calendar}}})
		await run(client, configureTaskRoutineMutationOptions(), {taskId: 3, ...calendar})
		expect(sdk.taskRoutineUpdate).toHaveBeenLastCalledWith({path: {task: 3}, body: calendar})
		sdk.taskRoutineProgress.mockResolvedValue({data: {
			id: 3,
			project_id: 1,
			routine: {...pending, period: 'weekly', current_amount: 2, target: 5},
		}})
		await run(client, setTaskRoutineProgressMutationOptions(), {
			taskId: 3,
			date: '2026-11-01',
			revision: 2,
			amount: 2,
		})
		expect(sdk.taskRoutineProgress).toHaveBeenCalledWith({
			path: {task: 3},
			body: {date: '2026-11-01', revision: 2, amount: 2},
		})
		expect((client.getQueryData(taskKeys.detail(3)) as RoutineTask).routine)
			.toMatchObject({period: 'weekly', current_amount: 2, target: 5})
		expect(client.getQueryState(taskRoutineKeys.history(3, 2026, 11))?.isInvalidated).toBe(true)
	})

	it('retains incomplete historic periods with their original target and unit', () => {
		const history = normalizeTaskRoutineHistory({
			items: [],
			periods: [{
				id: 9,
				date: '2026-10-26',
				period: 'weekly',
				amount: 2,
				target: 5,
				unit: 'sessions',
				completed_at: null,
			}],
		})
		expect(history.periods).toEqual([expect.objectContaining({
			id: 9,
			period: 'weekly',
			amount: 2,
			target: 5,
			unit: 'sessions',
			completed_at: '',
		})])
	})
})
