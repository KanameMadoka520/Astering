import {writeFile} from 'node:fs/promises'

import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {createDefaultViews} from '../project/prepareProjects'
import {updateUserSettings} from '../../support/updateUserSettings'

test.use({timezoneId: 'America/Los_Angeles'})

const anchor = '2026-11-03'
const isCalendar = (url: string) => new URL(url).pathname === '/api/v2/tasks/calendar'
const labels = {
	en: {
		view: 'Calendar view',
		month: 'month',
		day: 'day',
		agenda: 'agenda',
		options: 'Display options',
		zoom: 'Time scale',
		create: 'New schedule',
		dialog: 'Schedule a task',
		title: 'What would you like to arrange?',
		start: 'Start time',
		end: 'End time',
		save: 'Create and open task',
		important: 'High priority only',
		hideDone: 'Hide completed',
	},
	'zh-CN': {
		view: '日历视图',
		month: 'month',
		day: 'day',
		agenda: 'agenda',
		options: '显示设置',
		zoom: '时间轴缩放',
		create: '新建安排',
		dialog: '安排一项任务',
		title: '想安排什么事情？',
		start: '开始时间',
		end: '结束时间',
		save: '创建并查看任务',
		important: '只看高优先级',
		hideDone: '隐藏已完成',
	},
}

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 320, language: 'en'},
	{width: 390, language: 'zh-CN'},
] as const) {
	test(`calendar ${scenario.width}px ${scenario.language} keeps time, filters, task modal and creation consistent`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
		currentUser,
	}, testInfo) => {
		const text = labels[scenario.language]
		await page.setViewportSize({width: scenario.width, height: 844})
		await updateUserSettings(apiContext, userToken, {
			language: scenario.language,
			timezone: 'Asia/Shanghai',
			week_start: 1,
		})
		const [project] = await ProjectFactory.create(1, {
			owner_id: currentUser.id,
			title: 'Calendar fixture',
		})
		await createDefaultViews(project.id)
		const data = [
			{
				title: 'Across local midnight',
				start_date: '2026-11-02T15:30:00Z',
				end_date: '2026-11-02T16:30:00Z',
				due_date: '2026-11-02T17:00:00Z',
				priority: 3,
			},
			{
				title: 'Morning meeting',
				start_date: '2026-11-03T01:00:00Z',
				end_date: '2026-11-03T02:00:00Z',
			},
			{
				title: 'Overlapping meeting',
				start_date: '2026-11-03T01:30:00Z',
				end_date: '2026-11-03T02:30:00Z',
			},
			{
				title: 'Deadline without invented duration',
				due_date: '2026-11-03T03:00:00Z',
			},
			{
				title: 'Already completed',
				start_date: '2026-11-03T04:00:00Z',
				end_date: '2026-11-03T05:00:00Z',
				done: true,
			},
			{
				title: 'Unscheduled task stays out',
			},
		]
		await TaskFactory.create(data.length, {
			project_id: project.id,
			created_by_id: currentUser.id,
			title: (index: number) => data[index - 1].title,
			start_date: (index: number) => data[index - 1].start_date ?? null,
			end_date: (index: number) => data[index - 1].end_date ?? null,
			due_date: (index: number) => data[index - 1].due_date ?? null,
			done: (index: number) => data[index - 1].done ?? false,
			priority: (index: number) => data[index - 1].priority ?? 0,
		})
		const requests: URL[] = []
		page.on('request', request => {
			if (isCalendar(request.url())) requests.push(new URL(request.url()))
		})
		await page.goto(`/calendar?view=week&date=${anchor}&project=${project.id}`)
		await expect(page.locator('.calendar-time-column')).toHaveCount(7)
		await expect(page.locator('.calendar-time-column[data-timeline-date="2026-11-02"] [data-task-id="1"]')).toHaveCount(1)
		await expect(page.locator('.calendar-time-column[data-timeline-date="2026-11-03"] [data-task-id="1"]')).toHaveCount(2)
		await expect(page.locator('.calendar-time-body [data-task-id="4"][data-event-kind="due"]')).toHaveCount(1)
		await expect(page.locator('.calendar-time-body [data-task-id="4"][data-event-kind="range"]')).toHaveCount(0)
		await expect(page.locator('.calendar-time-body [data-task-id="5"]')).toHaveCount(0)
		await expect(page.locator('.calendar-time-body')).not.toContainText('Unscheduled task stays out')
		expect(requests.every(url => url.searchParams.get('timezone') === 'Asia/Shanghai')).toBe(true)
		expect(requests[0].searchParams.get('from')).toBe('2026-11-02')
		expect(requests[0].searchParams.get('to')).toBe('2026-11-09')

		const overlapping = await page.locator('.calendar-time-body [data-task-id="2"], .calendar-time-body [data-task-id="3"]')
			.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
		expect(overlapping).toHaveLength(2)
		expect(overlapping.every(width => width > 0)).toBe(true)
		await page.getByText(text.options, {exact: true}).click()
		const timeline = page.locator('.calendar-time-scroll')
		await timeline.evaluate(element => { element.scrollTop = 640 })
		const beforeZoomRequests = requests.length
		await page.getByRole('slider', {name: text.zoom, exact: true}).focus()
		await page.keyboard.press('End')
		await expect(page).toHaveURL(/zoom=250/)
		await expect.poll(() => timeline.evaluate(element => element.scrollTop / 160)).toBeCloseTo(10, 1)
		expect(requests.length).toBe(beforeZoomRequests)
		const meeting = page.locator('.calendar-time-body [data-task-id="2"][data-event-kind="range"]')
		await meeting.scrollIntoViewIfNeeded()
		const scrollBeforeModal = await timeline.evaluate(element => element.scrollTop)
		await page.evaluate(() => Reflect.set(window, '__calendarDocument', true))
		await meeting.click()
		await expect(page.locator('.task-view')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.locator('.task-view')).not.toBeVisible()
		await expect(page).toHaveURL(/date=2026-11-03/)
		await expect(page).toHaveURL(/zoom=250/)
		expect(await page.evaluate(() => Reflect.get(window, '__calendarDocument'))).toBe(true)
		await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBe(scrollBeforeModal)
		await meeting.click()
		await expect(page.locator('.task-view')).toBeVisible()
		await page.reload()
		await expect(page.locator('.task-view')).toBeVisible()
		await expect(page.locator('.calendar-date-input')).toHaveValue(anchor)
		await expect(page.locator('.calendar-mode-picker select')).toHaveValue('week')
		await expect(page.locator('.calendar-display-fields input[type="range"]')).toHaveValue('250')
		await page.keyboard.press('Escape')
		await expect(page.locator('.task-view')).not.toBeVisible()
		await expect(page).toHaveURL(/date=2026-11-03/)
		await expect(page).toHaveURL(/zoom=250/)

		await page.getByRole('combobox', {name: text.view, exact: true}).selectOption(text.month)
		await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
		await page.locator('[data-calendar-date="2026-11-03"]').click()
		await expect(page.locator('.calendar-agenda-day[data-agenda-date="2026-11-03"]')).toContainText('Morning meeting')
		await expect(page.locator('.calendar-occupancy')).toBeVisible()
		await page.getByLabel(text.important, {exact: true}).check()
		await expect(page.locator('.calendar-agenda')).not.toContainText('Morning meeting')
		await expect(page.locator('.calendar-agenda')).toContainText('Across local midnight')
		await page.getByLabel(text.important, {exact: true}).uncheck()
		await page.getByLabel(text.hideDone, {exact: true}).uncheck()
		await expect(page.locator('.calendar-agenda')).toContainText('Already completed')
		await page.reload()
		await expect(page.getByLabel(text.hideDone, {exact: true})).not.toBeChecked()
		await expect(page.getByRole('combobox', {name: text.view, exact: true})).toHaveValue('month')
		await expect(page.locator('.calendar-agenda')).toContainText('Already completed')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath(`calendar-month-${scenario.width}-${scenario.language}.png`)})

		await page.getByRole('button', {name: text.create, exact: true}).click()
		const dialog = page.getByRole('dialog', {name: text.dialog, exact: true})
		await dialog.getByPlaceholder(text.title, {exact: true}).fill('Created in the account time zone')
		await dialog.getByRole('combobox').first().selectOption(String(project.id))
		await dialog.getByLabel(text.start, {exact: true}).fill('2026-11-03T09:00')
		await dialog.getByLabel(text.end, {exact: true}).fill('2026-11-03T10:00')
		const created = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
		await dialog.getByRole('button', {name: text.save, exact: true}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		const stored = await response.json()
		const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(read.ok()).toBe(true)
		const saved = await read.json()
		expect(Date.parse(saved.start_date)).toBe(Date.parse('2026-11-03T01:00:00Z'))
		expect(Date.parse(saved.end_date)).toBe(Date.parse('2026-11-03T02:00:00Z'))
		await expect(page.locator('.task-view')).toBeVisible()
		await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page).toHaveURL(/\/calendar\?/)
		await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
		await page.reload()
		await expect(page.locator('.calendar-agenda')).toContainText('Created in the account time zone')
	})
}

