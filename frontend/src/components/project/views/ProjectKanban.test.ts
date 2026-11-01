import {shallowMount, flushPromises} from '@vue/test-utils'
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {createPinia} from 'pinia'
import {nextTick} from 'vue'
import draggable from 'zhyswan-vuedraggable'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {removeToken, saveToken} from '@/helpers/auth'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'

const sdk = vi.hoisted(() => ({
	projectViewBucketsTasksList: vi.fn(),
	projectViewTasksList: vi.fn(),
	bucketsUpdate: vi.fn(),
	bucketsDelete: vi.fn(),
	tasksCreate: vi.fn(),
}))
const {projectViewBucketsTasksList: loadBoard, projectViewTasksList: loadBucketPage, bucketsUpdate: updateBucket} = sdk

// Asymmetric positions: the midpoint between the neighbours must differ from the dragged bucket's own position.
const buckets = [
	{id: 1, title: 'First', position: 100, tasks: [{id: 11, title: 'Task 11'}], count: 1, limit: 0},
	{id: 2, title: 'Second', position: 250, tasks: [], count: 0, limit: 0},
	{id: 3, title: 'Third', position: 300, tasks: [], count: 0, limit: 0},
]

vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useCurrentProject', () => ({
	useCurrentProject: () => ({
		currentProject: {
			value: {
				id: 1,
				title: 'Test',
				max_permission: 2,
				views: [{id: 10, view_kind: 'kanban', bucket_configuration_mode: 'manual'}],
			},
		},
		isPending: {value: false},
	}),
}))

const drop = vi.hoisted(() => ({
	result: {moved: false, targetProjectId: null as number | null},
	task: {id: 11, title: 'Task 11'},
}))
vi.mock('@/composables/useTaskDragToProject', () => ({
	useTaskDragToProject: () => ({
		handleTaskDropToProject: async (
			_e: unknown,
			onSuccess?: (task: unknown, targetProjectId: number) => void,
		) => {
			if (drop.result.moved) onSuccess?.(drop.task, drop.result.targetProjectId!)
			return drop.result
		},
	}),
}))

vi.mock('@/stores/auth', () => ({
	useAuthStore: () => ({
		settings: {
			frontend_settings: {
				always_show_bucket_task_count: false,
				quick_add_magic_mode: 'vikunja',
				quick_add_default_reminders: [],
			},
		},
	}),
}))

vi.mock('@/client/queries/savedFilters', () => ({
	savedFilterQuery: (id: number) => ({
		queryKey: ['saved-filters', 'detail', id],
		queryFn: async () => null,
		enabled: false,
	}),
}))

vi.mock('@vueuse/router', () => ({
	useRouteQuery: () => ({value: undefined}),
}))

vi.mock('vue-router', () => ({
	useRouter: () => ({push: vi.fn(), currentRoute: {value: {fullPath: '/', params: {}}}}),
}))

vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import ProjectKanban from './ProjectKanban.vue'

let queryClient: QueryClient

async function mountKanban(stubs: Record<string, unknown> = {}, projectId = 1) {
	queryClient = new QueryClient()
	const wrapper = shallowMount(ProjectKanban, {
		props: {
			isLoadingProject: false,
			projectId,
			viewId: 10,
		},
		global: {
			plugins: [createPinia(), [VueQueryPlugin, {queryClient}]],
			mocks: {$t: (key: string) => key},
			directives: {focus: () => {}, tooltip: () => {}, cy: () => {}},
			stubs: {
				ProjectWrapper: {template: '<div><slot name="default"/></div>'},
				...stubs,
			},
		},
	})

	await flushPromises()
	return wrapper
}

// vuedraggable is stubbed away by shallowMount, but the add task control lives in its footer slot.
const DRAGGABLE_STUB = {
	props: ['modelValue'],
	template: '<ul><template v-for="(element, index) in modelValue"><slot name="item" :element="element" :index="index" /></template><slot name="footer" /></ul>',
}

function dragEndEvent(bucketId: string) {
	const item = document.createElement('li')
	item.dataset.bucketId = bucketId
	// The DOM index sortable reports does not have to be a valid bucket index
	return {item, newIndex: 42}
}

function taskDragEndEvent(taskId: number, bucketIndex = 0) {
	const item = document.createElement('li')
	item.dataset.taskId = String(taskId)
	const list = document.createElement('ul')
	list.dataset.bucketIndex = String(bucketIndex)
	return {item, to: list, from: list, originalEvent: new MouseEvent('mouseup'), newIndex: 0}
}

