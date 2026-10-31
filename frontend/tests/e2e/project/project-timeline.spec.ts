import type {Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {createDefaultViews} from './prepareProjects'

const YEAR = new Date().getUTCFullYear()
const at = (date: string) => `${date}T12:00:00Z`

async function seed() {
	const projects = [
		{id: 1, title: 'Website relaunch', hex_color: '1973ff'},
		{id: 2, title: 'Thesis writing', hex_color: '0f9d58'},
		{id: 3, title: 'Tax return', hex_color: '8e44ad', is_archived: true},
	]
	for (const [index, project] of projects.entries()) {
		await ProjectFactory.create(1, {owner_id: 1, ...project}, index === 0)
		await createDefaultViews(project.id, index * 4 + 1)
	}
	const tasks = [
		// Spans the whole current year: partly passed, partly still ahead.
		{id: 1, project_id: 1, title: 'Whole-year plan', start_date: at(`${YEAR}-01-01`), end_date: at(`${YEAR}-12-31`), percent_done: 0.5},
		// No dates: counted as missing, never drawn.
		{id: 2, project_id: 1, title: 'Undated idea'},
		// Done after 10 of its 20 scheduled days.
		{id: 3, project_id: 2, title: 'Draft chapters', start_date: at('2024-03-01'), end_date: at('2024-03-20'), done: true, done_at: at('2024-03-10'), percent_done: 1},
		{id: 4, project_id: 3, title: 'File the return', start_date: at(`${YEAR}-02-01`), end_date: at(`${YEAR}-02-10`)},
	]
	for (const [index, task] of tasks.entries()) {
		await TaskFactory.create(1, task, index === 0)
	}
}

const lane = (page: Page, title: string) => page.locator('.lane').filter({hasText: title})

// Elements on the page that animate layout or `all`, or take longer than the motion scale allows.
async function motionViolations(page: Page) {
	return page.evaluate(() => [...document.querySelectorAll('.project-history *')].flatMap(el => {
		const style = getComputedStyle(el)
		const durations = style.transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))
		const properties = style.transitionProperty.split(',').map(value => value.trim())
		return properties.flatMap((property, index) => {
			const duration = durations[index % durations.length]
			if (!(duration > 0)) return []
			if (property === 'all' || duration > 250 || ['width', 'height', 'inline-size', 'block-size', 'top', 'left', 'margin', 'padding'].includes(property)) {
				return [`${el.className}: ${property} ${duration}ms`]
			}
			return []
		})
	}))
}

