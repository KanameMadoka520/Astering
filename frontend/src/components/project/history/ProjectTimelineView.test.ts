import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin, onlineManager} from '@tanstack/vue-query'

import {createPinia, setActivePinia} from 'pinia'

import type {ProjectTimelineQuery} from '@/client/queries/projectTimeline'

const sdk = vi.hoisted(() => ({
	projectTimeline: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/composables/useProjects', () => ({
	useProjects: () => ({projectsArray: []}),
}))

import ProjectTimelineView from './ProjectTimelineView.vue'
import {invalidateTaskMembership} from '@/client/queries/taskCache'
import enMessages from '@/i18n/lang/en.json'
import {removeToken, saveToken} from '@/helpers/auth'
import {useAuthStore} from '@/stores/auth'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en: enMessages}})

function timeline(query: ProjectTimelineQuery, progress: number) {
	return {
		data: {
			year: query.year,
			today: '2026-10-31',
			first_year: 2026,
			last_year: 2026,
			days: {'2026-02-05': {scheduled_projects: 1, elapsed_projects: 1, deadlines: 0}},
			projects: 1,
			scheduled_days: 10,
			elapsed_days: 10,
			dated_tasks: 2,
			done_tasks: 1,
			overdue_tasks: 0,
			ranged_tasks: 2,
			deadline_only_tasks: 0,
			undated_tasks: 2,
			incomplete_tasks: 1,
			excluded_tasks: 3,
			invalid_tasks: 0,
			items: [{
				id: 1,
				title: 'Website relaunch',
				hex_color: '1973ff',
				start_date: '2026-02-01',
				end_date: '2026-02-10',
				scheduled_days: 10,
				elapsed_days: 10,
				task_count: 2,
				ranged_tasks: 2,
				deadline_only_tasks: 0,
				done_tasks: 1,
				progress,
				scheduled_spans: [{start: '2026-02-01', end: '2026-02-10'}],
				elapsed_spans: [{start: '2026-02-01', end: '2026-02-10'}],
			}],
			total: 1,
			page: 1,
			total_pages: 1,
		},
	}
}

let wrapper: VueWrapper | undefined
let client: QueryClient
let router: ReturnType<typeof createRouter>

async function mountView(path = '/projects/history') {
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/projects/history', name: 'projects.history', component: {template: '<div />'}},
			{path: '/projects/:projectId', name: 'project.index', component: {template: '<div />'}},
		],
	})
	await router.push(path)
	await router.isReady()
	client = new QueryClient({defaultOptions: {queries: {retry: false}}})
	wrapper = mount(ProjectTimelineView, {
		attachTo: document.body,
		props: {year: 2026, timezone: 'UTC'},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient: client}]],
			stubs: {
				Icon: true,
				XButton: {template: '<button type="button"><slot /></button>'},
			},
		},
	})
	await flushPromises()
	return wrapper
}

