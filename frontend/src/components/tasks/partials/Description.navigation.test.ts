import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {computed, defineComponent, h} from 'vue'
import {useRouteWithModal} from '@/composables/useRouteWithModal'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, createWebHistory, RouterView, useRoute, type Router} from 'vue-router'
import {normalizeTask, taskKeys} from '@/client/queries/tasks'
import {removeToken, saveToken} from '@/helpers/auth'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {scopedEditorDraftKey} from '@/helpers/editorDraftStorage'
import {clearAccountDrafts} from '@/helpers/localDrafts'

const sdk = vi.hoisted(() => ({patchTasksRead: vi.fn(), tasksRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn(), getErrorText: (cause: Error) => cause.message}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/components/input/AsyncEditor', () => ({default: {
	props: ['modelValue'],
	emits: ['update:modelValue'],
	template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/>',
}}))
vi.mock('@/stores/base', () => ({useBaseStore: () => ({currentProjectId: 0})}))
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projects: {}})}))
import Description from './Description.vue'

const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
const draftKey = () => `editorDraft-${scopedEditorDraftKey(editorDraftNamespace(), 'task-description-1')}`
const task = (id: number) => normalizeTask({id, project_id: 1, title: `Task ${id}`, description: 'original', attachments: []})
let wrapper: VueWrapper | undefined
let client: QueryClient
let router: Router

async function setup(portal = false, backdropView = '/') {
	saveToken(token(1), false)
	client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	client.setQueryData(taskKeys.detail(1), task(1))
	sdk.tasksRead.mockImplementation(({path}: {path: {task: number}}) => Promise.resolve({data: task(path.task)}))
	const TaskPage = defineComponent({
		setup() {
			const route = useRoute()
			const current = computed(() => task(Number(route.params.id)))
			return () => h(Description, {modelValue: current.value, canWrite: true})
		},
	})
	if (portal) window.history.replaceState(null, '', '/')
	router = createRouter({
		history: portal ? createWebHistory() : createMemoryHistory(),
		routes: [
			{path: '/', component: {template: '<p>Home</p>'}},
			{path: '/tasks/:id', name: 'task.detail', component: TaskPage, props: route => ({taskId: Number(route.params.id)})},
		],
	})
	await router.push({path: '/tasks/1', state: portal ? {backdropView} : undefined})
	const Host = defineComponent({
		setup() {
			const {routeWithModal, currentModal} = useRouteWithModal()
			return () => h('main', [
				h(RouterView, {route: routeWithModal.value}),
				currentModal.value,
			])
		},
	})
	wrapper = mount(portal ? Host : RouterView, {
		attachTo: document.body,
		global: {
			plugins: [createPinia(), router, [VueQueryPlugin, {queryClient: client}]],
			stubs: {Icon: true, CustomTransition: true},
			mocks: {$t: (key: string) => key},
		},
	})
	await flushPromises()
	return wrapper
}

