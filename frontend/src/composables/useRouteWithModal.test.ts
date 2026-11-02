import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {defineComponent, h, onMounted, ref, type VNode} from 'vue'
import {
	createRouter,
	createWebHistory,
	onBeforeRouteLeave,
	onBeforeRouteUpdate,
	RouterView,
	type Router,
} from 'vue-router'

vi.mock('@/stores/base', () => ({useBaseStore: () => ({currentProjectId: 0})}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
vi.mock('@/message', () => ({error: vi.fn()}))
import {useRouteWithModal} from './useRouteWithModal'
import {taskModalNavigationState} from '@/helpers/taskModal'
import {useUnsavedLeaveGuard} from './useUnsavedLeaveGuard'
import {error} from '@/message'

let wrapper: VueWrapper | undefined
let router: Router
let guardCalls: string[] = []
let backdropMounts = 0
let taskMounts = 0
let blockTask = true
let blockBackdrop = true
let fieldGuardMode = false
let fieldGuard: ReturnType<typeof useUnsavedLeaveGuard>
const fieldsDirty = ref(false)

const Backdrop = defineComponent({
	setup() {
		onMounted(() => backdropMounts++)
		onBeforeRouteLeave(() => {guardCalls.push('backdrop:leave'); return !blockBackdrop})
		onBeforeRouteUpdate(() => {guardCalls.push('backdrop:update'); return !blockBackdrop})
		return () => h('input', {class: 'backdrop'})
	},
})
const Task = defineComponent({
	props: {taskId: Number, backdropView: String},
	setup(props) {
		onMounted(() => taskMounts++)
		if (fieldGuardMode) {
			fieldGuard = useUnsavedLeaveGuard(fieldsDirty)
			return () => h('input', {class: 'task', 'data-task': props.taskId})
		}
		onBeforeRouteLeave(() => {guardCalls.push(`task:${props.taskId}:leave`); return !blockTask})
		onBeforeRouteUpdate(() => {guardCalls.push(`task:${props.taskId}:update`); return !blockTask})
		return () => h('input', {class: 'task', 'data-task': props.taskId})
	},
})

async function setup(
	backdropView = '/projects/1',
	nativeFields = false,
	lazyBackdrop?: () => Promise<typeof Backdrop>,
) {
	fieldGuardMode = nativeFields
	fieldsDirty.value = nativeFields
	guardCalls = []
	backdropMounts = 0
	taskMounts = 0
	blockTask = true
	blockBackdrop = true
	window.history.replaceState(null, '', '/start')
	router = createRouter({
		history: createWebHistory(),
		routes: [
			{path: '/start', component: {render: () => null}},
			{path: '/projects/:id', component: Backdrop},
			{path: '/calendar', component: lazyBackdrop ?? Backdrop},
			{path: '/tasks/:id', alias: '/task-alias/:id', name: 'task.detail', component: () => Promise.resolve(Task), props: route => ({taskId: Number(route.params.id)})},
			{path: '/elsewhere', component: {template: '<p>Elsewhere</p>'}},
		],
	})
	if (!lazyBackdrop && backdropView && !backdropView.startsWith('/tasks/') && !backdropView.startsWith('/task-alias/')) await router.push(backdropView)
	await router.push({path: '/tasks/1', state: backdropView ? {backdropView} : undefined})
	const Host = defineComponent({
		setup() {
			const {routeWithModal, currentModal, closeModal} = useRouteWithModal()
			return () => h('main', [
				h(RouterView, {route: routeWithModal.value}),
				currentModal.value ? h(currentModal.value as VNode) : null,
				h('button', {onClick: closeModal}, 'close'),
			])
		},
	})
	wrapper = mount(Host, {global: {plugins: [router]}})
	await flushPromises()
	return wrapper
}

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	router?.options.history.destroy()
	window.history.replaceState(null, '', '/')
	vi.restoreAllMocks()
})

