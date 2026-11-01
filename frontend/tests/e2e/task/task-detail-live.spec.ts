import type {Page, WebSocket} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {createProjects} from '../project/prepareProjects'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {UserFactory} from '../../factories/user'
import {UserProjectFactory} from '../../factories/users_project'
import {TEST_PASSWORD} from '../../support/constants'
import {updateUserSettings} from '../../support/updateUserSettings'

const YEAR = new Date().getUTCFullYear()
const at = (date: string) => `${date}T12:00:00Z`
// The API answers an unset date with the zero time instead of null.
const isUnset = (value: unknown) => !value || String(value).startsWith('0001-01-01')
const sameInstant = (value: unknown) => new Date(String(value)).toISOString()

type PatchOperation = {op: string, path: string, value: unknown}

const isTaskUrl = (url: URL, taskId: number) => url.pathname.endsWith(`/api/v2/tasks/${taskId}`)

// Records the JSON patch bodies the page sends for one task. Chromium reports no body for requests
// that are not intercepted, so the bodies are read in a pass-through route.
async function recordTaskPatches(page: Page, taskId: number) {
	const bodies: PatchOperation[][] = []
	await page.route(url => isTaskUrl(url, taskId), route => {
		if (route.request().method() === 'PATCH') {
			bodies.push(route.request().postDataJSON())
		}
		return route.fallback()
	})
	return bodies
}

function taskPatched(page: Page, taskId: number) {
	return page.waitForResponse(response => response.request().method() === 'PATCH'
		&& isTaskUrl(new URL(response.url()), taskId))
}

function detailField(page: Page, title: string) {
	return page.locator('.task-view .columns.details .column').filter({hasText: title})
}

async function openTaskDeletion(page: Page) {
	await page.locator('.task-view .action-buttons').getByRole('button', {name: 'Delete', exact: true}).click()
	const confirmation = page.getByRole('dialog', {name: 'Delete this task', exact: true})
	await expect(confirmation).toBeVisible()
	return confirmation.getByRole('button', {name: 'Delete task', exact: true})
}

