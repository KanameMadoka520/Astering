import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {mount, flushPromises} from '@vue/test-utils'
import {setActivePinia, createPinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createRouter, createMemoryHistory} from 'vue-router'
import {VueQueryPlugin, QueryClient} from '@tanstack/vue-query'

import QuickActions from '@/components/quick-actions/QuickActions.vue'
import {useBaseStore} from '@/stores/base'
import {normalizeProject, type ProjectResponse} from '@/client/queries/projects'
import en from '@/i18n/lang/en.json'

const sdk = vi.hoisted(() => ({
	teamsList: vi.fn(async () => ({data: {items: []}})),
	tasksList: vi.fn(async () => ({data: {items: []}})),
	labelsList: vi.fn(async () => ({data: {items: [], total_pages: 1}})),
	projectsList: vi.fn(async () => ({data: {items: [], total_pages: 1}})),
	projectsRead: vi.fn(async () => ({data: {id: 1, title: 'Test'}})),
	tasksCreate: vi.fn(),
}))

vi.mock('@/client/generated', () => sdk)

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

type OpenAt = 'afterMount' | 'beforeMount' | 'never'

// The app mounts QuickActions closed and opens it later, so 'afterMount' is the default.
async function mountQuickActions(
	project: ProjectResponse | null,
	{openAt = 'afterMount'}: {openAt?: OpenAt} = {},
) {
	const errors: unknown[] = []
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: {template: '<div />'}},
			{path: '/tasks/:id', name: 'task.detail', component: {template: '<div />'}},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push('/')
	await router.isReady()

	// The stores can only be created from within a component setup because the
	// base store itself calls useI18n().
	const Host = defineComponent({
		setup() {
			const baseStore = useBaseStore()
			baseStore.setCurrentProject(project)
			if (openAt === 'beforeMount') {
				baseStore.setQuickActionsActive(true)
			}
			return () => h(QuickActions)
		},
	})

	const wrapper = mount(Host, {
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient: new QueryClient()}]],
			stubs: {
				Modal: {template: '<div><slot /></div>'},
				QuickAddMagic: true,
				BaseButton: {template: '<a class="stub-button"><slot /></a>'},
				Icon: true,
				XLabel: true,
				SingleTaskInlineReadonly: true,
			},
			directives: {focus: {}},
			config: {
				errorHandler(err: unknown) {
					errors.push(err)
				},
			},
		},
		attachTo: document.body,
	})
	await flushPromises()
	if (openAt === 'afterMount') {
		useBaseStore().setQuickActionsActive(true)
		await flushPromises()
	}
	return {wrapper, errors, router}
}

async function chooseNewTask(wrapper: Awaited<ReturnType<typeof mountQuickActions>>['wrapper'], text: string) {
	const command = wrapper.findAll('.stub-button').find(button => button.text().includes('New task'))
	expect(command).toBeTruthy()
	await command!.trigger('click')
	await flushPromises()
	const input = wrapper.get('input.input')
	;(input.element as HTMLInputElement).value = text
	await input.trigger('input')
	return input
}

