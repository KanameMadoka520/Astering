import type {Task} from '@/client/generated'
import type {TaskResponse} from '@/client/queries/tasks'
import {useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useRoutineCheckIn} from '@/composables/useRoutineCheckIn'
import {playPopSound} from '@/helpers/playPop'
import {routineOf, routineStatus} from '@/helpers/taskRoutine'
import {TASK_REPEAT_MODES} from '@/types/IRepeatMode'

/** Completing a task from a board. A routine is checked in for today instead; its done flag never changes. */
export function useTaskDoneToggle() {
	const updateTask = useUpdateTaskMutation()
	const routineCheckIn = useRoutineCheckIn()
	const {now} = useGlobalNow()

	const isRoutine = (task: Task) => routineOf(task)?.enabled === true
	const isComplete = (task: TaskResponse) => isRoutine(task)
		? routineStatus(routineOf(task), now.value) === 'done'
		: task.done

	/** `onRecurringDone` hears about a recurring task that was marked done, so boards can re-read date filters. */
	async function toggle(task: TaskResponse, onRecurringDone?: (task: Task) => void) {
		if (isRoutine(task)) {
			await routineCheckIn.setCheckedIn(task, !isComplete(task))
			return
		}
		const isRecurringTask = task.repeat_after > 0 || task.repeat_mode === TASK_REPEAT_MODES.REPEAT_MODE_MONTH
		const wasBeingMarkedDone = !task.done
		const updatedTask = await updateTask.mutateAsync({...task, done: !task.done})
		if (updatedTask.done) playPopSound()
		if (isRecurringTask && wasBeingMarkedDone && updatedTask.done) onRecurringDone?.(updatedTask)
	}

	return {isRoutine, isComplete, toggle}
}
