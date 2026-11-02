import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {defineComponent, h, ref} from 'vue'
import {createMemoryHistory, createRouter, RouterView, type Router} from 'vue-router'
import {VueQueryPlugin} from '@tanstack/vue-query'

import {queryClient} from '@/client/queryClient'
import {normalizeProject, projectKeys} from '@/client/queries/projects'
import {removeToken, saveToken} from '@/helpers/auth'
import CalendarCreateDialog from './CalendarCreateDialog.vue'

const sdk = vi.hoisted(() => ({
	tasksCreate: vi.fn(),
	projectsList: vi.fn(),
}))
vi.mock('@/client/generated', async original => ({
	...await original<typeof import('@/client/generated')>(),
	...sdk,
}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('vue-i18n', async original => {
	const {ref} = await import('vue')
	return {
		...await original<typeof import('vue-i18n')>(),
		useI18n: () => ({
			t: (key: string) => key,
			locale: ref('en-US'),
		}),
	}
})

let wrapper: VueWrapper | undefined
let router: Router
const created = vi.fn()
const closed = vi.fn()
const defaultQueryOptions = queryClient.getDefaultOptions()
const token = (id: number, iat = 100) => `header.${btoa(JSON.stringify({
	id,
	type: 1,
	iat,
}))}.signature`

beforeEach(() => {
	removeToken()
	saveToken(token(1), false)
	queryClient.setDefaultOptions({
		queries: {
			retry: false,
			staleTime: Infinity,
		},
		mutations: {retry: false},
	})
	queryClient.setQueryData(projectKeys.list(), {
		projects: [
			normalizeProject({
				id: 1,
				title: 'Read only',
				max_permission: 0,
			}),
			normalizeProject({
				id: 2,
				title: 'Writable',
				max_permission: 1,
			}),
		],
		favoriteProject: null,
		savedFilterProjects: [],
	})
	sdk.tasksCreate.mockResolvedValue({data: {
		id: 41,
		project_id: 2,
		title: 'New arrangement',
	}})
})

afterEach(async () => {
	wrapper?.unmount()
	wrapper = undefined
	await flushPromises()
	queryClient.clear()
	queryClient.setDefaultOptions(defaultQueryOptions)
	router?.options.history.destroy()
	removeToken()
	localStorage.clear()
	window.API_URL = ''
	vi.clearAllMocks()
})

async function setup() {
	const CalendarHost = defineComponent({
		setup() {
			const open = ref(true)
			return () => h('main', open.value ? h(CalendarCreateDialog, {
				date: '2026-11-03',
				timezone: 'Asia/Shanghai',
				projectId: 2,
				onClose: () => {
					closed()
					open.value = false
				},
				onCreated: created,
			}) : h('p', {'data-calendar-closed': ''}, 'Calendar remains mounted'))
		},
	})
	router = createRouter({
		history: createMemoryHistory(),
		routes: [{
			path: '/calendar',
			component: CalendarHost,
		}],
	})
	await router.push('/calendar?date=2026-11-03')
	wrapper = mount(RouterView, {
		global: {
			plugins: [
				router,
				createPinia(),
				[VueQueryPlugin, {queryClient}],
			],
			mocks: {$t: (key: string) => key},
			stubs: {
				Icon: true,
				Modal: {template: '<section><slot /></section>'},
				UnsavedLeaveDialog: {
					props: ['open'],
					emits: ['stay', 'discard'],
					template: `<aside v-if="open">
						<button data-stay @click="$emit('stay')">Stay</button>
						<button data-discard @click="$emit('discard')">Discard</button>
					</aside>`,
				},
			},
		},
	})
	await flushPromises()
	await wrapper.get('input[maxlength="250"]').setValue('New arrangement')
	return wrapper
}

const changes = {
	account: () => saveToken(token(2), false),
	api: () => { window.API_URL = 'https://other.example/api/v2' },
	epoch: () => {
		removeToken()
		saveToken(token(1), false)
	},
}

describe('calendar creation draft ownership', () => {
	it('keeps the original owner between the submit handler and mutation execution', async () => {
		const view = await setup()
		let switched = false
		const unsubscribe = queryClient.getMutationCache().subscribe(event => {
			if (event.type !== 'updated' || event.action.type !== 'pending' || switched) return
			switched = true
			queueMicrotask(() => saveToken(token(2), false))
		})
		try {
			await view.get('form').trigger('submit')
			await flushPromises()
			expect(switched).toBe(true)
			expect(sdk.tasksCreate).not.toHaveBeenCalled()
			expect(created).not.toHaveBeenCalled()
		} finally {
			unsubscribe()
		}
	})

	it.each(['account', 'api', 'epoch'] as const)('rejects a draft submitted after its %s changes', async kind => {
		const view = await setup()
		changes[kind]()
		await view.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.tasksCreate).not.toHaveBeenCalled()
		expect(created).not.toHaveBeenCalled()
		expect(closed).toHaveBeenCalledTimes(1)
		expect(view.find('[data-calendar-closed]').exists()).toBe(true)
	})

	it.each(['account', 'api', 'epoch'] as const)('drops a late successful request after its %s changes', async kind => {
		let resolve!: (value: unknown) => void
		sdk.tasksCreate.mockImplementationOnce(() => new Promise(done => { resolve = done }))
		const view = await setup()
		await view.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
		changes[kind]()
		resolve({data: {
			id: 41,
			project_id: 2,
			title: 'New arrangement',
		}})
		await flushPromises()
		expect(created).not.toHaveBeenCalled()
		expect(closed).not.toHaveBeenCalled()
		expect(sdk.tasksCreate).toHaveBeenCalledTimes(1)
	})

	it('allows a normal token refresh and sends exact account-zone times through the real mutation', async () => {
		const view = await setup()
		saveToken(token(1, 200), false)
		await view.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.tasksCreate).toHaveBeenCalledExactlyOnceWith({
			path: {project: 2},
			fetch: expect.any(Function),
			body: {
				title: 'New arrangement',
				project_id: 2,
				start_date: '2026-11-03T01:00:00.000Z',
				end_date: '2026-11-03T02:00:00.000Z',
			},
		})
		expect(created).toHaveBeenCalledExactlyOnceWith(41)
	})

	it('stores typed notes as escaped task description paragraphs through the real mutation', async () => {
		const view = await setup()
		await view.get('textarea').setValue('Room <img src=x onerror="bad()">\nBring A & B')
		await view.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.tasksCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			body: expect.objectContaining({
				description: '<p>Room &lt;img src=x onerror="bad()"&gt;</p><p>Bring A &amp; B</p>',
			}),
		}))
		expect(created).toHaveBeenCalledExactlyOnceWith(41)
	})

	it('protects a notes-only draft when navigating to another date', async () => {
		const view = await setup()
		await view.get('input[maxlength="250"]').setValue('')
		await view.get('textarea').setValue('Keep this location note')
		await router.push('/calendar?date=2026-11-04')
		await flushPromises()
		expect(router.currentRoute.value.query.date).toBe('2026-11-03')
		expect(view.find('[data-stay]').exists()).toBe(true)
		await view.get('[data-stay]').trigger('click')
		await flushPromises()
		expect(view.get<HTMLTextAreaElement>('textarea').element.value).toBe('Keep this location note')
		expect(sdk.tasksCreate).not.toHaveBeenCalled()
	})

	it('closes the discarded draft after a guarded same-calendar query navigation', async () => {
		const view = await setup()
		await router.push('/calendar?date=2026-11-04')
		await flushPromises()
		expect(router.currentRoute.value.query.date).toBe('2026-11-03')
		expect(view.find('[data-discard]').exists()).toBe(true)
		await view.get('[data-stay]').trigger('click')
		await flushPromises()
		expect(view.get<HTMLInputElement>('input[maxlength="250"]').element.value).toBe('New arrangement')
		await router.push('/calendar?date=2026-11-04')
		await flushPromises()
		await view.get('[data-discard]').trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.query.date).toBe('2026-11-04')
		expect(view.findComponent(CalendarCreateDialog).exists()).toBe(false)
		expect(view.find('[data-calendar-closed]').exists()).toBe(true)
		expect(closed).toHaveBeenCalledTimes(1)
		expect(sdk.tasksCreate).not.toHaveBeenCalled()
	})
})