describe('QuickActions', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	it('mounts closed, as the app does, without an error', async () => {
		const {errors} = await mountQuickActions(null, {openAt: 'never'})

		expect(useBaseStore().quickActionsActive).toBe(false)
		expect(errors).toEqual([])
	})

	it('opens without a current project', async () => {
		const {wrapper, errors} = await mountQuickActions(null)

		expect(errors).toEqual([])
		expect(wrapper.find('.quick-actions').exists()).toBe(true)
	})

	it('opens with a current project', async () => {
		const {wrapper, errors} = await mountQuickActions(normalizeProject({id: 1, title: 'Test'}))

		expect(errors).toEqual([])
		expect(wrapper.find('.quick-actions').exists()).toBe(true)
	})

	it('prevents the Escape keydown default so closing does not leave fullscreen', async () => {
		const {wrapper, errors} = await mountQuickActions(null)

		const event = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})
		wrapper.get('input.input').element.dispatchEvent(event)
		await flushPromises()

		expect(errors).toEqual([])
		expect(event.defaultPrevented).toBe(true)
		expect(useBaseStore().quickActionsActive).toBe(false)
	})

	describe('creating from "New task"', () => {
		beforeEach(() => {
			sdk.tasksCreate.mockReset()
		})

		it('says a project is needed and keeps the text and the dialog when there is none', async () => {
			const {wrapper, errors} = await mountQuickActions(null)
			const input = await chooseNewTask(wrapper, 'Buy milk')
			await input.trigger('keydown', {key: 'Enter'})
			await flushPromises()

			expect(wrapper.get('[role="alert"]').text()).toBe('Please specify a project or set a default project in the settings.')
			expect((input.element as HTMLInputElement).value).toBe('Buy milk')
			expect(useBaseStore().quickActionsActive).toBe(true)
			expect(sdk.tasksCreate).not.toHaveBeenCalled()
			expect(errors).toEqual([])
		})

		it('creates once when Enter is pressed again while the first one is still saving', async () => {
			let finish!: (value: unknown) => void
			sdk.tasksCreate.mockImplementation(() => new Promise(resolve => {finish = resolve}))
			const {wrapper, router} = await mountQuickActions(normalizeProject({id: 1, title: 'Test'}))
			const input = await chooseNewTask(wrapper, 'Buy milk')
			await input.trigger('keydown', {key: 'Enter'})
			await input.trigger('keydown', {key: 'Enter'})
			await flushPromises()

			expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
			expect(useBaseStore().quickActionsActive).toBe(true)
			finish({data: {id: 42, title: 'Buy milk', project_id: 1}})
			await flushPromises()
			expect(useBaseStore().quickActionsActive).toBe(false)
			expect(router.currentRoute.value.name).toBe('task.detail')
		})

		it('never runs a hidden search result instead of creating the task', async () => {
			// "New team" also matches the command list, which is hidden while "New task" is chosen.
			sdk.tasksCreate.mockResolvedValue({data: {id: 43, title: 'New team', project_id: 1}})
			const {wrapper, router} = await mountQuickActions(normalizeProject({id: 1, title: 'Test'}))
			const input = await chooseNewTask(wrapper, 'New team')
			await flushPromises()
			await input.trigger('keydown', {key: 'Enter'})
			await flushPromises()

			expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
			expect(sdk.tasksCreate.mock.calls[0][0].body.title).toBe('New team')
			expect(router.currentRoute.value.name).toBe('task.detail')
		})

		it('drops the error, the typed text and the command once closed and opened again', async () => {
			const {wrapper, errors} = await mountQuickActions(null)
			const input = await chooseNewTask(wrapper, 'Buy milk')
			await input.trigger('keydown', {key: 'Enter'})
			await flushPromises()
			expect(wrapper.find('[role="alert"]').exists()).toBe(true)

			await input.trigger('keydown', {key: 'Escape'})
			await flushPromises()
			expect(useBaseStore().quickActionsActive).toBe(false)
			useBaseStore().setQuickActionsActive(true)
			await flushPromises()

			expect(wrapper.find('[role="alert"]').exists()).toBe(false)
			expect((wrapper.get('input.input').element as HTMLInputElement).value).toBe('')
			expect(wrapper.find('.active-cmd').exists()).toBe(false)
			expect(errors).toEqual([])
		})
	})

	describe('in quick-add mode', () => {
		let initialUrl = ''

		beforeEach(() => {
			initialUrl = window.location.href
			window.history.replaceState(null, '', '/?mode=quick-add')
		})

		afterEach(() => {
			window.history.replaceState(null, '', initialUrl)
		})

		it('starts on "New task" when opened after mounting', async () => {
			const {wrapper, errors} = await mountQuickActions(null)

			expect(wrapper.get('.active-cmd').text()).toBe('New task')
			expect(errors).toEqual([])
		})

		// quickActionsActive is store state that outlives the component, so it can mount already open.
		it('starts on "New task" when mounted already open', async () => {
			const {wrapper, errors} = await mountQuickActions(null, {openAt: 'beforeMount'})

			expect(wrapper.get('.active-cmd').text()).toBe('New task')
			expect(errors).toEqual([])
		})
	})
})
