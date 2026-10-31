import {describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {computed} from 'vue'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import en from '@/i18n/lang/en.json'
import type {BucketResponse} from '@/client/queries/kanban'
import {normalizeTask, type TaskResponse} from '@/client/queries/tasks'
import {columnTree, indexBoardHierarchy} from '@/helpers/kanbanHierarchy'
import {kanbanTreeKey, type KanbanTreeContext} from './kanbanTreeContext'

const doneToggle = vi.hoisted(() => ({toggle: vi.fn(async () => {})}))
vi.mock('@/composables/useTaskDoneToggle', () => ({
	useTaskDoneToggle: () => ({
		isRoutine: () => false,
		isComplete: (task: TaskResponse) => task.done,
		toggle: doneToggle.toggle,
	}),
}))

import KanbanColumnTree from './KanbanColumnTree.vue'

const summary = (id: number, done = false) => ({id, title: id === 10 ? 'Phase ten' : `Step ${id}`, done})
const step = (id: number, done = false) => normalizeTask({
	...summary(id, done),
	project_id: 1,
	related_tasks: {parenttask: [summary(10)]},
})
const phase = normalizeTask({
	...summary(10),
	project_id: 1,
	related_tasks: {subtask: [summary(1, true), summary(2), summary(3)]},
})

function bucket(id: number, title: string, tasks: TaskResponse[], extra: Partial<BucketResponse> = {}): BucketResponse {
	return {id, title, tasks, count: tasks.length, limit: 0, position: id, ...extra}
}

function setup(columnTasks: TaskResponse[], options: {
	others?: BucketResponse[]
	collapsed?: string[]
	canComplete?: boolean
	props?: Record<string, unknown>
} = {}) {
	const buckets = [bucket(1, 'Editing', columnTasks), ...(options.others ?? [])]
	const index = indexBoardHierarchy(buckets)
	const context: KanbanTreeContext = {
		index: computed(() => index),
		buckets: computed(() => buckets),
		doneBucketId: computed(() => 3),
		canMove: computed(() => true),
		canComplete: () => options.canComplete ?? true,
		focusId: computed(() => null),
		isCollapsed: (bucketId, group) => (options.collapsed ?? []).includes(`${bucketId}:${group}`),
		toggleCollapsed: vi.fn(),
		focus: vi.fn(),
		move: vi.fn(async () => {}),
		recurringDone: vi.fn(),
	}
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', component: {render: () => null}},
			{path: '/tasks/:id', name: 'task.detail', component: {render: () => null}},
		],
	})
	const wrapper = mount(KanbanColumnTree, {
		props: {
			bucketId: 1,
			nodes: columnTree(index, columnTasks),
			hidden: 0,
			focused: false,
			loaded: columnTasks.length,
			count: columnTasks.length,
			loading: false,
			...options.props,
		},
		global: {
			plugins: [createI18n({legacy: false, locale: 'en', messages: {en}}), router],
			provide: {[kanbanTreeKey as symbol]: context},
			stubs: {Icon: {template: '<i />'}},
			directives: {tooltip: () => {}},
		},
	})
	return {wrapper, context}
}

