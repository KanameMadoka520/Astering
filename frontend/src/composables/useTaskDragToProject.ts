import {useI18n} from 'vue-i18n'

import type {TaskResponse} from '@/client/queries/tasks'
import {useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {findProjectIdAtPosition, useTaskDragState} from '@/composables/useTaskDragState'
import {useProjects} from '@/composables/useProjects'
import {success} from '@/message'

export interface TaskDragToProjectResult {
	moved: boolean
	targetProjectId: number | null
}

/**
 * Composable for handling task drag-and-drop to sidebar projects.
 *
 * Provides functionality to:
 * - Detect when a task is dropped over a sidebar project
 * - Move the task to the target project
 * - Show success/error notifications
 *
 * @returns Functions for handling drag start and checking for project drops
 */
export function useTaskDragToProject() {
	const {t} = useI18n({useScope: 'global'})
	const {draggedTask, setDraggedTask} = useTaskDragState()
	const updateTask = useUpdateTaskMutation()
	const projectList = useProjects()

	/**
	 * Attempts to move a dragged task to a project at the given mouse position.
	 * Should be called in the drag end handler.
	 *
	 * @param e - The drag event with originalEvent containing mouse coordinates
	 * @param onSuccess - Optional callback called after successful move (e.g., to update local state)
	 * @returns Result indicating if task was moved and to which project
	 */
	async function handleTaskDropToProject(
		e: { originalEvent?: MouseEvent },
		onSuccess?: (task: TaskResponse, targetProjectId: number) => void,
	): Promise<TaskDragToProjectResult> {
		const dragged = draggedTask.value

		if (!dragged || !e.originalEvent) {
			setDraggedTask(null)
			return {moved: false, targetProjectId: null}
		}

		const mouseX = e.originalEvent.clientX
		const mouseY = e.originalEvent.clientY
		const targetProjectId = findProjectIdAtPosition(mouseX, mouseY)

		if (!targetProjectId || targetProjectId <= 0 || targetProjectId === dragged.project_id) {
			setDraggedTask(null)
			return {moved: false, targetProjectId}
		}

		const targetProject = projectList.projects[targetProjectId]

		try {
			await updateTask.mutateAsync({
				...dragged,
				id: dragged.id!,
				project_id: targetProjectId,
			})

			if (onSuccess) {
				onSuccess(dragged, targetProjectId)
			}

			success({message: t('task.movedToProject', {project: targetProject?.title || t('project.title')})})

			return {moved: true, targetProjectId}
		} catch {
			return {moved: false, targetProjectId}
		} finally {
			// Always clears drag state - callers should not clear again
			setDraggedTask(null)
		}
	}

	return {
		handleTaskDropToProject,
	}
}
