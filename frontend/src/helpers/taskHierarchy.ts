import type {Task} from '@/client/generated'

export type TaskHierarchy<T extends Task = Task> = {roots: T[]; children: Map<number, T[]>}

/**
 * One display parent per task: the lowest candidate id that does not close a cycle. Children are visited in id
 * order, so the choice only depends on the relations, never on the order tasks were loaded or listed in.
 */
export function chooseDisplayParents(candidates: ReadonlyMap<number, Iterable<number>>): Map<number, number> {
	const parentOf = new Map<number, number>()
	for (const child of [...candidates.keys()].sort((a, b) => a - b)) {
		for (const parent of [...new Set(candidates.get(child))].sort((a, b) => a - b)) {
			if (parent === child) continue
			let ancestor: number | undefined = parent
			while (ancestor !== undefined && ancestor !== child) ancestor = parentOf.get(ancestor)
			if (ancestor === child) continue
			parentOf.set(child, parent)
			break
		}
	}
	return parentOf
}

/** A display forest, not a change to relations: one location per task, including cyclic legacy data. */
export function buildTaskHierarchy<T extends Task>(tasks: readonly T[]): TaskHierarchy<T> {
	const byId = new Map(tasks.filter(task => typeof task.id === 'number').map(task => [task.id!, task]))
	const candidates = new Map<number, Set<number>>()
	const add = (parent: number | undefined, child: number | undefined) => {
		if (parent === undefined || child === undefined || parent === child || !byId.has(parent) || !byId.has(child)) return
		if (!candidates.has(child)) candidates.set(child, new Set())
		candidates.get(child)!.add(parent)
	}
	for (const task of tasks) {
		for (const parent of task.related_tasks?.parenttask ?? []) add(parent.id, task.id)
		for (const child of task.related_tasks?.subtask ?? []) add(task.id, child.id)
	}
	const parentOf = chooseDisplayParents(candidates)
	const children = new Map<number, T[]>()
	const roots: T[] = []
	for (const task of byId.values()) {
		const parent = parentOf.get(task.id!)
		if (parent === undefined) roots.push(task)
		else {
			if (!children.has(parent)) children.set(parent, [])
			children.get(parent)!.push(task)
		}
	}
	return {roots, children}
}
