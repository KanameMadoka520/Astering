import {afterEach, describe, expect, it} from 'vitest'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import ReminderPeriod from './ReminderPeriod.vue'

enableAutoUnmount(afterEach)
const translate = (key: string) => key

describe('relative reminder anchor preservation', () => {
	it('keeps an existing period-end anchor selectable and only permits before or at end', async () => {
		const wrapper = mount(ReminderPeriod, {
			props: {modelValue: {relative_to: 'routine_period_end', relative_period: -600, reminder: ''}},
			global: {mocks: {$t: translate}},
		})
		const selects = wrapper.findAll('select')
		expect(selects[2].element.value).toBe('routine_period_end')
		expect(selects[1].findAll('option').map(option => option.attributes('value'))).toEqual(['-1'])
		await wrapper.get('input').setValue('20')
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
			relative_to: 'routine_period_end',
			relative_period: -1200,
		})
	})

	it('preserves the sign when editing an ordinary reminder after its date', async () => {
		const wrapper = mount(ReminderPeriod, {
			props: {modelValue: {relative_to: 'due_date', relative_period: 600, reminder: ''}},
			global: {mocks: {$t: translate}},
		})
		expect(wrapper.findAll('select')[1].element.value).toBe('1')
		await wrapper.get('input').setValue('20')
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({relative_period: 1200})
	})
})
