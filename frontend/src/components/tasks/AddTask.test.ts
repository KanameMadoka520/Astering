import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const quickAdd = vi.hoisted(() => ({
	ensureLabelsExist: vi.fn(),
	createNewTasksBulk: vi.fn(),
	findProjectId: vi.fn(),
}))
vi.mock('@/composables/useQuickAddTask', async () => {
	const {ref} = await import('vue')
	return {
		reportSkippedLabels: vi.fn(),
		useQuickAddTask: () => ({...quickAdd, isLoading: ref(false)}),
	}
})
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))

import AddTask from './AddTask.vue'

let wrapper: VueWrapper | undefined

async function setup() {
	const router = createRouter({history: createMemoryHistory(), routes: [{path: '/projects/:projectId/:viewId', name: 'project.view', component: {render: () => null}}]})
	await router.push('/projects/1/1')
	wrapper = mount(AddTask, {
		global: {
			plugins: [createPinia(), router, [VueQueryPlugin, {queryClient: new QueryClient()}]],
			directives: {focus: {}},
			mocks: {$t: (key: string) => key},
			stubs: {
				Icon: true,
				QuickAddMagic: true,
				Expandable: {template: '<div><slot /></div>'},
				XButton: {template: '<button class="add-task-button" @click="$emit(\'click\')"><slot /></button>', emits: ['click']},
			},
		},
		attachTo: document.body,
	})
	await flushPromises()
	return wrapper
}

async function typeAndEnter(view: VueWrapper, text: string) {
	const field = view.get('textarea')
	await field.setValue(text)
	await field.trigger('keydown', {key: 'Enter'})
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
	return {promise, resolve, reject}
}

beforeEach(() => {
	setActivePinia(createPinia())
	Object.values(quickAdd).forEach(fn => fn.mockReset())
	quickAdd.findProjectId.mockResolvedValue(1)
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	document.body.innerHTML = ''
})

describe('AddTask', () => {
	it('creates the task once when Enter is pressed again while its labels are looked up', async () => {
		const labels = deferred<{labels: [], skipped: []}>()
		quickAdd.ensureLabelsExist.mockReturnValue(labels.promise)
		quickAdd.createNewTasksBulk.mockResolvedValue({tasks: [{id: 7, title: 'Buy milk'}], error: null})
		const view = await setup()

		await typeAndEnter(view, 'Buy milk *groceries')
		await view.get('textarea').trigger('keydown', {key: 'Enter'})
		await view.get('.add-task-button').trigger('click')
		labels.resolve({labels: [], skipped: []})
		await flushPromises()

		expect(quickAdd.ensureLabelsExist).toHaveBeenCalledTimes(1)
		expect(quickAdd.createNewTasksBulk).toHaveBeenCalledTimes(1)
	})

	it('keeps text typed while a failed create was running and puts the failed title back before it', async () => {
		quickAdd.ensureLabelsExist.mockResolvedValue({labels: [], skipped: []})
		const created = deferred<never>()
		quickAdd.createNewTasksBulk.mockReturnValue(created.promise)
		const view = await setup()

		await typeAndEnter(view, 'First idea')
		await flushPromises()
		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('')
		await view.get('textarea').setValue('Second idea')

		created.reject(new Error('NO_PROJECT'))
		await flushPromises()

		expect((view.get('textarea').element as HTMLTextAreaElement).value).toBe('First idea\nSecond idea')
	})
})
