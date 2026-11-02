import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import type {Task} from '@/client/generated'
import {removeToken, saveToken} from '@/helpers/auth'
import TaskAllDayDates from './TaskAllDayDates.vue'

vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key, locale: {value: 'en'}}),
}))
enableAutoUnmount(afterEach)
beforeEach(() => { window.API_URL = ''; removeToken() })
afterEach(() => { window.API_URL = ''; removeToken() })
const zero = '0001-01-01T00:00:00Z'
const task: Task = {id: 9, all_day: true, all_day_start: '2026-11-03', all_day_end: '2026-11-05', due_date: '2026-11-06T03:00:00Z'}
function setup(options: {task?: Task; timezone?: string; canWrite?: boolean; save?: (changes: Partial<Task>, id: number) => Promise<'saved' | 'failed' | 'none'>} = {}) {
	const save = options.save ?? vi.fn().mockResolvedValue('saved')
	const wrapper = mount(TaskAllDayDates, {props: {task, timezone: 'Asia/Shanghai', canWrite: true, ...options, save}})
	const click = async (key: string) => {
		const button = wrapper.findAll('button').find(item => item.text() === key)
		expect(button, key).toBeDefined()
		await button!.trigger('click')
	}
	return {wrapper, save, click}
}

describe('explicit all-day task editor', () => {
	it('edits an inclusive last day into an exclusive civil boundary without touching the deadline', async () => {
		const {wrapper, save, click} = setup()
		expect(wrapper.text()).toContain('2026-11-03 — 2026-11-04')
		await click('task.allDay.edit')
		const inputs = wrapper.findAll('input[type=date]')
		await inputs[1].setValue('2026-11-07')
		expect(wrapper.emitted('dirty')).toContainEqual([9, true])
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(save).toHaveBeenCalledWith({all_day: true, all_day_start: '2026-11-03', all_day_end: '2026-11-08', start_date: zero, end_date: zero}, 9)
		expect(wrapper.find('form').exists()).toBe(false)
		expect(wrapper.emitted('dirty')?.at(-1)).toEqual([9, false])
	})

	it('clears the schedule explicitly and preserves the draft after a failed save', async () => {
		const save = vi.fn().mockResolvedValue('failed')
		const {wrapper, click} = setup({save})
		await click('task.allDay.edit')
		await wrapper.findAll('input[type=date]')[1].setValue('2026-11-09')
		await click('task.allDay.clear')
		await flushPromises()
		expect(save).toHaveBeenCalledWith({all_day: false, all_day_start: '', all_day_end: '', start_date: zero, end_date: zero}, 9)
		expect(wrapper.get('[role=alert]').text()).toBe('task.allDay.saveFailed')
		expect((wrapper.findAll('input[type=date]')[1].element as HTMLInputElement).value).toBe('2026-11-09')
		await click('misc.cancel')
		expect(wrapper.emitted('dirty')?.at(-1)).toEqual([9, false])
	})

	it('converts timed dates using the account civil date, clearing both old instants', async () => {
		const {wrapper, save, click} = setup({task: {id: 10, start_date: '2026-11-02T18:00:00Z', end_date: '2026-11-03T01:00:00Z'}})
		await click('task.allDay.create')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(save).toHaveBeenCalledWith({all_day: true, all_day_start: '2026-11-03', all_day_end: '2026-11-04', start_date: zero, end_date: zero}, 10)
	})

	it('never invents conversion times and resolves explicitly chosen wall times in the account zone', async () => {
		const {wrapper, save, click} = setup()
		await click('task.allDay.edit')
		await click('task.allDay.toTimed')
		await wrapper.get('form').trigger('submit')
		expect(save).not.toHaveBeenCalled()
		expect(wrapper.get('[role=alert]').text()).toBe('task.allDay.timedRequired')
		const inputs = wrapper.findAll('input[type=datetime-local]')
		await inputs[0].setValue('2026-11-03T09:30')
		await inputs[1].setValue('2026-11-03T10:30')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(save).toHaveBeenCalledWith({all_day: false, all_day_start: '', all_day_end: '', start_date: '2026-11-03T01:30:00.000Z', end_date: '2026-11-03T02:30:00.000Z'}, 9)
	})

	it('rejects a DST gap and requires an explicit offset during a repeated hour', async () => {
		const {wrapper, save, click} = setup({timezone: 'America/New_York'})
		await click('task.allDay.edit')
		await click('task.allDay.toTimed')
		const inputs = wrapper.findAll('input[type=datetime-local]')
		await inputs[0].setValue('2026-03-08T02:30')
		await inputs[1].setValue('2026-03-08T04:00')
		await wrapper.get('form').trigger('submit')
		expect(save).not.toHaveBeenCalled()
		expect(wrapper.get('[role=alert]').text()).toBe('calendar.create.invalidTime')
		await inputs[0].setValue('2026-11-01T01:30')
		await inputs[1].setValue('2026-11-01T03:00')
		await wrapper.get('form').trigger('submit')
		expect(save).not.toHaveBeenCalled()
		expect(wrapper.get('[role=alert]').text()).toBe('calendar.create.ambiguousTime')
		await wrapper.get('select').setValue('2026-11-01T06:30:00.000Z')
		await wrapper.get('form').trigger('submit')
		await flushPromises()
		expect(save).toHaveBeenCalledWith(expect.objectContaining({start_date: '2026-11-01T06:30:00.000Z', end_date: '2026-11-01T08:00:00.000Z'}), 9)
	})

	it('explains suspension and restoration without silently removing existing relative reminders', async () => {
		const {wrapper, save, click} = setup({task: {...task, reminders: [{relative_to: 'start_date', relative_period: -600}]}})
		expect(wrapper.text()).toContain('task.allDay.relativeRemindersPaused')
		await click('task.allDay.edit')
		await click('task.allDay.toTimed')
		expect(wrapper.text()).toContain('task.allDay.relativeRemindersResume')
		expect(wrapper.text()).toContain('task.allDay.relativeRemindersPaused') // Clear schedule also pauses them.
		await click('task.allDay.clear')
		await flushPromises()
		expect(save).toHaveBeenCalledWith(expect.not.objectContaining({reminders: expect.anything()}), 9)
	})

	it('does not offer writes to a read-only task', () => {
		const {wrapper, save} = setup({canWrite: false})
		expect(wrapper.find('button').exists()).toBe(false)
		expect(save).not.toHaveBeenCalled()
	})

	it('fences an account change before saving and an API change while a save is pending', async () => {
		const pending = Promise.withResolvers<'saved'>()
		const save = vi.fn().mockReturnValue(pending.promise)
		const {wrapper, click} = setup({save})
		await click('task.allDay.edit')
		await wrapper.get('form').trigger('submit')
		window.API_URL = 'https://different.example/api/v2'
		pending.resolve('saved')
		await flushPromises()
		expect(wrapper.find('form').exists()).toBe(true)
		await wrapper.get('form').trigger('submit')
		expect(save).toHaveBeenCalledTimes(1)
		window.API_URL = ''
		saveToken(`x.${btoa(JSON.stringify({id: 77, type: 1}))}.x`, false)
		await wrapper.get('form').trigger('submit')
		expect(save).toHaveBeenCalledTimes(1)
	})

	it('does not close a newly mounted task editor when an old save resolves', async () => {
		const pending = Promise.withResolvers<'saved'>()
		const old = setup({save: () => pending.promise})
		await old.click('task.allDay.edit')
		await old.wrapper.get('form').trigger('submit')
		old.wrapper.unmount()
		const next = setup({task: {...task, id: 12}})
		await next.click('task.allDay.edit')
		await next.wrapper.findAll('input[type=date]')[1].setValue('2026-11-10')
		pending.resolve('saved')
		await flushPromises()
		expect(next.wrapper.find('form').exists()).toBe(true)
		expect((next.wrapper.findAll('input[type=date]')[1].element as HTMLInputElement).value).toBe('2026-11-10')
		expect(next.save).not.toHaveBeenCalled()
	})
})
