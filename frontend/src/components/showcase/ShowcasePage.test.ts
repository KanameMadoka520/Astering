import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'

import type {TcyShowcasePublicResponse} from '@/client/generated'
import ShowcasePage from './ShowcasePage.vue'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'

const EVENT_START = '2026-10-31T02:00:00Z'
const page: TcyShowcasePublicResponse = {
	title: 'My public schedule',
	intro: 'Hello',
	custom_layout: false,
	format: 'markdown',
	content: '# Custom part',
	generated_at: '2026-10-31T01:00:00Z',
	until: '2026-11-07T01:00:00Z',
	events: [
		{
			kind: 'busy',
			start: EVENT_START,
			end: '2026-10-31T03:00:00Z',
			title: 'Focus block',
			project: 'Thesis',
		},
	],
	free: [
		{
			start: '2026-10-31T04:00:00Z',
			end: '2026-10-31T06:00:00Z',
		},
	],
	projects: ['Thesis'],
}

let wrapper: VueWrapper | undefined

beforeEach(() => {
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

function mountPage(props: {embedded?: boolean} = {}) {
	wrapper = mount(ShowcasePage, {
		props: {page, ...props},
		global: {
			plugins: [i18n],
			stubs: {Icon: true},
		},
	})
	return wrapper
}

describe('ShowcasePage', () => {
	it('renders the public outline with readable ranges and a single footer separator', () => {
		mountPage()

		expect(wrapper!.find('h1').text()).toBe('My public schedule')
		expect(wrapper!.findAll('h2').map(h => h.text())).toContain('Available times')
		expect(wrapper!.find('.free-slot').text()).toMatch(/\S to \S/)
		expect(wrapper!.find('.event-when').text()).toMatch(/\S – \S/)
		const footer = wrapper!.find('.showcase-footer p').text()
		expect(footer).toMatch(/^Schedule generated at \S.*\S · Showing until \S/)
		expect(footer).not.toContain('· ·')
		expect(wrapper!.findAll('iframe')).toHaveLength(1)
		expect(wrapper!.find('iframe').attributes('sandbox')).toBe('')
		expect(wrapper!.find('iframe').attributes('srcdoc')).toContain('Content-Security-Policy')
		expect(wrapper!.find('time').attributes('datetime')).toBe(EVENT_START)
	})

	it('nests its headings below the editor when embedded', () => {
		mountPage({embedded: true})

		expect(wrapper!.find('h1').exists()).toBe(false)
		expect(wrapper!.find('h3').text()).toBe('My public schedule')
		expect(wrapper!.findAll('h4').map(h => h.text())).toContain('Available times')
	})

	it('shows inclusive all-day dates in the public page and custom schedule without midnight times', async () => {
		mountPage()
		await wrapper!.setProps({page: {
			...page,
			content: '{{schedule}}',
			events: [{
				all_day: true,
				kind: 'busy',
				start: '2026-11-02T16:00:00Z',
				end: '2026-11-05T16:00:00Z',
				title: '<Private name>',
				project: 'Alias',
			}],
		}})
		const when = wrapper!.find('.event-when').text()
		expect(when).toContain('Nov 3')
		expect(when).toContain('Nov 5')
		expect(when).toContain('All day')
		expect(when).not.toMatch(/00:00|12:00|Nov 6/)
		const frame = wrapper!.find('iframe').attributes('srcdoc')
		expect(frame).toContain(when)
		expect(frame).toContain('&lt;Private name&gt;')
		expect(frame).not.toContain('<Private name>')
	})
})
