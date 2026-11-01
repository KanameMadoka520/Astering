import {onScopeDispose, shallowRef, watch} from 'vue'
import {createSharedComposable} from '@vueuse/core'
import type {TaskResponse} from '@/client/queries/tasks'

/**
 * The project a dragged task would land on: the topmost element under the pointer that carries a project id, or
 * sits inside one. Elements painted above the sidebar, such as the drag clone, are looked through.
 */
export function findProjectIdAtPosition(mouseX: number, mouseY: number): number | null {
	// Validate coordinates are finite numbers (required by elementsFromPoint)
	// This prevents errors on Firefox mobile where touch events may provide invalid coordinates
	if (!Number.isFinite(mouseX) || !Number.isFinite(mouseY)) {
		return null
	}

	const elementsUnderMouse = document.elementsFromPoint(mouseX, mouseY)

	for (const el of elementsUnderMouse) {
		if (!(el instanceof HTMLElement)) {
			continue
		}

		const withProjectId =
			el.dataset?.projectId != null
				? el
				: el.closest('[data-project-id]') as HTMLElement | null

		const projectId = withProjectId?.dataset.projectId
		if (projectId) {
			const parsed = parseInt(projectId, 10)
			if (!Number.isNaN(parsed)) {
				return parsed
			}
		}
	}

	return null
}

export const useTaskDragState = createSharedComposable(() => {
	const draggedTask = shallowRef<TaskResponse | null>(null)
	// The project under the pointer while a task is dragged, for the sidebar's drop highlight: one hit test per pointer
	// event for the whole sidebar instead of one per project row, and the same project the drop would use.
	const hoveredProjectId = shallowRef<number | null>(null)
	function track(event: MouseEvent) {
		// Synthetic drag events carry no pointer position.
		if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
		hoveredProjectId.value = findProjectIdAtPosition(event.clientX, event.clientY)
	}
	function stopTracking() {
		document.removeEventListener('mousemove', track, true)
		document.removeEventListener('dragover', track, true)
		hoveredProjectId.value = null
	}
	// Capture phase: Sortable.js may stop these events before they bubble.
	watch(draggedTask, task => {
		if (!task) return stopTracking()
		document.addEventListener('mousemove', track, true)
		document.addEventListener('dragover', track, true)
	})
	onScopeDispose(stopTracking)
	return {
		draggedTask,
		hoveredProjectId,
		setDraggedTask: (task: TaskResponse | null) => { draggedTask.value = task },
	}
})