test.describe('Task detail deletion identity', () => {
	for (const failFirst of [false, true]) {
		test(failFirst
			? 'a failed modal deletion preserves the task and can be retried without reopening'
			: 'a successful modal deletion returns to its board and removes the stored task', async ({
			authenticatedPage: page,
			apiContext,
			userToken,
		}) => {
			const [project] = await createProjects(1)
			const kanban = project.views[3]
			const [bucket] = await BucketFactory.create(1, {project_view_id: kanban.id})
			const [task] = await TaskFactory.create(1, {
				id: 1,
				project_id: project.id,
				title: 'Confirm this task only',
			})
			await TaskBucketFactory.create(1, {
				task_id: task.id,
				bucket_id: bucket.id,
				project_view_id: kanban.id,
			})
			const headers = {Authorization: `Bearer ${userToken}`}
			const read = () => apiContext.get(`/api/v2/tasks/${task.id}`, {headers})
			const boardPath = `/projects/${project.id}/${kanban.id}`
			let deletions = 0
			await page.route(url => isTaskUrl(url, task.id), async route => {
				if (route.request().method() !== 'DELETE') return route.fallback()
				deletions++
				if (failFirst && deletions === 1) {
					return route.fulfill({
						status: 503,
						contentType: 'application/problem+json',
						body: JSON.stringify({title: 'Temporary test failure', status: 503, detail: 'Retry this test deletion.'}),
					})
				}
				return route.continue()
			})

			await page.goto(boardPath)
			const card = page.locator('.kanban .bucket .tasks .task').filter({hasText: task.title})
			await card.click()
			await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
			const confirm = await openTaskDeletion(page)

			if (failFirst) {
				const failed = page.waitForResponse(response => response.request().method() === 'DELETE'
					&& isTaskUrl(new URL(response.url()), task.id))
				await confirm.click()
				expect((await failed).status()).toBe(503)
				await expect(confirm).toBeEnabled()
				await expect(page.getByRole('dialog', {name: 'Delete this task', exact: true})).toContainText(task.title)
				await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
				const stillStored = await read()
				expect(stillStored.ok()).toBe(true)
				expect((await stillStored.json()).title).toBe(task.title)
			}

			const deleted = page.waitForResponse(response => response.request().method() === 'DELETE'
				&& isTaskUrl(new URL(response.url()), task.id))
			await confirm.click()
			expect((await deleted).ok()).toBe(true)
			await expect(page).toHaveURL(new RegExp(`${boardPath}$`))
			await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
			await expect(card).toHaveCount(0)
			expect((await read()).status()).toBe(404)
			expect(deletions).toBe(failFirst ? 2 : 1)
		})
	}

	test('a slow deletion does not navigate a later visit to the same full-page task', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const [project] = await createProjects(1)
		const [task] = await TaskFactory.create(1, {
			id: 1,
			project_id: project.id,
			title: 'Return while deletion is pending',
		})
		const taskPath = `/tasks/${task.id}`
		const projectUrl = new RegExp(`/projects/${project.id}/\\d+$`)
		const heading = page.locator('.task-view h1[contenteditable]')
		await page.goto(taskPath)
		await expect(heading).toContainText(task.title)
		// Build real SPA history from a full-page task, so Back restores that presentation rather than a modal.
		await page.locator('.task-view .back-button').click()
		await expect(page).toHaveURL(projectUrl)
		await page.goBack()
		await expect(page).toHaveURL(new RegExp(`${taskPath}$`))
		await expect(heading).toContainText(task.title)
		await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
		const originalDocument = await page.evaluateHandle(() => document)

		let releaseDelete!: () => void
		const released = new Promise<void>(resolve => {releaseDelete = resolve})
		let deleteArrived!: () => void
		const arrived = new Promise<void>(resolve => {deleteArrived = resolve})
		await page.route(url => isTaskUrl(url, task.id), async route => {
			if (route.request().method() !== 'DELETE') return route.fallback()
			deleteArrived()
			// Do not reach the API yet: the task must still exist when the later visit loads.
			await released
			await route.continue()
		})
		try {
			await (await openTaskDeletion(page)).click()
			await arrived
			await page.goForward()
			await expect(page).toHaveURL(projectUrl)
			await expect(page.locator('.task-view')).toHaveCount(0)
			await page.goBack()
			await expect(page).toHaveURL(new RegExp(`${taskPath}$`))
			await expect(heading).toContainText(task.title)
			const deleted = page.waitForResponse(response => response.request().method() === 'DELETE'
				&& isTaskUrl(new URL(response.url()), task.id))
			releaseDelete()
			expect((await deleted).ok()).toBe(true)
			await expect(page.locator('.task-view-deleted')).toContainText('This task was deleted.')
			// The new visit receives the deletion from the shared cache, but the old callback owns no navigation.
			await expect(page).toHaveURL(new RegExp(`${taskPath}$`))
			expect(await page.evaluate(initial => initial === document, originalDocument)).toBe(true)
			expect((await apiContext.get(`/api/v2/tasks/${task.id}`, {
				headers: {Authorization: `Bearer ${userToken}`},
			})).status()).toBe(404)
		} finally {
			releaseDelete()
			await originalDocument.dispose()
		}
	})
})

