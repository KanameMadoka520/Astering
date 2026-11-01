import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {ProjectViewFactory} from '../../factories/project_view'
import {createDefaultViews} from '../project/prepareProjects'

// Routines are configured and checked in through the real v2 API: the table layout is the backend's business.
async function api(apiContext: APIRequestContext, token: string, method: 'get' | 'put' | 'post', path: string, data?: object) {
	const response = await apiContext[method](`/api/v2${path}`, {
		headers: {Authorization: `Bearer ${token}`},
		data,
	})
	expect(response.ok(), `${method.toUpperCase()} ${path}: ${response.status()}`).toBe(true)
	return response.json()
}

async function enableRoutine(apiContext: APIRequestContext, token: string, taskId: number, paused = false) {
	const current = await api(apiContext, token, 'get', `/tasks/${taskId}/routine`)
	return api(apiContext, token, 'put', `/tasks/${taskId}/routine`, {
		enabled: true,
		paused,
		timezone: current.timezone,
		revision: current.revision ?? 0,
	})
}

async function readTask(apiContext: APIRequestContext, token: string, taskId: number) {
	return api(apiContext, token, 'get', `/tasks/${taskId}`)
}

function row(page: Page, title: string) {
	return page.locator('.single-task').filter({hasText: title})
}

test.describe('Daily routines in project views', () => {
	test.beforeEach(async () => {
		await ProjectFactory.create(1, {id: 1})
		await createDefaultViews(1)
	})

	test('a list row checks in for today without completing or striking the task', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Water the plants'})
		await enableRoutine(apiContext, userToken, task.id)
		await page.goto('/projects/1/1')

		const routineRow = row(page, 'Water the plants')
		await expect(routineRow.locator('[data-routine-status="pending"]')).toHaveText('To check in today')
		const checkIns: string[] = []
		page.on('request', request => {
			if (request.method() === 'POST' && request.url().endsWith(`/tasks/${task.id}/routine/check-in`)) checkIns.push(request.url())
		})

		const checkbox = routineRow.getByRole('checkbox', {name: "Check in 'Water the plants' for today"})
		await expect(checkbox).toBeEnabled()
		await routineRow.locator('.base-checkbox__label').click()
		await expect(routineRow.locator('[data-routine-status="done"]')).toHaveText('Checked in today')
		await expect(routineRow.locator('.tasktext')).not.toHaveClass(/\bdone\b/)
		expect(checkIns).toHaveLength(1)

		const stored = await readTask(apiContext, userToken, task.id)
		expect(stored.done).toBe(false)
		expect(stored.routine).toMatchObject({enabled: true, completed_today: true})

		await page.reload()
		await expect(row(page, 'Water the plants').locator('[data-routine-status="done"]')).toBeVisible()
	})

	test('undo from the toast removes only today\'s check-in', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Stretch'})
		await enableRoutine(apiContext, userToken, task.id)
		await page.goto('/projects/1/1')

		await row(page, 'Stretch').locator('.base-checkbox__label').click()
		await expect(row(page, 'Stretch').locator('[data-routine-status="done"]')).toBeVisible()
		await page.getByRole('button', {name: 'Undo'}).click()
		await expect(row(page, 'Stretch').locator('[data-routine-status="pending"]')).toBeVisible()

		const stored = await readTask(apiContext, userToken, task.id)
		expect(stored.done).toBe(false)
		expect(stored.routine.completed_today).toBe(false)
	})

	test('a paused routine cannot be checked in from the list', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Read'})
		await enableRoutine(apiContext, userToken, task.id, true)
		await page.goto('/projects/1/1')

		await expect(row(page, 'Read').locator('[data-routine-status="paused"]')).toHaveText('Routine paused')
		await expect(row(page, 'Read').getByRole('checkbox')).toBeDisabled()
	})

	test('a new local day turns the row back to pending and re-reads the routine', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Journal'})
		const enabled = await enableRoutine(apiContext, userToken, task.id)
		await api(apiContext, userToken, 'post', `/tasks/${task.id}/routine/check-in`, {date: enabled.routine.date, completed: true})

		// Compress the server-provided reset boundary to one minute: advancing a fixture JWT
		// by a full day would expire authentication (these API fixtures have no refresh cookie).
		// Keep real API records and requests, changing only the summary's reset timestamp.
		const reset = Date.now() + 60_000
		await page.route('**/api/v2/**', async route => {
			if (route.request().method() !== 'GET' || !/\/tasks(?:\/|\?|$)/.test(route.request().url())) return route.continue()
			const response = await route.fetch()
			if (!response.headers()['content-type']?.includes('application/json')) return route.fulfill({response})
			const body = await response.json()
			const setReset = (value: unknown) => {
				if (!value || typeof value !== 'object') return
				if ('next_reset_at' in value) value.next_reset_at = new Date(reset).toISOString()
				for (const child of Object.values(value)) setReset(child)
			}
			setReset(body)
			await route.fulfill({response, json: body})
		})
		await page.clock.install()
		await page.goto('/projects/1/1')
		await expect(row(page, 'Journal').locator('[data-routine-status="done"]')).toBeVisible()

		const reread = page.waitForRequest(request => request.method() === 'GET'
			&& new URL(request.url()).pathname.endsWith(`/tasks/${task.id}/routine`))
		await page.clock.fastForward(Math.max(0, reset - Date.now()) + 61_000)
		await expect(row(page, 'Journal').locator('[data-routine-status="pending"]')).toBeVisible()
		await reread
	})

	test('ordinary repeating tasks keep their behaviour next to routines', async ({authenticatedPage: page, apiContext, userToken}) => {
		const due = new Date(Date.now() + 86_400_000)
		await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Pay rent', repeat_after: 86400, due_date: due.toISOString()})
		await page.goto('/projects/1/1')

		const repeating = row(page, 'Pay rent')
		await expect(repeating.locator('[data-routine-status]')).toHaveCount(0)
		const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/tasks/1')
			&& response.request().method() === 'PATCH')
		await repeating.locator('.base-checkbox__label').click()
		await saved

		const stored = await readTask(apiContext, userToken, 1)
		expect(stored.done).toBe(false)
		expect(new Date(stored.due_date).getTime()).toBeGreaterThan(due.getTime())
		expect(stored.routine?.enabled ?? false).toBe(false)
	})

	test('the table shows the routine state in the done column', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Meditate'})
		await enableRoutine(apiContext, userToken, task.id)
		await page.goto('/projects/1/3')

		await expect(page.locator('tr').filter({hasText: 'Meditate'}).locator('[data-routine-status="pending"]')).toBeVisible()
	})

	test('stays readable on a phone', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [task] = await TaskFactory.create(1, {id: 1, project_id: 1, title: 'A routine with a rather long title that has to wrap on phones'})
		await enableRoutine(apiContext, userToken, task.id)
		await page.setViewportSize({width: 390, height: 844})
		await page.goto('/projects/1/1')

		await expect(page.locator('[data-routine-status="pending"]')).toBeVisible()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
	})
})