describe('grouped kanban column', () => {
	it('labels a header for a parent that is not loaded as context, without inventing progress', () => {
		const {wrapper, context} = setup([step(1, true), step(2)])
		const header = wrapper.get('.kanban-tree-context')

		expect(header.text()).toContain('Context')
		expect(header.text()).toContain('Parent card is not among the loaded cards')
		expect(header.text()).toContain('Progress unavailable')
		expect(header.text()).toContain('2 cards here')
		expect(header.text()).not.toMatch(/\d+\/\d+ done/)

		const toggle = header.get('button[aria-expanded]')
		expect(toggle.attributes('aria-expanded')).toBe('true')
		expect(toggle.attributes('aria-label')).toBe('Collapse subtasks of Phase ten')
		expect(wrapper.find(`#${toggle.attributes('aria-controls')}`).exists()).toBe(true)
		toggle.trigger('click')
		expect(context.toggleCollapsed).toHaveBeenCalledWith(1, 10)
	})

	it('keeps a collapsed group closed but still says how many cards it holds', () => {
		const {wrapper} = setup([step(1), step(2)], {collapsed: ['1:10']})
		const toggle = wrapper.get('.kanban-tree-context button[aria-expanded]')

		expect(toggle.attributes('aria-expanded')).toBe('false')
		expect(toggle.attributes('aria-controls')).toBeUndefined()
		expect(wrapper.findAll('.kanban-tree-row')).toHaveLength(0)
		expect(wrapper.text()).toContain('2 cards here')
	})

	it('uses the loaded parent card as the group header with its exact direct progress', () => {
		const {wrapper, context} = setup([step(2), phase, step(3)])
		const header = wrapper.get('[data-tree-task="10"]')

		expect(wrapper.find('.kanban-tree-context').exists()).toBe(false)
		expect(header.classes()).toContain('is-group')
		expect(header.text()).toContain('1 of 3 direct subtasks done')
		expect(header.text()).toContain('2 cards here')
		expect(wrapper.findAll('.kanban-tree-children [data-tree-task]').map(row => row.attributes('data-tree-task'))).toEqual(['2', '3'])

		const focus = header.get('[data-focus-target="10"]')
		expect(focus.attributes('aria-label')).toBe('Focus on Phase ten')
		focus.trigger('click')
		expect(context.focus).toHaveBeenCalledWith(10)
	})

	it('completes through the shared toggle, or only shows the state without write access', async () => {
		const {wrapper, context} = setup([step(1, true), step(2)])
		const check = wrapper.get('[data-tree-task="2"] [role="checkbox"]')
		expect(check.attributes('aria-checked')).toBe('false')
		expect(check.attributes('aria-label')).toBe('Mark Step 2 as done')
		await check.trigger('click')
		expect(doneToggle.toggle).toHaveBeenCalledWith(expect.objectContaining({id: 2}), context.recurringDone)

		const readOnly = setup([step(1, true)], {canComplete: false}).wrapper
		expect(readOnly.find('[role="checkbox"]').exists()).toBe(false)
		expect(readOnly.get('.kanban-tree-check').attributes('aria-label')).toBe('Completed')
	})

	it('moves through a labelled native select that refuses full columns and names the done column', async () => {
		const others = [bucket(2, 'Review', [], {limit: 1, count: 1}), bucket(3, 'Published', [])]
		const {wrapper, context} = setup([step(1)], {others})
		const select = wrapper.get<HTMLSelectElement>('[data-tree-task="1"] select')

		expect(select.attributes('aria-label')).toBe('Move Step 1 to another column')
		const options = select.findAll('option')
		expect(options.map(option => option.text())).toEqual(['In Editing', 'Review (full)', 'Published (marks done)'])
		expect(options[1].attributes('disabled')).toBeDefined()

		select.element.value = '3'
		await select.trigger('change')
		await flushPromises()
		expect(context.move).toHaveBeenCalledWith(expect.objectContaining({id: 1}), 1, 3)
		// The select keeps showing where the card is until the board itself moves it.
		expect(select.element.value).toBe('1')
	})

	it('offers explicit paging and explains cards hidden by a focus', async () => {
		const {wrapper} = setup([step(1), step(2)], {props: {loaded: 25, count: 35, focused: true, hidden: 4}})
		expect(wrapper.text()).toContain('25 of 35 loaded')
		expect(wrapper.text()).toContain('4 loaded cards are outside the focus')
		await wrapper.get('.kanban-tree-more button').trigger('click')
		expect(wrapper.emitted('loadMore')).toHaveLength(1)

		const empty = setup([], {props: {focused: true, hidden: 3}}).wrapper
		expect(empty.text()).toContain('No loaded card of this group is in this column.')
	})
})
