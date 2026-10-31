import {computed, nextTick, provide, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref} from 'vue'
import type {Task} from '@/client/generated'
import type {BucketResponse} from '@/client/queries/kanban'
import type {TaskResponse} from '@/client/queries/tasks'
import {useKanbanDisplayPreferences, type KanbanDisplayMode} from '@/composables/useKanbanDisplayPreferences'
import {
	columnTree,
	focusFamily,
	focusHierarchy,
	indexBoardHierarchy,
	treeGroupIds,
	treeTaskIds,
} from '@/helpers/kanbanHierarchy'
import {kanbanTreeKey} from './kanbanTreeContext'

const groupKey = (bucket: number, group: number) => `${bucket}:${group}`

/** Groups mode for a board: display state only, computed from the cards the board already holds. */
export function useKanbanGrouping(options: {
	project: MaybeRefOrGetter<number>
	view: MaybeRefOrGetter<number>
	buckets: ComputedRef<BucketResponse[]>
	/** Non-null while a search or filter narrows the board. */
	filterSignature: MaybeRefOrGetter<string | null>
	canMove: ComputedRef<boolean>
	canComplete(task: Task): boolean
	doneBucketId: ComputedRef<number | undefined>
	board: Ref<HTMLElement | null>
	move(task: TaskResponse, from: number, to: number): Promise<void>
	recurringDone(task: Task): void
}) {
	const preferences = useKanbanDisplayPreferences(options.project, options.view, options.filterSignature)
	const grouped = computed(() => preferences.mode.value === 'groups')
	const focusId = ref<number | null>(null)

	const hierarchy = computed(() => indexBoardHierarchy(options.buckets.value))
	const focused = computed(() => focusId.value === null ? hierarchy.value : focusHierarchy(hierarchy.value, focusId.value))
	const family = computed(() => focusId.value === null ? null : focusFamily(hierarchy.value, focusId.value))
	const columnTrees = computed(() => new Map(options.buckets.value.map(bucket => {
		const tasks = family.value ? bucket.tasks.filter(task => family.value!.has(task.id)) : bucket.tasks
		return [bucket.id, {nodes: columnTree(focused.value, tasks), hidden: bucket.tasks.length - tasks.length}]
	})))
	// Cards mode never builds the trees: nothing grouped is shown there.
	const groupKeys = computed(() => grouped.value
		? [...columnTrees.value].flatMap(([bucket, {nodes}]) => treeGroupIds(nodes).map(group => groupKey(bucket, group)))
		: [])
	const anyGroupCollapsed = computed(() => groupKeys.value.some(key => preferences.collapsed.value.has(key)))
	const loadedCount = computed(() => options.buckets.value.reduce((sum, bucket) => sum + bucket.tasks.length, 0))
	const focusShown = computed(() => [...columnTrees.value.values()]
		.reduce((sum, {nodes}) => sum + treeTaskIds(nodes).length, 0))

	// A focus belongs to the board it was set on, and ends once its task is no longer known there.
	watch(() => [toValue(options.project), toValue(options.view)], () => {
		focusId.value = null
	})
	watch(() => focusId.value !== null && !hierarchy.value.known.has(focusId.value), gone => {
		if (gone) focusId.value = null
	})

	function setDisplayMode(mode: KanbanDisplayMode) {
		preferences.setMode(mode)
		if (mode === 'cards') focusId.value = null
	}

	async function exitFocus() {
		const id = focusId.value
		focusId.value = null
		await nextTick()
		// Back to the button that started the focus; it is hidden while its group is the focus.
		options.board.value?.querySelector<HTMLElement>(`[data-focus-target="${id}"]`)?.focus()
	}

	function exitFocusByKey(event: KeyboardEvent) {
		if (focusId.value === null || event.defaultPrevented || event.isComposing) return
		// Escape belongs to whatever is open or being edited: a field, a picker, a menu or a dialog.
		const target = event.target as HTMLElement | null
		if (target?.closest('input, select, textarea, [contenteditable], dialog, .dropdown-menu')) return
		event.preventDefault()
		void exitFocus()
	}

	provide(kanbanTreeKey, {
		index: focused,
		buckets: options.buckets,
		doneBucketId: options.doneBucketId,
		canMove: options.canMove,
		canComplete: options.canComplete,
		focusId: computed(() => focusId.value),
		isCollapsed: (bucket, group) => preferences.collapsed.value.has(groupKey(bucket, group)),
		toggleCollapsed: (bucket, group) => preferences.setCollapsed(
			[groupKey(bucket, group)],
			!preferences.collapsed.value.has(groupKey(bucket, group)),
		),
		focus: id => {
			focusId.value = id
		},
		move: options.move,
		recurringDone: options.recurringDone,
	})

	return {
		displayMode: preferences.mode,
		setDisplayMode,
		grouped,
		collapsedGroups: preferences.collapsed,
		setGroupsCollapsed: preferences.setCollapsed,
		groupKeys,
		anyGroupCollapsed,
		focusId,
		hierarchy,
		columnTrees,
		loadedCount,
		focusShown,
		exitFocus,
		exitFocusByKey,
	}
}