test.describe('Project timeline', () => {
	test.use({timezoneId: 'UTC'})

	test('shows dated work per project with progress apart from elapsed time', async ({authenticatedPage: page}) => {
		await seed()
		await page.setViewportSize({width: 1280, height: 900})
		await page.goto('/projects/history')

		await expect(page.getByRole('tab', {name: 'Timeline'})).toHaveAttribute('aria-selected', 'true')
		await expect(page.locator('.lane')).toHaveCount(2)
		const website = lane(page, 'Website relaunch')
		await expect(website.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
		await expect(website).toContainText('50% average progress')
		await expect(website).toContainText(`0 of 1 dated tasks in ${YEAR} done`)
		await expect(website.locator('.lane-span.is-elapsed')).toHaveCount(1)
		await expect(lane(page, 'Tax return')).toContainText('Archived')
		await expect(page.locator('.timeline-missing')).toContainText('1 task has no dates at all, so it is not on the timeline.')
		await expect(page.locator('.timeline-stat').filter({hasText: 'Projects with dates'})).toContainText('2')
		expect(await motionViolations(page)).toEqual([])

		const status = page.getByRole('group', {name: 'Project status'})
		await status.getByRole('button', {name: 'Archived'}).click()
		await expect(page).toHaveURL(/status=archived/)
		await expect(page.locator('.lane')).toHaveCount(1)
		await expect(page.locator('.lane')).toContainText('Tax return')
		await status.getByRole('button', {name: 'Active'}).click()
		await expect(page.locator('.lane')).toHaveCount(1)
		await expect(page.locator('.lane')).toContainText('Website relaunch')
		await status.getByRole('button', {name: 'All'}).click()
		await expect(page.locator('.lane')).toHaveCount(2)

		// Picking a day narrows the lanes; the keyboard moves a week per column and Enter selects.
		const cell = page.locator(`[data-grid="year"] [data-date="${YEAR}-02-05"]`)
		await cell.click()
		await expect(page).toHaveURL(new RegExp(`day=${YEAR}-02-05`))
		await expect(page.locator('.lane')).toHaveCount(2)
		await expect(cell).toHaveAttribute('aria-selected', 'true')
		await cell.focus()
		await page.keyboard.press('ArrowRight')
		await expect(page.locator(`[data-grid="year"] [data-date="${YEAR}-02-12"]`)).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(page).toHaveURL(new RegExp(`day=${YEAR}-02-12`))
		await expect(page.locator('.lane')).toHaveCount(1)
		await page.getByRole('button', {name: 'Show all days'}).first().click()
		await expect(page.locator('.lane')).toHaveCount(2)

		// Zooming to a month keeps every row but draws only that month.
		await page.getByRole('button', {name: 'Zoom to March', exact: false}).first().click()
		await expect(page).toHaveURL(/month=3/)
		await expect(lane(page, 'Tax return')).toContainText('Nothing scheduled or due in March')

		await page.getByRole('combobox', {name: 'Year'}).selectOption('2024')
		await expect(page).toHaveURL(/year=2024/)
		await expect(page).not.toHaveURL(/month=/)
		const thesis = lane(page, 'Thesis writing')
		await expect(thesis).toContainText('100% average progress')
		await expect(thesis).toContainText('10 of 20 scheduled days in 2024 counted as passed')
		await expect(page.locator('.lane')).toHaveCount(1)

		await page.getByRole('combobox', {name: 'Year'}).selectOption(String(YEAR - 5))
		await expect(page.getByText(`No dated tasks in ${YEAR - 5}.`)).toBeVisible()
		await page.getByRole('button', {name: 'Go to 2024'}).click()
		await expect(page).toHaveURL(/year=2024/)
		await expect(lane(page, 'Thesis writing')).toBeVisible()
	})

	test('updates from a task change without reloading the page', async ({authenticatedPage: page}) => {
		await seed()
		await page.setViewportSize({width: 1280, height: 900})
		await page.goto('/projects/history')
		await expect(lane(page, 'Website relaunch')).toContainText('50% average progress')
		await page.evaluate(() => {
			(window as unknown as {timelineMarker: number}).timelineMarker = 1
		})

		await lane(page, 'Website relaunch').getByRole('link', {name: 'Website relaunch'}).click()
		await expect(page).toHaveURL(/\/projects\/1\/1/)
		await page.locator('.single-task').filter({hasText: 'Whole-year plan'}).locator('.fancy-checkbox').click()
		await expect(page.locator('.global-notification')).toContainText('Success')
		await page.goBack()

		await expect(page).toHaveURL(/\/projects\/history/)
		await expect(lane(page, 'Website relaunch')).toContainText('100% average progress')
		await expect(lane(page, 'Website relaunch')).toContainText(`1 of 1 dated tasks in ${YEAR} done`)
		expect(await page.evaluate(() => (window as unknown as {timelineMarker?: number}).timelineMarker)).toBe(1)
	})

	test('deadline-only tasks appear without invented spans and empty lifecycle explains the current scope', async ({
		authenticatedPage: page, apiContext, userToken, currentUser,
	}) => {
		const deadline = `${YEAR}-06-15`
		await ProjectFactory.create(1, {id: 1, owner_id: currentUser.id, title: 'Deadline without a start'})
		await ProjectFactory.create(1, {id: 2, owner_id: currentUser.id, title: 'Undated research'}, false)
		await createDefaultViews(1, 1)
		await createDefaultViews(2, 5)
		await TaskFactory.create(1, {
			id: 1, project_id: 1, created_by_id: currentUser.id,
			title: 'Send the proposal', due_date: at(deadline),
		})
		const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
		const headers = {Authorization: `Bearer ${userToken}`}
		const timelineResponse = await apiContext.get(`${api}/projects/timeline`, {
			headers, params: {year: YEAR, timezone: 'UTC'},
		})
		expect(timelineResponse.ok(), await timelineResponse.text()).toBe(true)
		const timeline = await timelineResponse.json()
		expect(timeline.items).toHaveLength(1)
		expect(timeline.items[0]).toMatchObject({
			id: 1, start_date: '', end_date: '', scheduled_days: 0, elapsed_days: 0,
			ranged_tasks: 0, deadline_only_tasks: 1,
			deadline_days: [{date: deadline, count: 1, done: 0, open: 1}],
		})
		expect(timeline.items[0].scheduled_spans ?? []).toEqual([])
		expect(timeline.items[0].elapsed_spans ?? []).toEqual([])
		expect(timeline.days[deadline]).toMatchObject({scheduled_projects: 0, deadlines: 1, deadline_projects: 1})
		await page.setViewportSize({width: 1280, height: 900})
		await page.goto(`/projects/history?year=${YEAR}`)
		const dueLane = lane(page, 'Deadline without a start')
		await expect(dueLane).toBeVisible()
		await expect(dueLane).toContainText(`Only deadlines in ${YEAR}, no start–end range`)
		await expect(dueLane.locator('.lane-deadline')).toHaveCount(1)
		await expect(dueLane.locator('.lane-span')).toHaveCount(0)
		await expect(page.locator('.timeline-stat').filter({hasText: 'Scheduled days'}).locator('dd')).toHaveText('0 days')
		// The calendar's deadline cell is interactive; the lane's marker is its visual counterpart.
		const cell = page.locator(`[data-grid="year"] [data-date="${deadline}"]`)
		await expect(cell).toHaveAttribute('aria-label', /1 deadline/)
		await cell.click()
		await expect(page).toHaveURL(new RegExp(`day=${deadline}`))
		await expect(cell).toHaveAttribute('aria-selected', 'true')
		await expect(dueLane).toBeVisible()
		await page.getByRole('button', {name: 'Show only Deadline without a start', exact: true}).click()
		await expect(page).toHaveURL(/project=1/)
		await expect(page.locator('.lane')).toHaveCount(1)
		await expect(dueLane.locator('.lane-span')).toHaveCount(0)
		// Clear the project/day scope before switching, so both accessible projects must be counted.
		await page.goto(`/projects/history?year=${YEAR}`)
		await page.getByRole('tab', {name: 'Status changes', exact: true}).click()
		await expect(page).toHaveURL(/tab=lifecycle/)
		await expect(page.getByRole('heading', {name: `No project-level status changes in ${YEAR}`, exact: true})).toBeVisible()
		const scope = page.locator('.history-scope')
		await expect(scope).toHaveAttribute('aria-label', 'Projects in view right now')
		for (const [label, value] of [['Projects', '2'], ['Marked complete', '0'], ['Archived', '0']]) {
			await expect(scope.locator('div').filter({has: page.locator('dt', {hasText: new RegExp(`^${label}$`)})}).locator('dd')).toHaveText(value)
		}
		await expect(page.locator('.history-state')).toContainText('Checking off a project’s tasks never marks the project itself complete')
		await expect(page.locator('.history-state')).toContainText('Nothing is completed automatically, and no past dates are filled in.')
		const historyResponse = await apiContext.get(`${api}/projects/history`, {
			headers, params: {year: YEAR, timezone: 'UTC'},
		})
		expect(historyResponse.ok(), await historyResponse.text()).toBe(true)
		expect((await historyResponse.json()).scope).toEqual({projects: 2, completed: 0, archived: 0})
	})

	test('lifecycle records stay available in their own tab', async ({authenticatedPage: page}) => {
		await seed()
		await page.goto('/projects/history')
		await page.getByRole('tab', {name: 'Timeline'}).focus()
		await page.keyboard.press('ArrowRight')
		await expect(page.getByRole('tab', {name: 'Status changes'})).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(page).toHaveURL(/tab=lifecycle/)
		await expect(page.getByRole('tabpanel')).toBeVisible()
		await expect(page.locator('.lane')).toHaveCount(0)
	})
})

for (const width of [390, 320]) {
	test.describe(`Project timeline on a ${width}px touch screen`, () => {
		test.use({timezoneId: 'UTC', hasTouch: true, isMobile: true, viewport: {width, height: 844}})

		test(`stacks lanes and uses the month calendar at ${width}px`, async ({authenticatedPage: page}, testInfo) => {
			await seed()
			await page.goto('/projects/history?month=2')
			await expect(page.locator('[data-grid="year"]')).toBeHidden()
			const day = page.locator(`[data-grid="month"] [data-date="${YEAR}-02-05"]`)
			await day.tap()
			await expect(page).toHaveURL(new RegExp(`day=${YEAR}-02-05`))
			await expect(page.locator('.lane')).toHaveCount(2)
			const focus = lane(page, 'Website relaunch').locator('.lane-focus')
			const box = (await focus.boundingBox())!
			expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(43.5)
			const fontSize = await page.locator('.timeline-search input').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
			expect(fontSize).toBeGreaterThanOrEqual(16)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
			await page.getByRole('button', {name: 'Next month'}).tap()
			await expect(page).toHaveURL(/month=3/)
			await page.screenshot({path: testInfo.outputPath(`timeline-${width}.png`), fullPage: true, animations: 'disabled'})
		})
	})
}
