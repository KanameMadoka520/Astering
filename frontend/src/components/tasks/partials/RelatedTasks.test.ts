import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

import en from '@/i18n/lang/en.json'
import Modal from '@/components/misc/Modal.vue'
import testid from '@/directives/testid'

const sdk = vi.hoisted(() => ({tasksRelationsDelete: vi.fn(), tasksRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
vi.mock('@/composables/useQuickAddTask', () => ({useQuickAddTask: () => ({createNewTask: vi.fn()})}))
vi.mock('@/composables/useTasks', async () => {
	const {ref} = await import('vue')
	return {useTasks: () => ({tasks: ref([]), isFetching: ref(false)})}
})

import RelatedTasks from './RelatedTasks.vue'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
let wrapper: VueWrapper | undefined

async function setup() {
	const router = createRouter({history: createMemoryHistory(), routes: [{path: '/tasks/:id', name: 'task.detail', component: {render: () => null}}]})
	await router.push('/tasks/1')
	wrapper = mount(RelatedTasks, {
		props: {
			taskId: 1,
			projectId: 1,
			editEnabled: true,
			initialRelatedTasks: {subtask: [{id: 2, title: 'Buy paint', project_id: 1, done: false}]},
		} as never,
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}]],
			components: {Modal},
			directives: {cy: testid, tooltip: {}, focus: {}},
			stubs: {
				Icon: true,
				Multiselect: true,
				QuickAddMagic: true,
				FancyCheckbox: true,
				XButton: {template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>', emits: ['click']},
			},
		},
		attachTo: document.body,
	})
	await flushPromises()
	return wrapper
}

function dialog() {
	return document.querySelector('dialog.modal-dialog')
}

function confirmButton() {
	return document.querySelector<HTMLButtonElement>('dialog [data-cy="modalPrimary"]')
}

beforeEach(() => {
	vi.stubGlobal('TESTING', true)
	setActivePinia(createPinia())
	document.body.innerHTML = ''
	Object.values(sdk).forEach(fn => fn.mockReset())
	sdk.tasksRead.mockResolvedValue({data: {id: 1, related_tasks: {}}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

describe('RelatedTasks removing a relation', () => {
	it('names the task, says what goes away and stays open when removing fails', async () => {
		sdk.tasksRelationsDelete.mockRejectedValueOnce(new Error('Server error'))
		const view = await setup()
		await view.find('.remove').trigger('click')
		await flushPromises()

		expect(dialog()?.textContent).toContain('Buy paint')
		expect(dialog()?.textContent).not.toContain('cannot be undone')
		expect(confirmButton()?.textContent).toContain('Remove relation')

		confirmButton()!.click()
		await flushPromises()
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()

		expect(sdk.tasksRelationsDelete).toHaveBeenCalledTimes(1)
		expect(dialog()).not.toBeNull()
		expect(dialog()?.textContent).toContain('Buy paint')
	})

	it('sends one request for a double click and closes once the relation is gone', async () => {
		let finish!: () => void
		sdk.tasksRelationsDelete.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
		const view = await setup()
		await view.find('.remove').trigger('click')
		await flushPromises()

		confirmButton()!.click()
		confirmButton()!.click()
		await flushPromises()
		expect(sdk.tasksRelationsDelete).toHaveBeenCalledTimes(1)
		expect(dialog()).not.toBeNull()

		finish()
		await flushPromises()
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()
		expect(dialog()).toBeNull()
	})
})
