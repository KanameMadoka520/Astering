import {inject, type ComputedRef, type InjectionKey} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, type RouteLocationRaw} from 'vue-router'
import type {Task} from '@/client/generated'
import type {BucketResponse} from '@/client/queries/kanban'
import type {TaskResponse} from '@/client/queries/tasks'
import type {HierarchyIndex} from '@/helpers/kanbanHierarchy'

/** What the grouped columns share with the board that renders them. */
export type KanbanTreeContext = {
	/** Display parents follow the focus while one is set; relations and progress are the same either way. */
	index: ComputedRef<HierarchyIndex<TaskResponse>>
	buckets: ComputedRef<readonly BucketResponse[]>
	doneBucketId: ComputedRef<number | undefined>
	/** Moving between manual columns needs write access; dynamic columns are decided by their filters. */
	canMove: ComputedRef<boolean>
	/**
	 * Completing needs write access to the task's own project, not manual columns, so it also works on dynamic
	 * boards. Favorites and saved filters mix projects, so this is decided per task.
	 */
	canComplete(task: Task): boolean
	focusId: ComputedRef<number | null>
	isCollapsed(bucket: number, group: number): boolean
	toggleCollapsed(bucket: number, group: number): void
	focus(id: number): void
	move(task: TaskResponse, from: number, to: number): Promise<void>
	recurringDone(task: Task): void
}

export const kanbanTreeKey: InjectionKey<KanbanTreeContext> = Symbol('kanbanTree')

export function useKanbanTree(): KanbanTreeContext {
	const context = inject(kanbanTreeKey)
	if (!context) throw new Error('Grouped kanban parts need the board that provides kanbanTreeKey')
	return context
}

export function treeChildrenId(bucket: number, group: number) {
	return `kanban-tree-${bucket}-${group}`
}

/** Relation summaries can carry an empty title; a header still needs a name. */
export function useTaskLabel() {
	const {t} = useI18n({useScope: 'global'})
	return (task: Task) => task.title?.trim() || t('project.kanban.hierarchy.untitled', {id: task.id})
}

/**
 * Opens the task over the board, like a card does, so closing it returns to the same grouping and focus.
 * The state rides on the link itself: one navigation, and modified clicks still open the plain URL.
 */
export function useTaskRoute() {
	const route = useRoute()
	return (id: number | undefined): RouteLocationRaw => ({
		name: 'task.detail',
		params: {id},
		state: {backdropView: route.fullPath},
	})
}
