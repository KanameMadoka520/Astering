import type {Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {LabelFactory} from '../../factories/labels'
import {LabelTaskFactory} from '../../factories/label_task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {UserFactory} from '../../factories/user'
import {createDefaultViews} from '../project/prepareProjects'

// Walks the main pages with fictional data at desktop and phone widths in both colour schemes.
// Always asserts there is no horizontal page overflow; set ASTERING_DESIGN_TOUR_DIR to also save screenshots.
const TZ = 'Asia/Shanghai'
const SHOTS = process.env.ASTERING_DESIGN_TOUR_DIR || process.env.VIKUNJA_DESIGN_TOUR_DIR

function day(offset: number, hour = 12): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: TZ,
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
	}).formatToParts(new Date())
	const part = (type: string) => Number(parts.find(p => p.type === type)!.value)
	return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offset, hour - 8)).toISOString()
}

const PROJECTS = [
	{
		id: 1,
		title: 'Website relaunch',
		hex_color: '1973ff',
		description: '<p>New marketing site and docs portal.</p>',
	},
	{
		id: 2,
		title: 'Home renovation',
		hex_color: 'e8710a',
	},
	{
		id: 3,
		title: 'Thesis writing',
		hex_color: '0f9d58',
	},
	{
		id: 4,
		title: 'Tax return 2025',
		hex_color: '8e44ad',
		is_archived: true,
	},
]

