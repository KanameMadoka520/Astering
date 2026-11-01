import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {normalizeTask, taskKeys} from '@/client/queries/tasks'

const sdk = vi.hoisted(() => ({patchTasksRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn(), getErrorText: (e: Error) => e.message}))
vi.mock('vue-router', async original => ({...await original<typeof import('vue-router')>(), useRouter: () => ({resolve: () => ({href: '/'})})}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
import Heading from './Heading.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	vi.clearAllMocks()
})

function setup() {
	const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	const task = normalizeTask({id: 3, project_id: 1, title: 'Old title', attachments: []})
	client.setQueryData(taskKeys.detail(3), task)
	wrapper = mount(Heading, {
		props: {task, canWrite: true, hasClose: false},
		global: {
			plugins: [createPinia(), [VueQueryPlugin, {queryClient: client}]],
			stubs: {Icon: true, CustomTransition: true, ColorBubble: true, Done: true},
			mocks: {$t: (key: string) => key},
			directives: {tooltip: {}},
		},
	})
	return wrapper
}

describe('Heading flush', () => {
	it('sends a title that is still being typed and reports nothing to send otherwise', async () => {
		sdk.patchTasksRead.mockResolvedValue({data: {id: 3, title: 'New title'}})
		const view = setup()
		await flushPromises()
		const vm = view.vm as unknown as {flush: () => Promise<string>}
		expect(await vm.flush()).toBe('none')

		const title = view.find('h1')
		title.element.textContent = 'New title'
		await title.trigger('input')
		expect(await vm.flush()).toBe('saved')
		expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
		expect(sdk.patchTasksRead.mock.calls[0][0].body).toEqual([{op: 'add', path: '/title', value: 'New title'}])
	})

	it('reports a failed title save', async () => {
		sdk.patchTasksRead.mockRejectedValue(new Error('nope'))
		const view = setup()
		await flushPromises()
		const title = view.find('h1')
		title.element.textContent = 'Another'
		await title.trigger('input')
		expect(await (view.vm as unknown as {flush: () => Promise<string>}).flush()).toBe('failed')
	})
})
