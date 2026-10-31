import {describe, expect, it} from 'vitest'
import type {Task} from '@/client/generated'
import {columnTree, indexBoardHierarchy, treeTaskIds} from './kanbanHierarchy'

// A filter-configured board may legitimately return the same task in several columns.
// Display grouping must preserve these memberships rather than globally deduplicate cards.
describe('kanban hierarchy preserves server-decided column membership', () => {
	it('keeps a shared task once in each matching column', () => {
		const child: Task = {id: 2, title: 'A matching step', related_tasks: {parenttask: [{id: 1, title: 'Phase'}]}}
		const parent: Task = {id: 1, title: 'Phase', related_tasks: {subtask: [{id: 2, title: child.title}]}}
		const columns = [{id: 0, tasks: [child, parent]}, {id: 1, tasks: [parent, child]}]
		const index = indexBoardHierarchy(columns)
		for (const column of columns) {
			expect(treeTaskIds(columnTree(index, column.tasks)).sort()).toEqual([1, 2])
		}
	})

	it('uses relation information present on a later copy of a task', () => {
		const columns: {id: number, tasks: Task[]}[] = [
			{id: 1, tasks: [{id: 1, title: 'Phase'}, {id: 2, title: 'Step'}]},
			{id: 2, tasks: [{id: 1, title: 'Phase', related_tasks: {subtask: [{id: 2, title: 'Step'}]}}]},
		]
		const index = indexBoardHierarchy(columns)
		expect(index.children.get(1)).toEqual([2])
		expect(index.displayParent.get(2)).toBe(1)
	})

	it('keeps the actual column copy for row metadata', () => {
		const columns: {id: number, tasks: Task[]}[] = [
			{id: 1, tasks: [{id: 1, title: 'Shared', bucket_id: 1, position: 100}]},
			{id: 2, tasks: [{id: 1, title: 'Shared', bucket_id: 2, position: 900}]},
		]
		const nodes = columnTree(indexBoardHierarchy(columns), columns[1].tasks)
		expect(nodes).toHaveLength(1)
		expect(nodes[0].kind).toBe('task')
		if (nodes[0].kind === 'task') {
			expect(nodes[0].task.bucket_id).toBe(2)
			expect(nodes[0].task.position).toBe(900)
		}
	})
})
