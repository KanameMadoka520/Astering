import {queryOptions, useMutation, type QueryClient} from '@tanstack/vue-query'
import {
	taskRoutineCheckIn,
	taskRoutineHistory,
	taskRoutineProgress,
	taskRoutineRead,
	taskRoutineUpdate,
	type Task,
	type TaskRoutineHistory,
	type TaskRoutineProgress,
	type TaskRoutineWritable,
} from '@/client/generated'
import {assertClientRequestContext} from '@/client/requestContext'
import {
	normalizeTaskRoutine,
	routineOf,
	routineTimeOrEmpty,
	type RawTaskRoutine,
	type TaskRoutineSummary,
} from '@/helpers/taskRoutine'
import {contextMutationOptions} from './contextMutation'
import {mapTaskEverywhere, recordServerTaskWrite, replaceTaskEverywhere} from './taskCache'

export type TaskRoutineHistoryItem = {
	date: string
	timezone: string
	completed_at: string
	completed_by_id: number
}

export type TaskRoutineHistoryResponse = {
	timezone: string
	year: number
	month: number
	items: TaskRoutineHistoryItem[]
	periods: RoutinePeriodRecord[]
	total_checkins: number
	current_streak: number
	longest_streak: number
}

export type RoutinePeriodRecord = Required<Omit<TaskRoutineProgress, 'completed_at'>> & {completed_at: string}
type RawTaskRoutineHistory = TaskRoutineHistory

export const taskRoutineKeys = {
	all: ['task-routine'] as const,
	task: (taskId: number) => [...taskRoutineKeys.all, taskId] as const,
	summary: (taskId: number) => [...taskRoutineKeys.task(taskId), 'summary'] as const,
	histories: (taskId: number) => [...taskRoutineKeys.task(taskId), 'history'] as const,
	history: (taskId: number, year: number, month: number) => [...taskRoutineKeys.histories(taskId), year, month] as const,
}

// A summary read without a stored routine still answers enabled=false with the account's zone.
function summaryOrDisabled(raw: RawTaskRoutine | null | undefined): TaskRoutineSummary {
	return normalizeTaskRoutine(raw) ?? normalizeTaskRoutine({enabled: false})!
}

export function normalizeTaskRoutineHistory(raw: RawTaskRoutineHistory): TaskRoutineHistoryResponse {
	return {
		timezone: raw.timezone ?? '',
		year: raw.year ?? 0,
		month: raw.month ?? 0,
		items: (raw.items ?? []).map(item => ({
			date: item.date ?? '',
			timezone: item.timezone ?? raw.timezone ?? '',
			completed_at: normalizeTaskRoutine({completed_at: item.completed_at})?.completed_at ?? '',
			completed_by_id: item.completed_by_id ?? 0,
		})).filter(item => item.date !== ''),
		periods: (raw.periods ?? []).map(item => ({
			id: item.id ?? 0,
			task_id: item.task_id ?? 0,
			schedule_key: item.schedule_key ?? '',
			date: item.date ?? '',
			period: item.period ?? 'daily',
			timezone: item.timezone ?? raw.timezone ?? '',
			period_start_at: routineTimeOrEmpty(item.period_start_at),
			period_end_at: routineTimeOrEmpty(item.period_end_at),
			amount: item.amount ?? 0,
			target: item.target || 1,
			unit: item.unit ?? '',
			completed_at: routineTimeOrEmpty(item.completed_at),
			completed_by_id: item.completed_by_id ?? 0,
			updated_by_id: item.updated_by_id ?? 0,
			created: routineTimeOrEmpty(item.created),
			updated: routineTimeOrEmpty(item.updated),
		})).filter(item => item.id > 0 && item.date !== ''),
		total_checkins: raw.total_checkins ?? 0,
		current_streak: raw.current_streak ?? 0,
		longest_streak: raw.longest_streak ?? 0,
	}
}

export function taskRoutineQuery(taskId: number) {
	return queryOptions({
		queryKey: taskRoutineKeys.summary(taskId),
		queryFn: async ({signal}) => summaryOrDisabled((await taskRoutineRead({path: {task: taskId}, signal})).data),
		meta: {handlesError: true},
	})
}

export function taskRoutineHistoryQuery(taskId: number, year: number, month: number) {
	return queryOptions({
		queryKey: taskRoutineKeys.history(taskId, year, month),
		queryFn: async ({signal}) => normalizeTaskRoutineHistory(
			(await taskRoutineHistory({path: {task: taskId}, query: {year, month}, signal})).data ?? {},
		),
		meta: {handlesError: true},
	})
}

// Orders local routine writes against the start of a summary read: a read that started before a write
// answered must not put the older state back. Ids only mean something for one client (account and API).
let routineWriteSequence = 0
const routineWrites = new WeakMap<QueryClient, Map<number, number>>()

