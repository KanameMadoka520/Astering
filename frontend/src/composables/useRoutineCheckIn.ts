import {shallowReactive} from 'vue'
import {useI18n} from 'vue-i18n'

import type {Task} from '@/client/generated'
import {ApiError} from '@/client/problem'
import {isRequestContextAbort} from '@/client/requestContext'
import {useCheckInTaskRoutineMutation, useRefreshTaskRoutinesMutation} from '@/client/queries/taskRoutines'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {isLegacyRoutine, routineOf, routineToday, type RawTaskRoutine} from '@/helpers/taskRoutine'
import {playPopSound} from '@/helpers/playPop'
import {error, success, translatedError} from '@/message'

type RoutineTask = Pick<Task, 'id'> & {routine?: RawTaskRoutine | null}

const ROUTINE_UNAVAILABLE = 20003

// Shared by every row, card and detail on the page, so one task cannot be written twice at once.
const pendingTasks = shallowReactive(new Set<number>())

/**
 * The one way the UI checks a routine in or undoes today's check-in. It sends the routine's own local
 * date; when the server's day differs (a page left open over midnight) or the routine changed, nothing is
 * written, the state is read again and the user is asked to act again. Failures keep the old state.
 */
export function useRoutineCheckIn() {
	const {t} = useI18n({useScope: 'global'})
	const checkIn = useCheckInTaskRoutineMutation()
	const refresh = useRefreshTaskRoutinesMutation()
	const {update: updateNow} = useGlobalNow()

	function isPending(taskId: number | undefined): boolean {
		return taskId !== undefined && pendingTasks.has(taskId)
	}

	async function setCheckedIn(task: RoutineTask, completed: boolean, undoable = true): Promise<boolean> {
		const routine = routineOf(task)
		const taskId = task.id
		if (taskId === undefined || !routine?.enabled || pendingTasks.has(taskId)) return false
		if (routine.paused) {
			error(translatedError('task.routine.pausedNoCheckIn'))
			return false
		}
		updateNow()
		const date = routineToday(routine, new Date())
		pendingTasks.add(taskId)
		let updated: Task
		try {
			updated = await checkIn.mutateAsync({
				taskId,
				date,
				completed,
				revision: routine.revision,
			})
		} catch (cause) {
			if (isRequestContextAbort(cause)) return false
			// 409: the server's day or the routine changed; 20003: it was paused, disabled or turned into a
			// plain task meanwhile. Either way the shown state is stale.
			if (cause instanceof ApiError && (cause.status === 409 || cause.code === ROUTINE_UNAVAILABLE)) {
				refresh.mutate([taskId])
				error(translatedError('task.routine.checkInConflict'))
			} else {
				error(cause)
			}
			return false
		} finally {
			pendingTasks.delete(taskId)
		}
		if (completed) playPopSound()
		success(
			{message: t(isLegacyRoutine(routine)
				? completed ? 'task.routine.checkedInSuccess' : 'task.routine.checkInUndoneSuccess'
				: completed ? 'routineSchedule.checkedSuccess' : 'routineSchedule.undoneSuccess')},
			completed && undoable
				? [{title: t('task.undo'), callback: () => void setCheckedIn(updated, false, false)}]
				: [],
		)
		return true
	}

	return {setCheckedIn, isPending}
}
