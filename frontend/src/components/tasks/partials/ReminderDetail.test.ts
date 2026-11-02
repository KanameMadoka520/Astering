import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import en from '@/i18n/lang/en.json'
import zh from '@/i18n/lang/zh-CN.json'
import ReminderDetail from './ReminderDetail.vue'

vi.mock('@/composables/useIsMobile', () => ({useIsMobile: () => false}))
vi.mock('@/helpers/time/formatDate', () => ({formatDisplayDate: (value: string) => value}))
const Button = defineComponent({
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
const Popup = defineComponent({
	setup: (_, {slots}) => () => h('div', [
		slots.trigger?.({toggle: () => {}, close: () => {}}),
		slots.content?.({isOpen: true, close: () => {}}),
	]),
})
enableAutoUnmount(afterEach)

function setup(offset = -300, locale = 'en', date = '2099-11-03T04:55:00Z') {
	return mount(ReminderDetail, {
		props: {
			modelValue: {id: 7, relative_to: 'routine_period_end', relative_period: offset, reminder: date},
			defaultRelativeTo: null,
		},
		global: {
			plugins: [createI18n({legacy: false, locale, messages: {en, 'zh-CN': zh}})],
			stubs: {Popup, Card: {template: '<div><slot /></div>'}, SimpleButton: Button, XButton: Button, DatepickerInline: true},
			directives: {tooltip: {}},
		},
	})
}

describe('period-end reminder editing', () => {
	it.each([
		['en', '5 minutes before the end of this routine period', 'notifies you only if the target has not been reached'],
		['zh-CN', '本期结束前5 分钟', '仅在尚未达标时提醒'],
	])('names the anchor and condition in %s without changing the reminder', (locale, label, condition) => {
		const wrapper = setup(-300, locale)
		expect(wrapper.text()).toContain(label)
		expect(wrapper.text()).toContain(condition)
		expect(wrapper.emitted('update:modelValue')).toBeUndefined()
	})

	it('shows the period-end label for a zero offset', () => {
		const wrapper = setup(0)
		expect(wrapper.text()).toContain('At the end of this routine period')
	})

	it('keeps a relative editor for a routine with no task dates and confirms the same anchor', async () => {
		const wrapper = setup()
		expect(wrapper.findComponent({name: 'DatepickerInline'}).exists()).toBe(false)
			expect(wrapper.get('input').element.value).toBe('5')
		const direction = wrapper.findAll('select')[1]
		expect(direction.findAll('option').map(option => option.attributes('value'))).toEqual(['-1'])
		await wrapper.get('input[type="number"]').setValue('10')
		await wrapper.findAll('button').find(button => button.text() === 'Confirm')!.trigger('click')
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
			relative_to: 'routine_period_end',
			relative_period: -600,
		})
	})

	it('marks an invalid historical projection as needing repair without replacing the anchor', () => {
		const wrapper = setup(-172800, 'en', '0001-01-01T00:00:00Z')
		expect(wrapper.get('[role="alert"]').text()).toContain('no valid time in the current period')
			expect(wrapper.find('input[type="number"]').exists()).toBe(true)
		expect(wrapper.emitted('update:modelValue')).toBeUndefined()
	})
})
