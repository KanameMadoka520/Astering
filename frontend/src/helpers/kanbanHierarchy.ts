import type {Task} from '@/client/generated'
import {chooseDisplayParents} from './taskHierarchy'

/**
 * Display-only grouping for a kanban board. It never changes relations, positions, buckets or done states, and it
 * never invents records: relation summaries from loaded cards only provide titles and context for headers.
 */

export type HierarchyColumn<T extends Task> = {id: number, tasks: readonly T[]}

export type HierarchyIndex<T extends Task> = {
	/**
	 * Each loaded card with every column that returned it: buckets of a filter-configured view are independent
	 * queries, so one task can legitimately sit in several of them.
	 */
	loaded: ReadonlyMap<number, {task: T, buckets: readonly number[]}>
	/** The loaded card, else the first relation summary seen. Summaries are context, never actionable cards. */
	known: ReadonlyMap<number, Task>
	parents: ReadonlyMap<number, readonly number[]>
	children: ReadonlyMap<number, readonly number[]>
	displayParent: ReadonlyMap<number, number>
	/** On a focused index: the focused task and the parent it shows under on the whole board. */
	focus?: {task: number, parent: number | undefined}
}

export type Trail = {items: Task[], truncated: boolean}

/**
 * `key` tells record and context nodes apart for rendering. `group` is the id of the task the children belong to,
 * the same whether that parent is a card here or only context, so a collapsed group stays collapsed when its
 * parent card arrives with a later page.
 */
export type KanbanTreeNode<T extends Task> =
	| {kind: 'task', key: string, group: number, task: T, children: KanbanTreeNode<T>[], trail: Trail | null}
	| {kind: 'context', key: string, group: number, parent: Task, children: KanbanTreeNode<T>[], trail: Trail}

export type SubtaskProgress = {done: number, total: number}

const MAX_TRAIL = 8

function append<K>(map: Map<K, number[]>, key: K, id: number) {
	const list = map.get(key)
	if (list) list.push(id)
	else map.set(key, [id])
}

export function indexBoardHierarchy<T extends Task>(columns: readonly HierarchyColumn<T>[]): HierarchyIndex<T> {
	const loaded = new Map<number, {task: T, buckets: number[]}>()
	const known = new Map<number, Task>()
	for (const column of columns) {
		for (const task of column.tasks) {
			if (typeof task.id !== 'number') continue
			const entry = loaded.get(task.id)
			if (!entry) {
				loaded.set(task.id, {task, buckets: [column.id]})
				known.set(task.id, task)
			} else if (!entry.buckets.includes(column.id)) entry.buckets.push(column.id)
		}
	}
	const parents = new Map<number, Set<number>>()
	const children = new Map<number, Set<number>>()
	const link = (parent: number | undefined, child: number | undefined) => {
		if (parent === undefined || child === undefined || parent === child) return
		if (!parents.has(child)) parents.set(child, new Set())
		if (!children.has(parent)) children.set(parent, new Set())
		parents.get(child)!.add(parent)
		children.get(parent)!.add(child)
	}
	const remember = (summary: Task) => {
		if (typeof summary.id === 'number' && !known.has(summary.id)) known.set(summary.id, summary)
	}
	// Every copy: the API may enrich only one of a task's duplicate copies with its relations.
	for (const task of columns.flatMap(column => column.tasks)) {
		for (const parent of task.related_tasks?.parenttask ?? []) {
			remember(parent)
			link(parent.id, task.id)
		}
		for (const child of task.related_tasks?.subtask ?? []) {
			remember(child)
			link(task.id, child.id)
		}
	}
	const sorted = (map: Map<number, Set<number>>) =>
		new Map([...map].map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)]))
	return {
		loaded,
		known,
		parents: sorted(parents),
		children: sorted(children),
		displayParent: chooseDisplayParents(parents),
	}
}

/** The task and everything below it through real relations (every parent of a shared child counts). */
export function focusFamily(index: HierarchyIndex<Task>, focus: number): Set<number> {
	const family = new Set([focus])
	const queue = [focus]
	while (queue.length) {
		for (const child of index.children.get(queue.shift()!) ?? []) {
			if (family.has(child)) continue
			family.add(child)
			queue.push(child)
		}
	}
	return family
}

/** Same index with display parents chosen inside the family, so a shared child groups under the focused branch. */
export function focusHierarchy<T extends Task>(index: HierarchyIndex<T>, focus: number): HierarchyIndex<T> {
	const family = focusFamily(index, focus)
	const candidates = new Map<number, number[]>()
	for (const id of family) {
		if (id !== focus) candidates.set(id, (index.parents.get(id) ?? []).filter(parent => family.has(parent)))
	}
	// The focused task gets no candidates, so trails stop at it.
	return {
		...index,
		displayParent: chooseDisplayParents(candidates),
		focus: {task: focus, parent: index.displayParent.get(focus)},
	}
}

