import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {ApiError} from '@/client/problem'
import {normalizeTaskRoutine} from '@/helpers/taskRoutine'
import RoutineProgressControl from './RoutineProgressControl.vue'

const sdk = vi.hoisted(() => ({
	taskRoutineProgress: vi.fn(),
	taskRoutineRead: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string) => key,
		locale: {value: 'en'},
	}),
}))
const Button = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
enableAutoUnmount(afterEach)
afterEach(() => { window.API_URL = '' })
const routine = normalizeTaskRoutine({
	enabled: true,
	period: 'weekly',
	timezone: 'Asia/Shanghai',
	date: '2099-11-01',
	next_reset_at: '2099-11-08T00:00:00+08:00',
	revision: 2,
	schedule_key: 'schedule-a',
	current_amount: 1,
	target: 5,
})!

function mountProgress() {
	const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	const wrapper = mount(RoutineProgressControl, {
		props: {
			taskId: 3,
			routine,
			canEdit: true,
		},
		global: {
			plugins: [[VueQueryPlugin, {queryClient: client}]],
			stubs: {XButton: Button},
		},
	})
	return wrapper
}

describe('routine progress draft boundaries', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		window.API_URL = ''
	})

	it('retains the amount and blocks a draft when the period changes until explicitly adopted', async () => {
		const wrapper = mountProgress()
		await wrapper.get('input').setValue('3')
		await wrapper.setProps({routine: {...routine, date: '2099-11-08'}})
		await wrapper.get('form').trigger('submit')
		expect(sdk.taskRoutineProgress).not.toHaveBeenCalled()
		expect(wrapper.get('input').element.value).toBe('3')
		expect(wrapper.text()).toContain('routineSchedule.progressStale')
		sdk.taskRoutineRead.mockResolvedValue({data: {...routine, date: '2099-11-08'}})
		await wrapper.findAll('button').find(button => button.text() === 'routineSchedule.keepAmount')!.trigger('click')
		await flushPromises()
		sdk.taskRoutineProgress.mockResolvedValue({data: {id: 3, routine: {...routine, current_amount: 3}}})
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.taskRoutineProgress).toHaveBeenCalledWith({
			path: {task: 3},
			body: {date: '2099-11-08', revision: 2, amount: 3},
		})
	})

	it('retains the amount after a 409 and refreshes instead of reporting success', async () => {
		const wrapper = mountProgress()
		sdk.taskRoutineProgress.mockRejectedValue(new ApiError({status: 409, detail: 'Fixture revision conflict'}))
		sdk.taskRoutineRead.mockResolvedValue({data: {...routine, revision: 3}})
		await wrapper.get('input').setValue('3')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(wrapper.get('input').element.value).toBe('3')
		expect(wrapper.text()).toContain('routineSchedule.progressConflict')
		expect(sdk.taskRoutineRead).toHaveBeenCalledWith({path: {task: 3}})
	})

	it('does not replace a different task’s draft when an earlier save finishes', async () => {
		let finish!: (value: unknown) => void
		sdk.taskRoutineProgress.mockReturnValue(new Promise(resolve => { finish = resolve }))
		const wrapper = mountProgress()
		await wrapper.get('input').setValue('3')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		await wrapper.setProps({taskId: 4, routine: {...routine, schedule_key: 'schedule-b', current_amount: 0}})
		await wrapper.get('input').setValue('4')
		finish({data: {id: 3, routine: {...routine, current_amount: 3}}})
		await flushPromises()
		expect(wrapper.get('input').element.value).toBe('4')
		expect(wrapper.text()).not.toContain('routineSchedule.progressStale')
	})

	it('drops a late result after an API identity changes', async () => {
		let finish!: (value: unknown) => void
		sdk.taskRoutineProgress.mockReturnValue(new Promise(resolve => { finish = resolve }))
		const wrapper = mountProgress()
		await wrapper.get('input').setValue('3')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		window.API_URL = 'https://other.example/api/v2'
		finish({data: {id: 3, routine: {...routine, current_amount: 3}}})
		await flushPromises()
		expect(wrapper.get('input').element.value).toBe('3')
		expect(wrapper.find('[role="alert"]').exists()).toBe(false)
	})

	it('refuses to submit a draft captured for a different API scope', async () => {
		const wrapper = mountProgress()
		await wrapper.get('input').setValue('3')
		window.API_URL = 'https://other.example/api/v2'
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(sdk.taskRoutineProgress).not.toHaveBeenCalled()
		expect(wrapper.text()).toContain('routineSchedule.progressStale')
	})
})