test('calendar failed range load retries real data without loading undated tasks', async ({
	authenticatedPage: page,
	currentUser,
}) => {
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	await TaskFactory.create(1, {
		project_id: project.id,
		created_by_id: currentUser.id,
		title: 'Real calendar retry',
		due_date: '2026-11-03T09:00:00Z',
	})
	let attempts = 0
	await page.route(url => url.pathname === '/api/v2/tasks/calendar', async route => {
		attempts++
		if (attempts <= 4) {
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({detail: 'Calendar fixture unavailable'}),
			})
			return
		}
		await route.continue()
	})
	await page.goto(`/calendar?view=agenda&date=${anchor}`)
	await expect(page.getByRole('alert')).toContainText('This date range could not be loaded')
	attempts = 4
	await page.getByRole('button', {name: 'Retry', exact: true}).click()
	await expect(page.locator('.calendar-agenda')).toContainText('Real calendar retry')
	await expect(page.getByRole('alert')).toHaveCount(0)
})

test('dense calendar keeps zoom local, overlap groups independent and records browser work', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
	currentUser,
}, testInfo) => {
	test.setTimeout(120_000)
	await page.setViewportSize({width: 1440, height: 900})
	await updateUserSettings(apiContext, userToken, {timezone: 'UTC', week_start: 1})
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	const start = (index: number) => Date.UTC(2026, 10, 2 + Math.floor((index - 1) / 80), 6, (index - 1) % 80 * 10)
	await TaskFactory.create(500, {
		project_id: project.id,
		created_by_id: currentUser.id,
		title: (index: number) => `Dense fixture ${index}`,
		start_date: (index: number) => new Date(start(index)).toISOString(),
		end_date: (index: number) => new Date(start(index) + 30 * 60_000).toISOString(),
	})
	const requests: string[] = []
	page.on('request', request => {
		if (isCalendar(request.url())) requests.push(request.url())
	})
	await page.addInitScript(() => {
		const work = {count: 0, duration: 0, max: 0}
		Reflect.set(window, '__calendarWork', work)
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) {
				work.count++
				work.duration += entry.duration
				work.max = Math.max(work.max, entry.duration)
			}
		}).observe({type: 'longtask', buffered: true})
	})
	await page.goto('/calendar?view=week&date=2026-11-02')
	await expect(page.locator('.calendar-time-body .calendar-event')).toHaveCount(500)
	await page.getByText('Display options', {exact: true}).click()
	const timeline = page.locator('.calendar-time-scroll')
	await timeline.evaluate(element => { element.scrollTop = 640 })
	const before = requests.length
	await page.getByRole('slider', {name: 'Time scale', exact: true}).focus()
	await page.keyboard.press('End')
	await expect(page).toHaveURL(/zoom=250/)
	await expect.poll(() => timeline.evaluate(element => element.scrollTop / 160)).toBeCloseTo(10, 1)
	expect(requests.length).toBe(before)
	const zoomRequests = requests.length - before
	const placements = await page.locator('.calendar-time-placement').evaluateAll(elements => elements.slice(0, 12).map(element => ({
		left: (element as HTMLElement).style.insetInlineStart,
		width: (element as HTMLElement).style.inlineSize,
	})))
	expect(placements.every(item => Number.parseFloat(item.width) >= 20)).toBe(true)
	await page.getByRole('combobox', {name: 'Calendar view', exact: true}).selectOption('month')
	await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
	await page.getByRole('combobox', {name: 'Calendar view', exact: true}).selectOption('agenda')
	await expect(page.locator('.calendar-agenda .calendar-event')).toHaveCount(500)
	const work = await page.evaluate(() => Reflect.get(window, '__calendarWork'))
	const report = JSON.stringify({
		fixtureTasks: 500,
		calendarRequests: requests.length,
		zoomRequests,
		longTasks: work,
	})
	await writeFile(testInfo.outputPath('calendar-browser-work.json'), report)
	await testInfo.attach('calendar-browser-work.json', {
		body: report,
		contentType: 'application/json',
	})
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.screenshot({path: testInfo.outputPath('calendar-dense-agenda.png')})
})
