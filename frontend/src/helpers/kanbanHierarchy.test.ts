import {describe, expect, it} from 'vitest'
import type {Task} from '@/client/generated'
import {
	columnTree,
	directSubtaskProgress,
	focusFamily,
	focusHierarchy,
	hierarchyTrail,
	indexBoardHierarchy,
	otherParents,
	treeGroupIds,
	treeTaskIds,
	type HierarchyColumn,
	type HierarchyIndex,
	type KanbanTreeNode,
} from './kanbanHierarchy'

type Edge = [parent: number, child: number]

/** Cards with symmetric relation summaries, like the API returns them: one level deep, no nested relations. */
function board(columns: Record<number, number[]>, edges: Edge[], done: number[] = []): HierarchyColumn<Task>[] {
	const summary = (id: number): Task => ({id, title: `Task ${id}`, done: done.includes(id)})
	const card = (id: number): Task => ({
		...summary(id),
		related_tasks: {
			parenttask: edges.filter(([, child]) => child === id).map(([parent]) => summary(parent)),
			subtask: edges.filter(([parent]) => parent === id).map(([, child]) => summary(child)),
		},
	})
	return Object.entries(columns).map(([id, tasks]) => ({id: Number(id), tasks: tasks.map(card)}))
}

function trees(columns: HierarchyColumn<Task>[], index: HierarchyIndex<Task> = indexBoardHierarchy(columns)) {
	return new Map(columns.map(column => [column.id, columnTree(index, column.tasks)]))
}

/** Compact picture of a tree: "t5[t6,t7]" for a card with nested cards, "c9(...)" for a context header. */
function shape(nodes: readonly KanbanTreeNode<Task>[]): string {
	return nodes.map(node => {
		const inner = node.children.length ? `${node.kind === 'task' ? '[' : '('}${shape(node.children)}${node.kind === 'task' ? ']' : ')'}` : ''
		return `${node.key}${inner}`
	}).join(',')
}

const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => from + i)