/**
 * Done/total of the task's direct subtasks, or null while its card is not loaded: only a loaded card carries the
 * complete (accessible) subtask list, so progress for a parent known from a child's summary would be a guess.
 */
export function directSubtaskProgress(index: HierarchyIndex<Task>, id: number): SubtaskProgress | null {
	if (!index.loaded.has(id)) return null
	const ids = index.children.get(id) ?? []
	return {done: ids.filter(child => index.known.get(child)?.done === true).length, total: ids.length}
}

/** Ancestors above the task, outermost first, along display parents. */
export function hierarchyTrail(index: HierarchyIndex<Task>, id: number): Trail {
	const items: Task[] = []
	const seen = new Set([id])
	let current = index.displayParent.get(id)
	while (current !== undefined && !seen.has(current)) {
		if (items.length === MAX_TRAIL) return {items, truncated: true}
		seen.add(current)
		items.unshift(index.known.get(current) ?? {id: current})
		current = index.displayParent.get(current)
	}
	return {items, truncated: false}
}

/** Relation summaries of the parents the card is not grouped under. */
export function otherParents(index: HierarchyIndex<Task>, id: number): Task[] {
	// The focused task's usual parent is in the focus bar's trail, so it is not an "other" one.
	const shown = index.displayParent.get(id) ?? (index.focus?.task === id ? index.focus.parent : undefined)
	return (index.parents.get(id) ?? [])
		.filter(parent => parent !== shown)
		.map(parent => index.known.get(parent) ?? {id: parent})
}

/**
 * One column as a forest, every card of `tasks` exactly once (the column's own copies). A card nests under its
 * display parent when that parent is a card in the same list; other cards sharing an absent parent gather under a
 * context header, unless there is only one of them, which then carries the parent as a trail instead. Groups sit
 * where their first card sits, so the column's own order is kept.
 */
export function columnTree<T extends Task>(
	index: HierarchyIndex<T>,
	tasks: readonly T[],
): KanbanTreeNode<T>[] {
	const order = new Map<number, number>()
	const cards = new Map<number, T>()
	for (const task of tasks) {
		const id = task.id
		if (typeof id !== 'number' || order.has(id)) continue
		order.set(id, order.size)
		cards.set(id, task)
	}
	const nested = new Map<number, number[]>()
	// Keyed by the absent display parent; undefined holds cards without any parent.
	const roots = new Map<number | undefined, number[]>()
	for (const id of order.keys()) {
		const parent = index.displayParent.get(id)
		if (parent !== undefined && order.has(parent)) append(nested, parent, id)
		else append(roots, parent, id)
	}
	const first = new Map<number, number>()
	const firstOf = (id: number): number => {
		if (!first.has(id)) {
			first.set(id, Math.min(order.get(id)!, ...(nested.get(id) ?? []).map(firstOf)))
		}
		return first.get(id)!
	}
	const byFirst = (ids: readonly number[]) => [...ids].sort((a, b) => firstOf(a) - firstOf(b))
	const taskNode = (id: number, trail: Trail | null): KanbanTreeNode<T> => ({
		kind: 'task',
		key: `t${id}`,
		group: id,
		task: cards.get(id)!,
		trail,
		children: byFirst(nested.get(id) ?? []).map(child => taskNode(child, null)),
	})
	const top: {first: number, node: KanbanTreeNode<T>}[] = []
	for (const [parent, members] of roots) {
		if (parent === undefined) {
			for (const id of members) top.push({first: firstOf(id), node: taskNode(id, null)})
			continue
		}
		const above = hierarchyTrail(index, parent)
		const parentRecord = index.known.get(parent) ?? {id: parent}
		if (members.length === 1) {
			const trail = {items: [...above.items, parentRecord], truncated: above.truncated}
			top.push({first: firstOf(members[0]), node: taskNode(members[0], trail)})
			continue
		}
		const sortedMembers = byFirst(members)
		top.push({
			first: firstOf(sortedMembers[0]),
			node: {
				kind: 'context',
				key: `c${parent}`,
				group: parent,
				parent: parentRecord,
				trail: above,
				children: sortedMembers.map(id => taskNode(id, null)),
			},
		})
	}
	return top.sort((a, b) => a.first - b.first).map(entry => entry.node)
}

/** Cards in the nodes, depth first, in display order. */
export function treeTaskIds(nodes: readonly KanbanTreeNode<Task>[]): number[] {
	return nodes.flatMap(node => [
		...(node.kind === 'task' ? [node.task.id!] : []),
		...treeTaskIds(node.children),
	])
}

/** Group ids of nodes that can collapse, i.e. that have children. */
export function treeGroupIds(nodes: readonly KanbanTreeNode<Task>[]): number[] {
	return nodes.flatMap(node => node.children.length ? [node.group, ...treeGroupIds(node.children)] : [])
}