test.describe('Daily routines on the board', () => {
	async function boardWithRoutine(apiContext: APIRequestContext, token: string) {
		const [project] = await ProjectFactory.create(1, {id: 1})
		const [kanban] = await ProjectViewFactory.create(1, {
			id: 4,
			project_id: project.id,
			view_kind: 3,
			bucket_configuration_mode: 1,
			done_bucket_id: 2,
		})
		const buckets = await BucketFactory.create(2, {id: '{increment}', project_view_id: kanban.id})
		const [task] = await TaskFactory.create(1, {id: 1, project_id: project.id, title: 'Feed the cat'})
		await TaskBucketFactory.create(1, {task_id: task.id, bucket_id: buckets[0].id, project_view_id: kanban.id})
		await enableRoutine(apiContext, token, task.id)
		return {project, kanban, task}
	}

	test('ctrl-click checks a routine in and keeps the card in its bucket', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {project, kanban, task} = await boardWithRoutine(apiContext, userToken)
		await page.goto(`/projects/${project.id}/${kanban.id}`)

		const card = page.locator('.kanban .bucket:nth-child(1) .tasks .task').filter({hasText: 'Feed the cat'})
		await expect(card.locator('[data-routine-status="pending"]')).toBeVisible()
		const checkedIn = page.waitForResponse(response => response.url().endsWith(`/tasks/${task.id}/routine/check-in`))
		await card.click({modifiers: ['ControlOrMeta']})
		expect((await checkedIn).ok()).toBe(true)
		await expect(card.locator('[data-routine-status="done"]')).toBeVisible()
		await expect(page.locator('.kanban .bucket:nth-child(1) .tasks')).toContainText('Feed the cat')

		const stored = await readTask(apiContext, userToken, task.id)
		expect(stored.done).toBe(false)
		expect(stored.routine.completed_today).toBe(true)
	})

	test('a routine dropped on the done bucket goes back and stays undone', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {project, kanban, task} = await boardWithRoutine(apiContext, userToken)
		await page.goto(`/projects/${project.id}/${kanban.id}`)

		const writes: string[] = []
		page.on('request', request => {
			if (request.method() !== 'GET' && /\/buckets\/\d+\/tasks|\/tasks\/\d+\/position/.test(request.url())) writes.push(request.url())
		})
		const card = page.locator('.kanban .bucket:nth-child(1) .tasks .task').filter({hasText: 'Feed the cat'})
		await card.dragTo(page.locator('.kanban .bucket:nth-child(2) .tasks'))

		await expect(page.locator('.global-notification')).toContainText('Routines are not moved to the done bucket.')
		await expect(page.locator('.kanban .bucket:nth-child(1) .tasks')).toContainText('Feed the cat')
		await expect(page.locator('.kanban .bucket:nth-child(2) .tasks')).not.toContainText('Feed the cat')
		expect(writes).toEqual([])
		const stored = await readTask(apiContext, userToken, task.id)
		expect(stored.done).toBe(false)
	})
})