async function seed() {
	for (const [index, project] of PROJECTS.entries()) {
		await ProjectFactory.create(1, {
			owner_id: 1,
			...project,
		}, index === 0)
		await createDefaultViews(project.id, (project.id - 1) * 4 + 1)
	}

	const tasks = [
		{id: 1, project_id: 1, title: 'Draft the information architecture', start_date: day(-20), end_date: day(-6), done: true, done_at: day(-6), percent_done: 1, priority: 2},
		{id: 2, project_id: 1, title: 'Design the landing page', start_date: day(-8), end_date: day(4), due_date: day(4), percent_done: 0.6, priority: 3},
		{id: 3, project_id: 1, title: 'Write migration guide for the docs portal', start_date: day(-2), due_date: day(9), percent_done: 0.2, priority: 2},
		{id: 4, project_id: 1, title: 'Review analytics consent banner', due_date: day(-1), priority: 4},
		{id: 5, project_id: 1, title: 'Collect testimonials', priority: 1},
		{id: 6, project_id: 2, title: 'Order kitchen tiles', start_date: day(-30), end_date: day(-25), done: true, done_at: day(-24)},
		{id: 7, project_id: 2, title: 'Paint the hallway', start_date: day(1), end_date: day(3), due_date: day(3)},
		{id: 8, project_id: 2, title: 'Call the electrician', due_date: day(0, 18), priority: 3},
		{id: 9, project_id: 3, title: 'Literature review chapter', start_date: day(-60), end_date: day(-10), percent_done: 0.9},
		{id: 10, project_id: 3, title: 'Run the second experiment', start_date: day(-5), end_date: day(25), percent_done: 0.3},
		{id: 11, project_id: 3, title: 'Submit the abstract', due_date: day(40)},
		{id: 12, project_id: 4, title: 'File the tax return', start_date: day(-90), end_date: day(-70), done: true, done_at: day(-71)},
	]
	for (const [index, task] of tasks.entries()) {
		await TaskFactory.create(1, {
			description: index === 1
				? '<p>Hero, pricing teaser and a short <strong>FAQ</strong>.</p><ul data-type="taskList"><li data-checked="true" data-type="taskItem"><p>Wireframe</p></li><li data-checked="false" data-type="taskItem"><p>Visual design</p></li></ul>'
				: '',
			...task,
		}, index === 0)
	}

	const labels = [
		{id: 1, title: 'Design', hex_color: 'e91e63'},
		{id: 2, title: 'Writing', hex_color: '3f51b5'},
		{id: 3, title: 'Errand', hex_color: 'ff9800'},
	]
	for (const [index, label] of labels.entries()) {
		await LabelFactory.create(1, label, index === 0)
	}
	const labelTasks = [[2, 1], [3, 2], [9, 2], [8, 3], [4, 1]]
	for (const [index, [taskId, labelId]] of labelTasks.entries()) {
		await LabelTaskFactory.create(1, {id: index + 1, task_id: taskId, label_id: labelId}, index === 0)
	}

	// Kanban view of project 1 is view 4.
	const buckets = [
		{id: 1, title: 'Backlog', project_view_id: 4, position: 100},
		{id: 2, title: 'In progress', project_view_id: 4, position: 250},
		{id: 3, title: 'Done', project_view_id: 4, position: 300},
	]
	for (const [index, bucket] of buckets.entries()) {
		await BucketFactory.create(1, bucket, index === 0)
	}
	const placement = [[5, 1], [4, 1], [2, 2], [3, 2], [1, 3]]
	for (const [index, [taskId, bucketId]] of placement.entries()) {
		await TaskBucketFactory.create(1, {task_id: taskId, bucket_id: bucketId, project_view_id: 4}, index === 0)
	}
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
	expect.soft(overflow, `${label} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0)
}

// Transitions must stay on the motion scale: no `all`, no layout properties, nothing slower than 250ms.
async function motionViolations(page: Page) {
	return page.evaluate(() => {
		const layout = ['width', 'height', 'inline-size', 'block-size', 'top', 'left', 'right', 'bottom', 'margin', 'padding', 'max-height', 'max-width']
		const found = new Set<string>()
		for (const el of document.querySelectorAll('body *')) {
			const style = getComputedStyle(el)
			const durations = style.transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))
			style.transitionProperty.split(',').map(value => value.trim()).forEach((property, index) => {
				const duration = durations[index % durations.length]
				if (duration > 0 && (property === 'all' || duration > 250 || layout.includes(property))) {
					const name = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName
					found.add(`${el.tagName.toLowerCase()}.${name}: ${property} ${duration}ms`)
				}
			})
		}
		return [...found]
	})
}

async function settle(page: Page) {
	await page.waitForLoadState('networkidle').catch(() => {})
	await page.waitForTimeout(250)
}

const COMBOS = [
	{width: 1440, height: 900, scheme: 'light', language: 'en'},
	{width: 1440, height: 900, scheme: 'dark', language: 'zh-CN'},
	{width: 390, height: 844, scheme: 'light', language: 'zh-CN'},
	{width: 390, height: 844, scheme: 'dark', language: 'en'},
	{width: 320, height: 568, scheme: 'light', language: 'en'},
	{width: 320, height: 568, scheme: 'dark', language: 'zh-CN'},
] as const

// The light desktop pass runs with normal motion so transitions are audited; the others reduce motion.
const auditsMotion = (combo: typeof COMBOS[number]) => combo.width > 400 && combo.scheme === 'light'

const PAGES = [
	{name: 'workspace', path: '/'},
	{name: 'upcoming', path: '/tasks/by/upcoming'},
	{name: 'projects', path: '/projects'},
	{name: 'list', path: '/projects/1/1'},
	{name: 'gantt', path: '/projects/1/2'},
	{name: 'table', path: '/projects/1/3'},
	{name: 'kanban', path: '/projects/1/4'},
	{name: 'task', path: '/tasks/2'},
	{name: 'history', path: '/projects/history'},
	{name: 'arona', path: '/ai'},
	{name: 'drive', path: '/drive'},
	{name: 'settings-general', path: '/user/settings/general'},
	{name: 'settings-ai', path: '/user/settings/ai'},
	{name: 'labels', path: '/labels'},
]

for (const combo of COMBOS) {
	test.describe(`Design tour ${combo.width}px ${combo.scheme} ${combo.language}`, () => {
		test.use({
			timezoneId: TZ,
			locale: combo.language,
			// Phones get a real touch context so coarse-pointer target sizes and 16px inputs apply.
			...(combo.width < 500 ? {hasTouch: true, isMobile: true} : {}),
			currentUser: async ({apiContext}, use) => {
				void apiContext
				const [user] = await UserFactory.create(1, {
					language: combo.language,
					timezone: TZ,
				})
				await use(user)
			},
		})

		test(`main pages fit the viewport at ${combo.width}px ${combo.scheme}`, async ({authenticatedPage: page, apiContext, userToken}) => {
			test.setTimeout(180_000)
			await seed()
			await updateUserSettings(apiContext, userToken, {frontend_settings: {color_schema: combo.scheme}})
			await page.emulateMedia({colorScheme: combo.scheme, reducedMotion: auditsMotion(combo) ? 'no-preference' : 'reduce'})
			await page.setViewportSize({width: combo.width, height: combo.height})

			for (const target of PAGES) {
				await page.goto(target.path)
				await settle(page)
				if (target.name === 'workspace') {
					const dismiss = page.locator('.guide-welcome button').filter({hasText: /Dismiss|不再显示/})
					if (await dismiss.first().isVisible().catch(() => false)) {
						await dismiss.first().click()
					}
				}
				await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${combo.scheme}\\b`))
				await expectNoHorizontalOverflow(page, target.name)
				if (auditsMotion(combo)) {
					expect.soft(await motionViolations(page), `${target.name} transitions`).toEqual([])
				}
				if (combo.width < 500) {
					const small = await page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), select, textarea')]
						.filter(el => (el as HTMLElement).offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16)
						.map(el => el.getAttribute('aria-label') || el.getAttribute('name') || el.className))
					expect.soft(small, `${target.name} inputs below 16px zoom on focus`).toEqual([])
				}
				if (SHOTS) {
					await page.screenshot({
						path: `${SHOTS}/${combo.width}-${combo.scheme}-${combo.language}-${target.name}.png`,
						fullPage: combo.width > 400,
						animations: 'disabled',
					})
				}
			}
		})
	})
}