function button(key: string) {
	return [...document.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(el => el.textContent?.trim() === key)!
}

afterEach(async () => {
	wrapper?.unmount()
	wrapper = undefined
	await flushPromises()
	client?.clear()
	router?.options.history.destroy()
	removeToken()
	localStorage.clear()
	window.API_URL = ''
	document.body.innerHTML = ''
	window.history.replaceState(null, '', '/')
	vi.restoreAllMocks()
	vi.resetAllMocks()
})

describe('failed description save navigation', () => {
	it('offers a focused safe choice instead of silently cancelling every navigation', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue('unsaved description')
		await router.push('/')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(document.querySelector('dialog[open]')?.textContent).toContain('task.description.leaveTitle')
		expect(document.activeElement).toBe(button('task.description.stay'))
		button('task.description.stay').click()
		await flushPromises()
		expect(view.find<HTMLTextAreaElement>('textarea').element.value).toBe('unsaved description')
		expect(localStorage.getItem(draftKey())).toBe('unsaved description')
	})

	it.each(['unsaved description', ''])('keeps %j and leaves without another failing unmount save', async text => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue(text)
		await router.push('/')
		await flushPromises()
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem(draftKey())).toBe(text)
		await router.push('/tasks/1')
		await flushPromises()
		expect(view.text()).toContain('task.description.draftFound')
	})

	it('keeps the old task draft when leaving through a param update', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue('task one draft')
		await router.push('/tasks/2')
		await flushPromises()
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(localStorage.getItem(draftKey())).toBe('task one draft')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})

	it.each([1, 2])('never resumes old navigation or rewrites a cleared draft after login as account %s', async accountId => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue('old text')
		await router.push('/')
		await flushPromises()
		const oldKey = draftKey()
		clearAccountDrafts({editor: editorDraftNamespace(), compass: ''})
		removeToken()
		saveToken(token(accountId), false)
		localStorage.setItem(oldKey, 'new editor text')
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(localStorage.getItem(oldKey)).toBe('new editor text')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})

	it('does not continue an old navigation after the API server changes', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue('old server text')
		await router.push('/')
		await flushPromises()
		const oldKey = draftKey()
		window.API_URL = 'https://other.example/api/v2'
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(localStorage.getItem(oldKey)).toBe('old server text')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})

	it('keeps the latest typing after a slower navigation save fails', async () => {
		let reject!: (cause: Error) => void
		sdk.patchTasksRead.mockReturnValue(new Promise((_resolve, fail) => {reject = fail}))
		const view = await setup()
		await view.find('textarea').setValue('submitted B')
		const navigation = router.push('/')
		await flushPromises()
		await view.find('textarea').setValue('latest C')
		reject(new Error('offline'))
		await navigation
		await flushPromises()
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/')
		expect(localStorage.getItem(draftKey())).toBe('latest C')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})

	it('does not claim the draft was kept when browser storage fails', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		await view.find('textarea').setValue('copy before leaving')
		await router.push('/')
		await flushPromises()
		localStorage.removeItem(draftKey())
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {throw new DOMException('Full', 'QuotaExceededError')})
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(document.querySelector('dialog[open] [role="alert"]')?.textContent).toContain('task.description.leaveStorageFailed')
		expect(localStorage.getItem(draftKey())).toBeNull()
		button('task.description.leaveAnyway').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})

	it('restores navigation protection if another guard refuses the selected destination', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup()
		let refuse = true
		router.beforeEach(to => to.path === '/' && refuse ? false : true)
		await view.find('textarea').setValue('keep safe')
		await router.push('/')
		await flushPromises()
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		refuse = false
		await router.push('/tasks/2')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(document.querySelector('dialog[open]')).not.toBeNull()
	})
})


describe('real Description in the task route modal', () => {
	it.each(['portal draft', ''])('uses real query saves and keeps %j when the modal navigation save fails', async text => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup(true)
		await view.find('textarea').setValue(text)
		await router.push('/')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
		expect(document.querySelector('dialog[open]')?.textContent).toContain('task.description.leaveTitle')
		expect(localStorage.getItem(draftKey())).toBe(text)
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem(draftKey())).toBe(text)
	})

	it('a stale task backdrop has one editor, protects its latest text and never saves a hidden previous task', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup(true, '/tasks/9')
		expect(view.findAll('textarea')).toHaveLength(1)
		await view.find('textarea').setValue('latest task one draft')
		await router.push('/tasks/2')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(view.findAll('textarea')).toHaveLength(1)
		expect(localStorage.getItem(draftKey())).toBe('latest task one draft')
		await router.push('/')
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
		expect(sdk.patchTasksRead.mock.calls[0][0].path.task).toBe(1)
	})
})


describe('failed task modal resume presentation', () => {
	it('keeps the original backdrop when Keep resumes a related-task URL without state', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
		const view = await setup(true)
		await view.find('textarea').setValue('failed task one draft')
		await router.push({name: 'task.detail', params: {id: 2}, state: {backdropView: '/'}})
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/1')
		button('task.description.keepAndLeave').click()
		await flushPromises()
		expect(router.currentRoute.value.fullPath).toBe('/tasks/2')
		expect(window.history.state.backdropView).toBe('/')
		expect(view.findAllComponents(RouterView)).toHaveLength(2)
		expect(view.findAll('textarea')).toHaveLength(1)
		expect(localStorage.getItem(draftKey())).toBe('failed task one draft')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
	})
})
