import {describe, expect, it} from 'vitest'
import {mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'

import TimelineOccupancy from './TimelineOccupancy.vue'
import enMessages from '@/i18n/lang/en.json'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en: enMessages}})

function mountGrid(props: Partial<InstanceType<typeof TimelineOccupancy>['$props']> = {}) {
	return mount(TimelineOccupancy, {
		attachTo: document.body,
		props: {
			year: 2026,
			today: '2026-03-10',
			selectedDay: '',
			month: null,
			days: {
				'2026-03-02': {scheduled_projects: 2, elapsed_projects: 2, deadlines: 1, deadline_projects: 1},
				'2026-03-05': {scheduled_projects: 0, elapsed_projects: 0, deadlines: 3, deadline_projects: 2},
				'2026-03-03': {scheduled_projects: 1, elapsed_projects: 0, deadlines: 0},
				'2026-03-20': {scheduled_projects: 1, elapsed_projects: 0, deadlines: 0},
			},
			...props,
		},
		global: {
			plugins: [i18n],
			stubs: {Icon: true},
		},
	})
}

const cell = (wrapper: ReturnType<typeof mountGrid>, grid: 'year' | 'month', date: string) =>
	wrapper.get(`[data-grid="${grid}"] [data-date="${date}"]`)

describe('TimelineOccupancy', () => {
	it('labels each day with what the shading means, not with work done', () => {
		const wrapper = mountGrid()
		expect(cell(wrapper, 'year', '2026-03-02').attributes('aria-label'))
			.toBe('Mon, Mar 2: 2 projects scheduled, already passed, 1 deadline (1 project)')
		expect(cell(wrapper, 'year', '2026-03-03').attributes('data-state')).toBe('unelapsed')
		expect(cell(wrapper, 'year', '2026-03-20').attributes('data-state')).toBe('planned')
		expect(cell(wrapper, 'year', '2026-03-21').attributes('aria-label')).toContain('nothing scheduled')
		expect(cell(wrapper, 'year', '2026-03-10').attributes('data-today')).toBeDefined()
		wrapper.unmount()
	})

	it('marks a day with only deadlines without shading it as scheduled', () => {
		const wrapper = mountGrid()
		const day = cell(wrapper, 'year', '2026-03-05')
		expect(day.attributes('data-state')).toBe('none')
		expect(day.attributes('data-level')).toBe('0')
		expect(day.find('.deadline-dot').exists()).toBe(true)
		expect(day.attributes('aria-label')).toBe('Thu, Mar 5: nothing scheduled, 3 deadlines (2 projects)')
		wrapper.unmount()
	})

	it('does not call today finished when its only task starts later today', () => {
		const wrapper = mountGrid({days: {'2026-03-10': {scheduled_projects: 1, elapsed_projects: 0, deadlines: 0}}})
		const today = cell(wrapper, 'year', '2026-03-10')
		expect(today.attributes('data-state')).toBe('unelapsed')
		expect(today.attributes('aria-label')).toBe('Tue, Mar 10: 1 project scheduled, '
			+ 'scheduled but not counted as passed (not started yet, or finished before its planned end), today')
		expect(today.attributes('aria-label')).not.toMatch(/finished earlier|completed/i)
		wrapper.unmount()
	})

	it('keeps one tab stop per grid and moves by week, day and month', async () => {
		const wrapper = mountGrid()
		expect(wrapper.findAll('[data-grid="year"] [tabindex="0"]').map(c => c.attributes('data-date'))).toEqual(['2026-03-10'])
		expect(wrapper.findAll('[data-grid="month"] [tabindex="0"]').map(c => c.attributes('data-date'))).toEqual(['2026-03-10'])

		const today = cell(wrapper, 'year', '2026-03-10')
		await today.trigger('keydown', {key: 'ArrowRight'})
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-03-17')
		await cell(wrapper, 'year', '2026-03-17').trigger('keydown', {key: 'ArrowDown'})
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-03-18')
		await cell(wrapper, 'year', '2026-03-18').trigger('keydown', {key: 'PageDown'})
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-04-18')
		await cell(wrapper, 'year', '2026-04-18').trigger('keydown', {key: 'End'})
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-04-30')
		await cell(wrapper, 'year', '2026-04-30').trigger('keydown', {key: 'Enter'})
		expect(wrapper.emitted('selectDay')).toEqual([['2026-04-30']])
		wrapper.unmount()
	})

	it('asks for the next month when the month calendar is left by keyboard', async () => {
		const wrapper = mountGrid({month: 2})
		await cell(wrapper, 'month', '2026-03-31').trigger('keydown', {key: 'ArrowRight'})
		expect(wrapper.emitted('selectMonth')).toEqual([[3]])
		await wrapper.setProps({month: 3})
		await wrapper.vm.$nextTick()
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.closest('[data-grid]')?.getAttribute('data-grid')).toBe('month')
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-04-01')
		wrapper.unmount()
	})

	it('stays inside the selected year', async () => {
		const wrapper = mountGrid({selectedDay: '2026-12-31'})
		await cell(wrapper, 'year', '2026-12-31').trigger('keydown', {key: 'ArrowRight'})
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute('data-date')).toBe('2026-12-31')
		wrapper.unmount()
	})
})