describe('kanban display hierarchy', () => {
	// Goal 1 → phases 10, 20 → steps. Parents sort last in their column, as on the real board.
	const phaseSteps = range(101, 127)
	const edges: Edge[] = [[1, 10], [1, 20], ...phaseSteps.map(step => [10, step] as Edge), [20, 201], [20, 202], [20, 203]]

	it('groups a long column whose parents are on a later page under honest context headers', () => {
		const firstPage = board({7: phaseSteps.slice(0, 25), 8: [201, 202]}, edges)
		const index = indexBoardHierarchy(firstPage)
		const column = trees(firstPage, index).get(7)!

		expect(shape(column)).toBe(`c10(${phaseSteps.slice(0, 25).map(id => `t${id}`).join(',')})`)
		// The phase card is not loaded, so 25 loaded children must not pass for its progress.
		expect(directSubtaskProgress(index, 10)).toBeNull()
		const [context] = column
		expect(context.kind === 'context' && context.parent.title).toBe('Task 10')
		expect(context.trail?.items).toEqual([])
	})

	it('turns the same column into nested record groups once the parent page is loaded', () => {
		const loaded = board({7: [...phaseSteps, 10, 1], 8: [201, 202, 20]}, edges, [101, 102])
		const index = indexBoardHierarchy(loaded)
		const column = trees(loaded, index).get(7)!

		expect(shape(column)).toBe(`t1[t10[${phaseSteps.map(id => `t${id}`).join(',')}]]`)
		// 27 siblings: progress comes from the phase's own subtask list, not from what one page showed.
		expect(directSubtaskProgress(index, 10)).toEqual({done: 2, total: 27})
		expect(directSubtaskProgress(index, 1)).toEqual({done: 0, total: 2})
		expect(directSubtaskProgress(index, 101)).toEqual({done: 0, total: 0})
	})

	it('reflects a completed child in its parent progress', () => {
		const before = indexBoardHierarchy(board({7: [10, 101, 102]}, [[10, 101], [10, 102]]))
		const after = indexBoardHierarchy(board({7: [10, 101, 102]}, [[10, 101], [10, 102]], [102]))
		expect(directSubtaskProgress(before, 10)).toEqual({done: 0, total: 2})
		expect(directSubtaskProgress(after, 10)).toEqual({done: 1, total: 2})
	})

	it('keeps children in their own column and gives a lone cross-column child a full trail instead of a header', () => {
		const columns = board({7: [101, 102, 10, 1], 8: [103, 201], 9: [104, 105]}, [...edges, [20, 104]])
		const index = indexBoardHierarchy(columns)
		const result = trees(columns, index)

		// 103 (phase 10) and 201 (phase 20) each stand alone in column 8: no single-row headers.
		expect(shape(result.get(8)!)).toBe('t103,t201')
		const lone = result.get(8)![0]
		expect(lone.trail?.items.map(task => task.id)).toEqual([1, 10])
		// Phase 20 is not loaded, but the loaded goal's own subtask list still places it.
		expect(result.get(8)![1].trail?.items.map(task => task.id)).toEqual([1, 20])
		expect(shape(result.get(9)!)).toBe('c10(t104,t105)')
		const context = result.get(9)![0]
		expect(context.kind === 'context' && context.trail.items.map(task => task.id)).toEqual([1])
		expect(index.loaded.get(10)?.buckets).toEqual([7])
	})

	it('places groups where their first card sits and keeps the column order inside groups', () => {
		const columns = board({7: [301, 201, 302, 202, 303]}, [[30, 301], [30, 302], [30, 303], [20, 201], [20, 202]])
		expect(shape(trees(columns).get(7)!)).toBe('c30(t301,t302,t303),c20(t201,t202)')
	})

	it('shows a child matched by a filter under its parent summary without turning the parent into a card', () => {
		const columns = board({7: [101, 102]}, edges)
		const index = indexBoardHierarchy(columns)
		const column = trees(columns, index).get(7)!

		expect(treeTaskIds(column)).toEqual([101, 102])
		expect(index.loaded.has(10)).toBe(false)
		expect(index.known.get(10)?.title).toBe('Task 10')
	})

	it('renders every loaded card exactly once per column with cycles and shared children', () => {
		const tricky: Edge[] = [[1, 2], [2, 3], [3, 1], [4, 5], [6, 5], [5, 7], [7, 4], [8, 8], [9, 99]]
		const columns = board({1: [1, 2, 3, 4, 2], 2: [5, 6, 7, 8, 9]}, tricky)
		const result = trees(columns)

		expect(treeTaskIds(result.get(1)!).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
		expect(treeTaskIds(result.get(2)!).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9])
	})

	it('keeps a card in every filter column that returned it, with relations from whichever copy has them', () => {
		const columns = board({1: [10, 101, 102], 2: [101, 103]}, [[10, 101], [10, 102], [10, 103]])
		// Only one duplicate copy carries relations, as the API enriches a single copy per task id.
		columns[1].tasks = columns[1].tasks.map(task => task.id === 101 ? {id: 101, title: 'Task 101'} : task)
		const index = indexBoardHierarchy(columns)
		const result = trees(columns, index)

		expect(index.loaded.get(101)?.buckets).toEqual([1, 2])
		expect(shape(result.get(1)!)).toBe('t10[t101,t102]')
		expect(shape(result.get(2)!)).toBe('c10(t101,t103)')
		const [shared] = result.get(2)![0].children
		expect(shared.kind === 'task' && shared.task).toBe(columns[1].tasks[0])
	})

	it('keeps the group id of a parent when it turns from context into a loaded card', () => {
		const before = trees(board({7: [101, 102]}, edges)).get(7)!
		const after = trees(board({7: [101, 102, 10]}, edges)).get(7)!
		expect(before[0].kind).toBe('context')
		expect(after[0].kind).toBe('task')
		expect(treeGroupIds(before)).toEqual(treeGroupIds(after))
	})

	it('chooses one deterministic parent for a shared child and names the others', () => {
		const shared: Edge[] = [[6, 5], [4, 5]]
		const forward = indexBoardHierarchy(board({1: [4, 5, 6]}, shared))
		const reversed = indexBoardHierarchy(board({1: [6, 5, 4]}, [...shared].reverse()))

		expect(forward.displayParent.get(5)).toBe(4)
		expect(reversed.displayParent.get(5)).toBe(4)
		expect(otherParents(forward, 5).map(task => task.id)).toEqual([6])
	})

	it('focuses a family through real relations, including a child shown under another parent', () => {
		const shared: Edge[] = [[4, 5], [6, 5], [6, 8], [5, 9], [1, 6]]
		const columns = board({1: [4, 5, 8], 2: [9, 6, 1]}, shared)
		const index = indexBoardHierarchy(columns)

		expect([...focusFamily(index, 6)].sort((a, b) => a - b)).toEqual([5, 6, 8, 9])
		const focused = focusHierarchy(index, 6)
		const family = focusFamily(index, 6)
		const shown = new Map(columns.map(column => [
			column.id,
			columnTree(focused, column.tasks.filter(task => family.has(task.id!))),
		]))
		// In focus, 5 groups under 6 (not its usual parent 4) and the trail stops at the focused task.
		expect(shape(shown.get(1)!)).toBe('c6(t5,t8)')
		expect(shape(shown.get(2)!)).toBe('t9,t6')
		expect(shown.get(2)![0].trail?.items.map(task => task.id)).toEqual([6, 5])
		expect(shown.get(2)![1].trail).toBeNull()
		expect(hierarchyTrail(focused, 9).items.map(task => task.id)).toEqual([6, 5])
		expect(hierarchyTrail(index, 9).items.map(task => task.id)).toEqual([4, 5])
		// Shown under the focused branch, the shared child names its usual parent; the focused task names none.
		expect(otherParents(focused, 5).map(task => task.id)).toEqual([4])
		expect(otherParents(focused, 6)).toEqual([])
	})

	it('stops trails on cycles and very deep chains', () => {
		const chain: Edge[] = range(1, 11).map(id => [id + 1, id] as Edge)
		const index = indexBoardHierarchy(board({1: range(1, 12)}, chain))
		const trail = hierarchyTrail(index, 1)
		expect(trail.truncated).toBe(true)
		expect(trail.items).toHaveLength(8)
		expect(trail.items.at(-1)?.id).toBe(2)

		const cyclic = indexBoardHierarchy(board({1: [1, 2]}, [[1, 2], [2, 1]]))
		expect(hierarchyTrail(cyclic, 1).items.length + hierarchyTrail(cyclic, 2).items.length).toBe(1)
	})

	it('lists collapsible groups and handles empty columns', () => {
		const columns = board({1: [10, 101, 102, 201, 202], 2: []}, edges)
		const result = trees(columns)
		expect(treeGroupIds(result.get(1)!)).toEqual([10, 20])
		expect(result.get(2)).toEqual([])
	})

	it('ignores ordinary relations, self relations and parents the API did not return', () => {
		const columns: HierarchyColumn<Task>[] = [{
			id: 1,
			tasks: [
				{id: 1, related_tasks: {related: [{id: 2}], parenttask: [{id: 1}]}},
				{id: 2},
			],
		}]
		expect(shape(trees(columns).get(1)!)).toBe('t1,t2')
	})
})