function lastRoutineWrite(client: QueryClient, taskId: number): number {
	return routineWrites.get(client)?.get(taskId) ?? 0
}

// Shared with agent receipts so an earlier focus/day refresh cannot restore their previous progress.
export function recordRoutineWrite(client: QueryClient, taskId: number) {
	let writes = routineWrites.get(client)
	if (!writes) {
		writes = new Map()
		routineWrites.set(client, writes)
	}
	writes.set(taskId, ++routineWriteSequence)
}

// The write answers with the whole task: patch every cached copy and the routine summary. `done` does not
// change with a routine write, so done buckets and list membership stay as they are. Recording it as a server
// write keeps an older field save that answers later (a description autosave) from restoring the old routine.
function applyRoutineTask(client: QueryClient, task: Task) {
	if (task.id === undefined) return
	recordRoutineWrite(client, task.id)
	recordServerTaskWrite(client, task)
	replaceTaskEverywhere(client, task)
	const routine = routineOf(task)
	if (routine) {
		client.setQueryData<TaskRoutineSummary>(taskRoutineKeys.summary(task.id), current => current ? routine : current)
	}
}

function settleRoutine(client: QueryClient, taskId: number) {
	// Only a mounted panel or history refetches.
	return Promise.all([
		client.invalidateQueries({queryKey: taskRoutineKeys.summary(taskId), exact: true}),
		client.invalidateQueries({queryKey: taskRoutineKeys.histories(taskId)}),
	])
}

export type ConfigureTaskRoutineInput = TaskRoutineWritable & {
	taskId: number
	revision: number
}

// Callers render a 409 (someone changed the routine meanwhile) themselves, so failures are not toasted here.
export function configureTaskRoutineMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: ConfigureTaskRoutineInput) =>
			(await taskRoutineUpdate({path: {task: taskId}, body})).data,
		onSuccess: (task, _input, client) => applyRoutineTask(client, task),
		onSettled: ({taskId}, client) => settleRoutine(client, taskId),
		toastError: () => false,
	})
}

export type TaskRoutineCheckInInput = {
	taskId: number
	date: string
	completed: boolean
	revision?: number
}

export function checkInTaskRoutineMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: TaskRoutineCheckInInput) =>
			(await taskRoutineCheckIn({path: {task: taskId}, body})).data,
		onSuccess: (task, _input, client) => applyRoutineTask(client, task),
		onSettled: ({taskId}, client) => settleRoutine(client, taskId),
		toastError: () => false,
	})
}

export type SetTaskRoutineProgressInput = {
	taskId: number
	date: string
	revision: number
	amount: number
}

export function setTaskRoutineProgressMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({taskId, ...body}: SetTaskRoutineProgressInput) =>
			(await taskRoutineProgress({path: {task: taskId}, body})).data,
		onSuccess: (task, _input, client) => applyRoutineTask(client, task),
		onSettled: ({taskId}, client) => settleRoutine(client, taskId),
		toastError: () => false,
	})
}

/**
 * Re-reads the routine of these tasks and patches only that field everywhere: after a rejected check-in
 * (the day changed, someone else changed the routine) and when a new local day starts or the window
 * regains focus. A read that a local write overtook is dropped.
 */
export function refreshTaskRoutinesMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (taskIds: readonly number[], {request}) => {
			const since = routineWriteSequence
			const ids = [...new Set(taskIds)]
			const results = await Promise.allSettled(ids.map(id => taskRoutineRead({path: {task: id}})))
			assertClientRequestContext(request)
			return results.flatMap((result, index) => result.status === 'fulfilled'
				? [{taskId: ids[index], routine: result.value.data, since}]
				: [])
		},
		onSuccess: (routines, _input, client) => {
			for (const {taskId, routine, since} of routines) {
				if (lastRoutineWrite(client, taskId) > since) continue
				mapTaskEverywhere(client, taskId, task => ({...task, routine}))
				client.setQueryData<TaskRoutineSummary>(taskRoutineKeys.summary(taskId), current =>
					current ? summaryOrDisabled(routine) : current)
			}
		},
		toastError: () => false,
	})
}

export function useConfigureTaskRoutineMutation() {
	return useMutation(configureTaskRoutineMutationOptions())
}

export function useCheckInTaskRoutineMutation() {
	return useMutation(checkInTaskRoutineMutationOptions())
}

export function useSetTaskRoutineProgressMutation() {
	return useMutation(setTaskRoutineProgressMutationOptions())
}

export function useRefreshTaskRoutinesMutation() {
	return useMutation(refreshTaskRoutinesMutationOptions())
}