test.describe('Task detail end date', () => {
	test.use({timezoneId: 'UTC'})

	test('clearing the end date stays cleared after a reload', async ({authenticatedPage: page, apiContext, userToken}) => {
		await createProjects(1)
		const [task] = await TaskFactory.create(1, {
			id: 1,
			project_id: 1,
			title: 'Plan the launch',
			start_date: at(`${YEAR}-03-02`),
			due_date: at(`${YEAR}-03-12`),
			end_date: at(`${YEAR}-03-20`),
		})
		const read = async () => (await apiContext.get(`/api/v2/tasks/${task.id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})).json()
		const patches = await recordTaskPatches(page, task.id)

		await page.goto(`/tasks/${task.id}`)
		const end = detailField(page, 'End Date')
		await expect(end).toBeVisible()

		const saved = taskPatched(page, task.id)
		await end.getByRole('button', {name: 'Remove end date'}).click()
		expect((await saved).ok()).toBe(true)
		await expect(page.locator('.global-notification')).toContainText('Success')

		// Only the cleared end date goes out; the due date is never copied into it.
		expect(patches).toEqual([[{op: 'add', path: '/end_date', value: '0001-01-01T00:00:00Z'}]])
		await expect(end).toHaveCount(0)

		await page.reload()
		await expect(page.locator('.task-view h1[contenteditable]')).toContainText('Plan the launch')
		await expect(detailField(page, 'Due Date')).toBeVisible()
		await expect(detailField(page, 'End Date')).toHaveCount(0)

		const stored = await read()
		expect(isUnset(stored.end_date)).toBe(true)
		expect(sameInstant(stored.start_date)).toBe(sameInstant(at(`${YEAR}-03-02`)))
		expect(sameInstant(stored.due_date)).toBe(sameInstant(at(`${YEAR}-03-12`)))
	})

	test('a start and due date without an end date stay that way and the timeline ends at the due day', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		await createProjects(1)
		const [task] = await TaskFactory.create(1, {
			id: 1,
			project_id: 1,
			title: 'Write the brief',
			priority: 1,
			start_date: at(`${YEAR}-03-02`),
			due_date: at(`${YEAR}-03-12`),
		})
		const headers = {Authorization: `Bearer ${userToken}`}
		const patches = await recordTaskPatches(page, task.id)

		await page.goto(`/tasks/${task.id}`)
		await expect(detailField(page, 'End Date')).toHaveCount(0)

		// An unrelated save used to copy the due date into the empty end date.
		const saved = taskPatched(page, task.id)
		await detailField(page, 'Priority').locator('.select select').selectOption('Urgent')
		expect((await saved).ok()).toBe(true)
		await expect(page.locator('.global-notification')).toContainText('Success')
		expect(patches).toEqual([[{op: 'add', path: '/priority', value: 4}]])
		await expect(detailField(page, 'End Date')).toHaveCount(0)

		const stored = await (await apiContext.get(`/api/v2/tasks/${task.id}`, {headers})).json()
		expect(stored.priority).toBe(4)
		expect(isUnset(stored.end_date)).toBe(true)

		// The read model falls back to the due date for the end of the range.
		const timeline = await (await apiContext.get('/api/v2/projects/timeline', {
			headers,
			params: {
				year: YEAR,
				timezone: 'UTC',
			},
		})).json()
		expect(timeline.items.find((item: {id: number}) => item.id === 1)).toMatchObject({
			start_date: `${YEAR}-03-02`,
			end_date: `${YEAR}-03-12`,
			scheduled_days: 11,
		})

		await page.goto('/projects/history')
		const day = new Intl.DateTimeFormat('en', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		})
		const lane = page.locator('.lane').filter({hasText: 'First Project'})
		await expect(lane).toContainText(`${day.format(new Date(at(`${YEAR}-03-02`)))} – ${day.format(new Date(at(`${YEAR}-03-12`)))}`)
		await expect(lane).toContainText(`of 11 scheduled days in ${YEAR}`)

		const after = await (await apiContext.get(`/api/v2/tasks/${task.id}`, {headers})).json()
		expect(isUnset(after.end_date)).toBe(true)
	})
})

// Subscriptions are sent in one batch after auth, so the last event of the set proves all of them arrived.
function waitForSubscription(page: Page, event: string) {
	return page.waitForEvent('websocket').then((socket: WebSocket) => socket.waitForEvent('framesent', {
		predicate: frame => {
			const message = JSON.parse(frame.payload.toString())
			return message.action === 'subscribe' && message.event === event
		},
	}))
}

test.describe('Task detail live updates', () => {
	test.use({timezoneId: 'UTC'})

	test('a change made elsewhere shows in the open detail while the description draft stays', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		const [owner] = await UserFactory.create(1, {id: 100}, false)
		const ownerLogin = await apiContext.post('login', {data: {
			username: owner.username,
			password: TEST_PASSWORD,
		}})
		const {token: ownerToken} = await ownerLogin.json()
		await ProjectFactory.create(1, {
			id: 100,
			owner_id: 100,
			title: 'Shared plans',
		}, false)
		await ProjectViewFactory.create(1, {
			id: 100,
			project_id: 100,
		}, false)
		await TaskFactory.create(1, {
			id: 100,
			project_id: 100,
			created_by_id: 100,
			title: 'Venue booking',
			description: '<p>Stored notes</p>',
			due_date: at('2030-06-15'),
		}, false)
		await UserProjectFactory.create(1, {
			id: 100,
			project_id: 100,
			user_id: currentUser.id,
			permission: 1,
		}, false)
		await updateUserSettings(apiContext, userToken, {frontend_settings: {
			date_display: 'yyyy-mm-dd',
			time_format: '24h',
		}})

		// Saves wait until the end, so the draft is certainly unsaved while the change arrives.
		// Each body is recorded as it arrives, before the hold.
		const patches: PatchOperation[][] = []
		let releaseSaves!: () => void
		const savesReleased = new Promise<void>(resolve => {releaseSaves = resolve})
		await page.route(url => isTaskUrl(url, 100), async route => {
			if (route.request().method() === 'PATCH') {
				patches.push(route.request().postDataJSON())
				await savesReleased
			}
			await route.continue()
		})
		let detailReads = 0
		page.on('request', request => {
			if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/v2/tasks/100')) detailReads++
		})

		const subscribed = waitForSubscription(page, 'notification.created')
		await page.goto('/tasks/100')
		await subscribed
		const due = detailField(page, 'Due Date').locator('.datepicker .show')
		await expect(due).toContainText('2030-06-15')

		await page.locator('.task-view .details.content.description .tiptap button.done-edit').click()
		const editor = page.locator('.task-view .details.content.description .tiptap__editor .tiptap.ProseMirror')
		await editor.fill('Draft written while the date moves')
		const readsBeforeChange = detailReads

		const headers = {Authorization: `Bearer ${ownerToken}`}
		const moved = await apiContext.patch('/api/v2/tasks/100', {
			headers: {
				...headers,
				'Content-Type': 'application/merge-patch+json',
			},
			data: {due_date: at('2031-02-20')},
		})
		expect(moved.ok()).toBe(true)
		// The mention notification reaches the page over the websocket and refetches the open task.
		const comment = await apiContext.put('tasks/100/comments', {
			headers,
			data: {comment: `<p>Moved the date <mention-user data-id="${currentUser.username}">@${currentUser.username}</mention-user></p>`},
		})
		expect(comment.ok()).toBe(true)

		await expect(due).toContainText('2031-02-20')
		expect(detailReads).toBeGreaterThan(readsBeforeChange)
		await expect(editor).toContainText('Draft written while the date moves')
		await expect(editor).not.toContainText('Stored notes')
		// Nothing but the description may go out, never the date this page loaded first.
		expect(patches.every(body => body.length === 1 && body[0].path === '/description')).toBe(true)

		releaseSaves()
		await page.locator('[data-cy="saveEditor"]').filter({hasText: 'Save'}).click()
		const read = async () => (await apiContext.get('/api/v2/tasks/100', {
			headers: {Authorization: `Bearer ${userToken}`},
		})).json()
		await expect.poll(async () => (await read()).description).toContain('Draft written while the date moves')

		expect(patches.map(body => body.map(operation => operation.path))).toEqual([['/description']])
		const stored = await read()
		expect(sameInstant(stored.due_date)).toBe(sameInstant(at('2031-02-20')))

		await page.reload()
		await expect(due).toContainText('2031-02-20')
		await expect(page.locator('.task-view .details.content.description')).toContainText('Draft written while the date moves')
	})
})