// The bucket draggable comes first, each bucket renders its own task draggable after it.
function taskDraggable(wrapper: Awaited<ReturnType<typeof mountKanban>>) {
	return wrapper.findAllComponents(draggable)[1]
}

function cachedBoard() {
	const entries = queryClient.getQueriesData<{
		buckets: {id: number, tasks: {id: number}[], count: number}[],
	}>({queryKey: ['kanban']})
	return entries[0][1]
}

describe('ProjectKanban', () => {
	beforeEach(() => {
		updateBucket.mockClear()
		updateBucket.mockResolvedValue({data: {id: 2, position: 200}})
		sdk.bucketsDelete.mockReset()
		sdk.bucketsDelete.mockResolvedValue({data: {}})
		loadBoard.mockClear()
		loadBoard.mockResolvedValue({data: {items: buckets}})
		loadBucketPage.mockClear()
		loadBucketPage.mockResolvedValue({data: {items: []}})
		sdk.tasksCreate.mockReset()
		drop.result = {moved: false, targetProjectId: null}
	})

	it('saves the position of the dropped bucket', async () => {
		const wrapper = await mountKanban()

		wrapper.findComponent(draggable).vm.$emit('end', dragEndEvent('2'))
		await flushPromises()

		expect(updateBucket).toHaveBeenCalledWith(expect.objectContaining({
			path: {project: 1, view: 10, bucket: 2},
			body: expect.objectContaining({position: 200}),
		}))
	})

	it('keeps the add bucket column while the board refetches in the background', async () => {
		const wrapper = await mountKanban()
		expect(wrapper.find('.new-bucket').exists()).toBe(true)

		loadBoard.mockReturnValue(new Promise(() => {}))
		queryClient.refetchQueries()
		await nextTick()

		expect(wrapper.find('.new-bucket').exists()).toBe(true)
	})

	it('does not load another bucket page while a task is dragged out of the bucket', async () => {
		const wrapper = await mountKanban()
		// The scroll handler is wired through vuedraggable's component-data, which the stub does not render.
		const vm = wrapper.vm as unknown as {
			updateTasks: (bucketId: number, tasks: unknown[]) => void,
			handleTaskContainerScroll: (id: number, el: HTMLElement) => void,
		}

		vm.updateTasks(1, [])
		vm.handleTaskContainerScroll(1, document.createElement('div'))
		await flushPromises()

		expect(loadBucketPage).not.toHaveBeenCalled()
	})

	it('marks the board as dragging while a task is dragged', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})
		const event = taskDragEndEvent(11)

		taskDraggable(wrapper).vm.$emit('start', event)
		await nextTick()
		expect(wrapper.find('.kanban').classes()).toContain('is-dragging')

		taskDraggable(wrapper).vm.$emit('end', event)
		await flushPromises()
		expect(wrapper.find('.kanban').classes()).not.toContain('is-dragging')
	})

	it('marks the board as dragging while a bucket is dragged', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})

		wrapper.findAllComponents(draggable)[0].vm.$emit('start')
		await nextTick()
		expect(wrapper.find('.kanban').classes()).toContain('is-dragging')

		wrapper.findAllComponents(draggable)[0].vm.$emit('end', dragEndEvent('2'))
		await flushPromises()
		expect(wrapper.find('.kanban').classes()).not.toContain('is-dragging')
	})

	it('does not refetch the board after a task was dropped on another project', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})
		drop.result = {moved: true, targetProjectId: 2}
		loadBoard.mockClear()

		taskDraggable(wrapper).vm.$emit('end', taskDragEndEvent(11))
		await flushPromises()

		expect(loadBoard).not.toHaveBeenCalled()
	})

	it('drops the card from a saved filter board when the task moved to another project', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB}, -2)
		drop.result = {moved: true, targetProjectId: 2}

		taskDraggable(wrapper).vm.$emit('end', taskDragEndEvent(11))
		await flushPromises()

		expect(cachedBoard()?.buckets[0].tasks).toEqual([])
		expect(cachedBoard()?.buckets[0].count).toBe(0)
	})

	it('leaves a real project board to the mutation when the task moved to another project', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})
		drop.result = {moved: true, targetProjectId: 2}

		taskDraggable(wrapper).vm.$emit('end', taskDragEndEvent(11))
		await flushPromises()

		expect(cachedBoard()?.buckets[0].tasks).toHaveLength(1)
		expect(cachedBoard()?.buckets[0].count).toBe(1)
	})

	it('re-enables the add task input once the create settles, without a board request', async () => {
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})
		let resolveCreate!: (value: unknown) => void
		sdk.tasksCreate.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve }))

		;(wrapper.vm as unknown as {toggleShowNewTaskInput: (id: number) => void}).toggleShowNewTaskInput(1)
		await nextTick()
		await wrapper.find('.bucket-footer input').setValue('New task')
		await wrapper.find('.bucket-footer input').trigger('keyup.enter')
		await flushPromises()
		expect(wrapper.find('.bucket-footer input').attributes('disabled')).toBeDefined()

		loadBoard.mockClear()
		resolveCreate({data: {id: 12, title: 'New task', project_id: 1, bucket_id: 1}})
		await flushPromises()

		expect(wrapper.find('.bucket-footer input').attributes('disabled')).toBeUndefined()
		expect(loadBoard).not.toHaveBeenCalled()
	})

	it('closes the add task input when the created task fills the bucket limit', async () => {
		loadBoard.mockResolvedValue({data: {items: [{...buckets[0], count: 1, limit: 2}, buckets[1], buckets[2]]}})
		sdk.tasksCreate.mockResolvedValue({data: {id: 12, title: 'New task', project_id: 1, bucket_id: 1}})
		const wrapper = await mountKanban({BucketDraggable: DRAGGABLE_STUB, TaskDraggable: DRAGGABLE_STUB})

		;(wrapper.vm as unknown as {toggleShowNewTaskInput: (id: number) => void}).toggleShowNewTaskInput(1)
		await nextTick()
		await wrapper.find('.bucket-footer input').setValue('New task')
		await wrapper.find('.bucket-footer input').trigger('keyup.enter')
		await flushPromises()

		expect(wrapper.find('.bucket-footer input').exists()).toBe(false)
	})

	it('does nothing when the dropped bucket is gone', async () => {
		const wrapper = await mountKanban()

		wrapper.findComponent(draggable).vm.$emit('end', dragEndEvent('42'))

		expect(updateBucket).not.toHaveBeenCalled()
	})

	describe('bucket deletion confirmation identity', () => {
		let wrapper: Awaited<ReturnType<typeof mountKanban>> | undefined
		let previousApiUrl: string

		function accountToken(id: number) {
			return `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
		}

		beforeEach(() => {
			previousApiUrl = window.API_URL
			removeToken()
			window.API_URL = ''
			saveToken(accountToken(1), false)
		})

		afterEach(() => {
			wrapper?.unmount()
			wrapper = undefined
			queryClient.clear()
			removeToken()
			window.API_URL = previousApiUrl
		})

		async function openConfirmation() {
			wrapper = await mountKanban({
				Modal: {name: 'Modal', props: ['enabled'], template: '<div />'},
			})
			const vm = wrapper.vm as unknown as {
				deleteBucketModal: (id: number) => void,
				deleteBucket: () => Promise<void>,
				newTaskText: string,
				newBucketTitle: string,
				showNewTaskInput: number | null,
				showNewBucketInput: boolean,
				showSetLimitInput: boolean,
			}
			vm.deleteBucketModal(2)
			await nextTick()
			return {vm, modal: wrapper.findComponent({name: 'Modal'})}
		}

		const requestContextChanges = [
			{name: 'account identity', change: () => saveToken(accountToken(2), false)},
			{name: 'API server', change: () => { window.API_URL = 'https://other.example' }},
			{name: 'session epoch', change: () => {
				removeToken()
				saveToken(accountToken(1), false)
			}},
		]

		it.each(requestContextChanges)('rejects an old confirmation after the $name changes without navigation', async ({change}) => {
			const {vm, modal} = await openConfirmation()
			const request = captureClientRequestContext()
			change()
			expect(isClientRequestContextCurrent(request)).toBe(false)

			await vm.deleteBucket()
			await nextTick()
			expect(sdk.bucketsDelete).not.toHaveBeenCalled()
			expect(modal.props('enabled')).toBe(false)
		})

		it.each(requestContextChanges)('leaves the new confirmation alone when an old response arrives after the $name changes', async ({change}) => {
			let resolveDelete!: (value: unknown) => void
			sdk.bucketsDelete.mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve }))
			const {vm, modal} = await openConfirmation()
			const deletion = vm.deleteBucket()
			await flushPromises()
			expect(sdk.bucketsDelete).toHaveBeenCalledOnce()

			change()
			vm.deleteBucketModal(2)
			await nextTick()
			resolveDelete({data: {}})
			await deletion
			await nextTick()
			expect(modal.props('enabled')).toBe(true)
			expect(sdk.bucketsDelete).toHaveBeenCalledOnce()
		})

		it('allows a refreshed token for the same account, session and API server', async () => {
			const {vm, modal} = await openConfirmation()
			const request = captureClientRequestContext()
			saveToken(`renewed.${btoa(JSON.stringify({id: 1, type: 1}))}.signature`, false)
			expect(isClientRequestContextCurrent(request)).toBe(true)
			await vm.deleteBucket()
			await nextTick()
			expect(sdk.bucketsDelete).toHaveBeenCalledOnce()
			expect(modal.props('enabled')).toBe(false)
		})

		it.each([
			{projectId: 2, viewId: 10},
			{projectId: 1, viewId: 20},
		])('clears the confirmation and board drafts before a stale submit on %j', async props => {
			const {vm, modal} = await openConfirmation()
			vm.newTaskText = 'Task on the old board'
			vm.newBucketTitle = 'Column on the old board'
			vm.showNewTaskInput = 2
			vm.showNewBucketInput = true
			vm.showSetLimitInput = true
			await wrapper!.setProps(props)

			// A late event from the old dialog must not address its bucket through the new route.
			await vm.deleteBucket()
			expect(sdk.bucketsDelete).not.toHaveBeenCalled()
			expect(modal.props('enabled')).toBe(false)
			expect(vm.newTaskText).toBe('')
			expect(vm.newBucketTitle).toBe('')
			expect(vm.showNewTaskInput).toBeNull()
			expect(vm.showNewBucketInput).toBe(false)
			expect(vm.showSetLimitInput).toBe(false)
		})

		it.each([
			{projectId: 2, viewId: 10},
			{projectId: 1, viewId: 20},
		])('does not close a new confirmation after navigating through %j and back', async props => {
			let resolveDelete!: (value: unknown) => void
			sdk.bucketsDelete.mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve }))
			const {vm, modal} = await openConfirmation()
			const deletion = vm.deleteBucket()
			await flushPromises()
			expect(sdk.bucketsDelete).toHaveBeenCalledWith(expect.objectContaining({
				path: {project: 1, view: 10, bucket: 2},
			}))

			await wrapper!.setProps(props)
			await wrapper!.setProps({projectId: 1, viewId: 10})
			vm.deleteBucketModal(2)
			await nextTick()
			expect(modal.props('enabled')).toBe(true)
			resolveDelete({data: {}})
			await deletion
			await nextTick()

			expect(modal.props('enabled')).toBe(true)
			expect(sdk.bucketsDelete).toHaveBeenCalledTimes(1)
		})

		it('keeps a replacement confirmation for the same bucket after the old response arrives', async () => {
			let resolveDelete!: (value: unknown) => void
			sdk.bucketsDelete.mockImplementationOnce(() => new Promise(resolve => { resolveDelete = resolve }))
			const {vm, modal} = await openConfirmation()
			const deletion = vm.deleteBucket()
			await flushPromises()
			modal.vm.$emit('close')
			vm.deleteBucketModal(2)
			await nextTick()
			resolveDelete({data: {}})
			await deletion
			await nextTick()
			expect(modal.props('enabled')).toBe(true)
		})

		it('ignores a late submit after the confirmation was cancelled', async () => {
			const {vm, modal} = await openConfirmation()
			modal.vm.$emit('close')
			await vm.deleteBucket()
			expect(sdk.bucketsDelete).not.toHaveBeenCalled()
		})

		it('keeps a failed confirmation available for retry and closes it only after success', async () => {
			sdk.bucketsDelete.mockRejectedValueOnce(new Error('Delete failed'))
			const {vm, modal} = await openConfirmation()
			await vm.deleteBucket()
			expect(modal.props('enabled')).toBe(true)
			await vm.deleteBucket()
			await nextTick()
			expect(modal.props('enabled')).toBe(false)
			expect(sdk.bucketsDelete).toHaveBeenCalledTimes(2)
		})
	})

	describe('bucket limit editing', () => {
		let wrapper: Awaited<ReturnType<typeof mountKanban>> | undefined

		beforeEach(() => {
			vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
			updateBucket.mockImplementation(async ({path, body}) => ({
				data: {
					id: path.bucket,
					...body,
				},
			}))
		})

		afterEach(() => {
			wrapper?.unmount()
			wrapper = undefined
			queryClient.clear()
			vi.useRealTimers()
		})

		async function editLimit(bucket = 2) {
			wrapper = await mountKanban({
				BucketDraggable: DRAGGABLE_STUB,
				TaskDraggable: DRAGGABLE_STUB,
				Dropdown: {template: '<div><slot :close="() => {}" /></div>'},
				DropdownItem: {template: '<button @click="$emit(\'click\', $event)"><slot /></button>'},
				XButton: {template: '<button @click="$emit(\'click\', $event)"><slot /></button>'},
			})
			const column = wrapper.get(`[data-bucket-id="${bucket}"]`)
			const open = column.findAll('button').find(button => button.text() === 'project.kanban.limit')
			expect(open).toBeDefined()
			await open!.trigger('click')
			return {
				input: column.get('input[type="number"]'),
				save: column.get('button[aria-label="misc.save"]'),
			}
		}

		it('saves the actual input of the selected bucket once and shows the saved limit', async () => {
			const {input, save} = await editLimit(2)
			await input.setValue('7')
			await save.trigger('click')
			await flushPromises()
			await vi.advanceTimersByTimeAsync(3000)

			expect(updateBucket).toHaveBeenCalledTimes(1)
			expect(updateBucket).toHaveBeenCalledWith(expect.objectContaining({
				path: {
					project: 1,
					view: 10,
					bucket: 2,
				},
				body: {
					title: 'Second',
					position: 250,
					limit: 7,
				},
			}))
			expect(wrapper!.get('[data-bucket-id="2"] .limit').text()).toContain('0/7')
			expect(wrapper!.find('[data-bucket-id="1"] .limit').exists()).toBe(false)
		})

		it('saves only the latest value after typing pauses', async () => {
			const {input} = await editLimit()
			await input.setValue('3')
			await vi.advanceTimersByTimeAsync(1500)
			await input.setValue('12')
			await vi.advanceTimersByTimeAsync(2499)
			expect(updateBucket).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			await flushPromises()
			expect(updateBucket).toHaveBeenCalledTimes(1)
			expect(updateBucket).toHaveBeenCalledWith(expect.objectContaining({
				body: expect.objectContaining({limit: 12}),
			}))
		})

		it('clears an existing limit with an empty input', async () => {
			loadBoard.mockResolvedValue({data: {items: buckets.map(bucket => ({...bucket, limit: 8}))}})
			const {input, save} = await editLimit()
			await input.setValue('')
			await save.trigger('click')
			await flushPromises()
			expect(updateBucket).toHaveBeenCalledWith(expect.objectContaining({
				body: expect.objectContaining({limit: 0}),
			}))
			expect(wrapper!.find('[data-bucket-id="2"] .limit').exists()).toBe(false)
		})

		it.each(['-1', '1.5', '1e100'])('never sends invalid capacity %s to the API', async value => {
			const {input, save} = await editLimit()
			await input.setValue(value)
			await save.trigger('click')
			await vi.advanceTimersByTimeAsync(3000)
			expect(updateBucket).not.toHaveBeenCalled()
		})

		it.each([
			{projectId: 2, viewId: 10},
			{projectId: 1, viewId: 20},
		])('drops the pending save when changing board to %j', async props => {
			const {input} = await editLimit()
			await input.setValue('9')
			await wrapper!.setProps(props)
			await vi.advanceTimersByTimeAsync(3000)
			expect(updateBucket).not.toHaveBeenCalled()
		})

		it('cancels a pending save when the board is closed', async () => {
			const {input} = await editLimit()
			await input.setValue('9')
			wrapper!.unmount()
			wrapper = undefined
			await vi.advanceTimersByTimeAsync(3000)
			expect(updateBucket).not.toHaveBeenCalled()
		})

		it('handles a failed autosave without an unhandled rejection', async () => {
			const {input} = await editLimit()
			updateBucket.mockRejectedValueOnce(new Error('Capacity save failed'))
			await input.setValue('9')
			await vi.advanceTimersByTimeAsync(3000)
			await flushPromises()
			expect(updateBucket).toHaveBeenCalledTimes(1)
			expect(wrapper!.find('[data-bucket-id="2"] .limit').exists()).toBe(false)
		})
	})

})