describe('real route modal guards', () => {
	it('loads a previously unvisited lazy backdrop for a direct task modal URL', async () => {
		let resolveBackdrop!: (component: typeof Backdrop) => void
		const lazy = vi.fn(() => new Promise<typeof Backdrop>(resolve => {resolveBackdrop = resolve}))
		const view = await setup('/calendar?date=2026-11-03&zoom=250', false, lazy)
		expect(lazy).toHaveBeenCalledTimes(1)
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(view.findAll('input.backdrop')).toHaveLength(0)
		expect(view.text()).not.toContain('[object Promise]')
		resolveBackdrop(Backdrop)
		await flushPromises()
		expect(view.findAll('input.backdrop')).toHaveLength(1)
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(backdropMounts).toBe(1)
		expect(taskMounts).toBe(1)
		blockTask = false
		await router.push('/calendar?date=2026-11-03&zoom=250')
		await flushPromises()
		expect(backdropMounts).toBe(1)
		expect(view.findAll('input.task')).toHaveLength(0)
	})

	it.each(['navigate', 'unmount'])('ignores late backdrop loading after %s', async outcome => {
		let resolveBackdrop!: (component: typeof Backdrop) => void
		const view = await setup('/calendar', false, () => new Promise(resolve => {resolveBackdrop = resolve}))
		if (outcome === 'navigate') {
			blockTask = false
			await router.push('/elsewhere')
			await flushPromises()
		} else {
			view.unmount()
			wrapper = undefined
		}
		resolveBackdrop(Backdrop)
		await flushPromises()
		expect(backdropMounts).toBe(0)
		if (outcome === 'navigate') expect(view.text()).toContain('Elsewhere')
	})

	it('keeps the task usable and reports a failed lazy backdrop load once', async () => {
		let rejectBackdrop!: (cause: Error) => void
		const view = await setup('/calendar', false, () => new Promise((_, reject) => {rejectBackdrop = reject}))
		const cause = new Error('Failed to load calendar chunk')
		rejectBackdrop(cause)
		await flushPromises()
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(view.findAll('input.backdrop')).toHaveLength(0)
		expect(view.text()).not.toContain('[object Promise]')
		expect(error).toHaveBeenCalledWith(cause)
	})

	it.each(['/tasks/2', '/elsewhere'])('guards %s in the modal without calling the live backdrop guards', async destination => {
		const view = await setup()
		await view.find('input.backdrop').setValue('backdrop state')
		const taskRecord = router.currentRoute.value.matched[0]
		expect(taskRecord.leaveGuards.size).toBe(1)
		expect(taskRecord.updateGuards.size).toBe(1)
		await router.push(destination)
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(guardCalls).toEqual([destination.startsWith('/tasks/') ? 'task:1:update' : 'task:1:leave'])
		expect(view.find<HTMLInputElement>('input.backdrop').element.value).toBe('backdrop state')
		expect(backdropMounts).toBe(1)
	})

	it('keeps the modal across hash/query changes and unregisters its guards on unmount', async () => {
		const view = await setup()
		await view.find('input.task').setValue('modal draft')
		blockTask = false
		const taskRecord = router.currentRoute.value.matched[0]
		await router.push({hash: '#comment-5'})
		await flushPromises()
		await router.push({query: {view: 'compact'}})
		await flushPromises()
		expect(taskMounts).toBe(1)
		expect(view.find<HTMLInputElement>('input.task').element.value).toBe('modal draft')
		expect(guardCalls).toEqual(['task:1:update', 'task:1:update'])
		expect(window.history.state.backdropView).toBe('/projects/1')
		wrapper!.unmount()
		wrapper = undefined
		await flushPromises()
		expect(taskRecord.leaveGuards.size).toBe(0)
		expect(taskRecord.updateGuards.size).toBe(0)
		guardCalls = []
		await router.push('/elsewhere')
		expect(guardCalls).toEqual([])
	})

	it.each(['/tasks/9', '/task-alias/9'])('never mounts a second task record for stale backdrop %s', async backdrop => {
		const view = await setup(backdrop)
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(taskMounts).toBe(1)
		expect(view.find('input.task').attributes('data-task')).toBe('1')
		const taskRecord = router.currentRoute.value.matched[0]
		expect(taskRecord.leaveGuards.size).toBe(1)
		expect(taskRecord.updateGuards.size).toBe(1)
		await router.push('/tasks/2')
		expect(guardCalls).toEqual(['task:1:update'])
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
	})

	it.each(['/projects/1', ''])('task links preserve the original %j presentation and have one active task guard', async backdrop => {
		const view = await setup(backdrop)
		blockTask = false
		await router.push({name: 'task.detail', params: {id: 2}, state: taskModalNavigationState(router.currentRoute.value)})
		await flushPromises()
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(view.find('input.task').attributes('data-task')).toBe('2')
		expect(view.findAll('input.backdrop')).toHaveLength(backdrop ? 1 : 0)
		expect(taskMounts).toBe(1)
		expect(guardCalls).toEqual(['task:1:update'])
		guardCalls = []
		blockTask = true
		await router.push('/elsewhere')
		expect(guardCalls).toEqual(['task:2:leave'])
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
	})

	it('honors a full-page same-task entry on browser back instead of inheriting the modal', async () => {
		const view = await setup('')
		blockTask = false
		const originalState = {...window.history.state}
		await router.push({hash: '#modal', state: {backdropView: '/projects/1'}})
		await flushPromises()
		expect(view.findAll('input.backdrop')).toHaveLength(1)
		const navigation = new Promise<void>(resolve => {
			const stop = router.afterEach(() => {stop(); resolve()})
		})
		router.back()
		await navigation
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(view.findAll('input.backdrop')).toHaveLength(0)
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(window.history.state).toEqual({...originalState, forward: '/tasks/1#modal'})
	})

	it('close and browser forward restore the original board and modal without leaking guards', async () => {
		const view = await setup()
		await view.find('input.backdrop').setValue('board state')
		blockTask = false
		const taskRecord = router.currentRoute.value.matched[0]
		const closed = new Promise<void>(resolve => {
			const stop = router.afterEach(() => {stop(); resolve()})
		})
		await view.find('button').trigger('click')
		await closed
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/projects/1')
		expect(view.findAll('input.task')).toHaveLength(0)
		expect(view.find<HTMLInputElement>('input.backdrop').element.value).toBe('board state')
		expect(taskRecord.leaveGuards.size).toBe(0)
		expect(taskRecord.updateGuards.size).toBe(0)
		blockBackdrop = false
		const reopened = new Promise<void>(resolve => {
			const stop = router.afterEach(() => {stop(); resolve()})
		})
		router.forward()
		await reopened
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(view.find<HTMLInputElement>('input.backdrop').element.value).toBe('board state')
		expect(taskRecord.leaveGuards.size).toBe(1)
		expect(taskRecord.updateGuards.size).toBe(1)
		expect(backdropMounts).toBe(1)
	})

	it('the real task-field guard resumes in the modal and still protects the next task', async () => {
		const view = await setup('/projects/1', true)
		await router.push({name: 'task.detail', params: {id: 2}, state: {backdropView: '/projects/1'}})
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(fieldGuard.leaveTarget.value).toBe('/tasks/2')
		await fieldGuard.discardAndLeave()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(view.findAll('input.backdrop')).toHaveLength(1)
		expect(view.findAll('input.task')).toHaveLength(1)
		expect(taskMounts).toBe(1)
		fieldsDirty.value = false
		await flushPromises()
		fieldsDirty.value = true
		await router.push('/elsewhere')
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(fieldGuard.leaveTarget.value).toBe('/elsewhere')
	})

	it('explicit null backdrop opts out of the active task modal', async () => {
		const view = await setup()
		blockTask = false
		await router.push({name: 'task.detail', params: {id: 2}, state: {backdropView: null}})
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(view.findAll('input.backdrop')).toHaveLength(0)
		expect(view.findAll('input.task')).toHaveLength(1)
	})

	it.each(['cancel', 'throw'])('a %s from another guard re-arms the original unsaved form', async outcome => {
		await setup('/projects/1', true)
		await router.push('/tasks/2')
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		const cause = new Error('navigation failed')
		const remove = router.beforeEach(() => {
			if (outcome === 'throw') throw cause
			return false
		})
		const unhandled = vi.fn()
		const stopErrors = router.onError(unhandled)
		if (outcome === 'throw') await expect(fieldGuard.discardAndLeave()).rejects.toBe(cause)
		else await fieldGuard.discardAndLeave()
		remove()
		stopErrors()
		await router.push('/elsewhere')
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(fieldGuard.leaveTarget.value).toBe('/elsewhere')
	})
})