describe('ProjectTimelineView', () => {
	beforeEach(() => {
		removeToken()
		window.API_URL = ''
		setActivePinia(createPinia())
		onlineManager.setOnline(true)
		vi.resetAllMocks()
		document.body.innerHTML = ''
	})

	afterEach(() => {
		wrapper?.unmount()
		wrapper = undefined
		client?.clear()
		onlineManager.setOnline(true)
	})

	it('retains the displayed year when the requested year is paused offline', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		onlineManager.setOnline(false)
		await view.setProps({year: 2027})
		await flushPromises()
		expect(view.find('.lane').exists()).toBe(true)
		expect(view.find('.timeline-skeleton').exists()).toBe(false)
		expect(view.get('.history-connection-status').text()).toContain('2026')
		expect(view.get('#timeline-projects-heading').text()).toContain('2026')
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(1)
	})

	it.each([403, 404])('hides retained private lanes after a same-query HTTP %s', async status => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		sdk.projectTimeline.mockRejectedValue({status})
		await client.refetchQueries({queryKey: ['project-timeline']})
		await flushPromises()
		expect(view.find('.lane').exists()).toBe(false)
		expect(view.find('[role="alert"]').exists()).toBe(true)
	})

	it.each(['clear', 'API', 'account', 'epoch'] as const)('releases its retained result after %s isolation changes', async kind => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		saveToken(`x.${btoa(JSON.stringify({id: 1, type: 1}))}.x`, false)
		useAuthStore().setSession({id: 1, type: 1, exp: 9999999999})
		const view = await mountView()
		onlineManager.setOnline(false)
		await view.setProps({year: 2027})
		await flushPromises()
		expect(view.find('.lane').exists()).toBe(true)
		if (kind === 'account') {
			saveToken(`x.${btoa(JSON.stringify({id: 2, type: 1}))}.x`, false)
			useAuthStore().setSession({id: 2, type: 1, exp: 9999999999})
		} else if (kind === 'epoch') {
			removeToken()
			// Logout changes the reactive session as well as the non-reactive token epoch.
			useAuthStore().setSession(null)
		} else {
			if (kind === 'API') window.API_URL = 'https://other.example'
			client.clear()
		}
		await flushPromises()
		expect(view.find('.lane').exists()).toBe(false)
	})

	it('explains progress, elapsed time and missing dates separately', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		expect(view.find('.lane [role="progressbar"]').attributes('aria-valuenow')).toBe('50')
		expect(view.find('.lane').text()).toContain('10 of 10 scheduled days in 2026 counted as passed')
		const missing = view.findAll('.timeline-missing p').map(p => p.text())
		expect(missing[0]).toContain('2 tasks have no dates at all')
		expect(missing[1]).toContain('1 task has only a start or only an end date')
		expect(view.find('.timeline-missing').text()).not.toContain('3 tasks')
		expect(view.findAll('.timeline-stat dd').map(dd => dd.text())).toEqual(['1', '10 days', '10 days', '1 of 2', '0', '0'])
		expect(view.emitted('years')).toEqual([[[2026]]])
	})

	it('keeps lanes, the search draft and focus while a task change refreshes it in the background', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(1)

		const search = view.get<HTMLInputElement>('.timeline-search input')
		search.element.focus()
		await search.setValue('Web')

		let release!: () => void
		sdk.projectTimeline.mockImplementation(async ({query}) => {
			await new Promise<void>(resolve => {
				release = resolve
			})
			return timeline(query, 1)
		})
		void invalidateTaskMembership(client, 1)
		await flushPromises()

		// Mid-refresh: still the old content, at full contrast, nothing replaced by a skeleton.
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(2)
		expect(view.find('.timeline-skeleton').exists()).toBe(false)
		expect(view.find('.is-refreshing').exists()).toBe(false)
		expect(view.find('.lane').text()).toContain('50% average progress')
		expect(search.element.value).toBe('Web')
		expect(document.activeElement).toBe(search.element)

		release()
		await flushPromises()
		expect(view.find('.lane').text()).toContain('100% average progress')
		expect(search.element.value).toBe('Web')
		expect(document.activeElement).toBe(search.element)
		expect(sdk.projectTimeline).toHaveBeenCalledTimes(2)
	})

	it('keeps the lanes heading on the year while a month is only zoomed', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView('/projects/history?month=3')
		expect(sdk.projectTimeline.mock.lastCall?.[0].query).not.toHaveProperty('month')
		expect(view.get('#timeline-projects-heading').text()).toBe('Projects with dates in 2026')
		expect(view.find('.lane').text()).toContain('Nothing scheduled or due in March')
	})

	it('names the single year that has scheduled work instead of a one-year range', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => {
			const response = timeline(query, 0)
			return {data: {...response.data, first_year: 2024, last_year: 2024, items: [], total: 0, dated_tasks: 0}}
		})
		const view = await mountView()
		expect(view.text()).toContain('No dated tasks in 2026.')
		expect(view.text()).toContain('Tasks with dates exist only in 2024.')
		expect(view.text()).not.toContain('between 2024 and 2024')
	})

	it('shows a project whose tasks only have deadlines as deadline nodes, not as a span', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => {
			const response = timeline(query, 0.5)
			return {data: {
				...response.data,
				scheduled_days: 0,
				elapsed_days: 0,
				ranged_tasks: 0,
				deadline_only_tasks: 3,
				dated_tasks: 3,
				undated_tasks: 0,
				incomplete_tasks: 0,
				excluded_tasks: 0,
				invalid_tasks: 1,
				items: [{
					...response.data.items[0],
					start_date: '',
					end_date: '',
					scheduled_days: 0,
					elapsed_days: 0,
					task_count: 3,
					ranged_tasks: 0,
					deadline_only_tasks: 3,
					scheduled_spans: [],
					elapsed_spans: [],
					deadline_days: [
						{date: '2026-03-02', count: 1, done: 1, open: 0},
						{date: '2026-10-01', count: 1, done: 0, open: 1},
						{date: '2026-12-01', count: 1, done: 0, open: 1},
					],
				}],
			}}
		})
		const view = await mountView()
		const lane = view.get('.lane')
		expect(lane.classes()).not.toContain('is-outside')
		expect(lane.text()).toContain('Only deadlines in 2026, no start–end range')
		expect(lane.text()).not.toContain('scheduled days in 2026 counted as passed')
		expect(lane.findAll('.lane-span')).toHaveLength(0)
		expect(lane.findAll('.lane-deadline').map(node => node.classes().find(c => c.startsWith('is-'))))
			.toEqual(['is-done', 'is-overdue', 'is-open'])
		expect(lane.get('.lane-deadline.is-overdue').attributes('title')).toContain('1 of 1 task still open, overdue')
		expect(view.findAll('.timeline-stat dd').map(dd => dd.text())).toEqual(['1', '0 days', '0 days', '1 of 3', '3', '0'])
		expect(view.find('.timeline-missing').text()).toContain('A valid due date of it still shows as a deadline.')
	})

	it('drops a pending search when the view unmounts', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		const replace = vi.spyOn(router, 'replace')
		await view.get('.timeline-search input').setValue('Web')
		view.unmount()
		wrapper = undefined
		await new Promise(resolve => setTimeout(resolve, 350))
		expect(replace).not.toHaveBeenCalled()
	})

	it('applies the search after typing stops', async () => {
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		const view = await mountView()
		await view.get('.timeline-search input').setValue('Web')
		await vi.waitFor(() => expect(router.currentRoute.value.query.q).toBe('Web'))
	})

	it('offers a retry when the first load fails', async () => {
		sdk.projectTimeline.mockRejectedValueOnce(new Error('offline'))
		const view = await mountView()
		expect(view.find('[role="alert"]').text()).toContain('Could not load the timeline.')
		sdk.projectTimeline.mockImplementation(async ({query}) => timeline(query, 0.5))
		await view.get('[role="alert"] button').trigger('click')
		await flushPromises()
		expect(view.find('.lane').exists()).toBe(true)
	})
})
