import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {BucketFactory} from '../../factories/bucket'
import {TaskFactory} from '../../factories/task'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {apiRootUrl} from '../../support/apiUrl'

// Arona's model is scripted here (no paid model): conversations, turns and the event stream are served by
// page.route, while every write a receipt reports is made against the real API first, so the receipt carries
// the server's actual result and a reload shows the same state.

type FixtureAction = {
	round: number
	tool: string
	arguments: string
	result: string
	success: boolean
	duration_ms: number
}

type FixtureTurn = {
	id: string
	request_id: string
	prompt: string
	status: 'running' | 'completed'
	result: {
		reply: string
		stage: string
		steps: unknown[]
		actions: FixtureAction[]
	}
}

type FixtureConversation = {
	id: string
	title: string
	turns: FixtureTurn[]
	compactions: unknown[]
}

function receipt(tool: string, args: object, result: string): FixtureAction {
	return {
		round: 1,
		tool,
		arguments: JSON.stringify(args),
		result,
		success: true,
		duration_ms: 12,
	}
}

function complete(turn: FixtureTurn, actions: FixtureAction[]) {
	turn.result.actions = actions
	turn.result.reply = 'Done.'
	turn.result.stage = 'completed'
	turn.status = 'completed'
}

async function aronaServer(page: Page) {
	const conversations = new Map<string, FixtureConversation>()
	let respond: (turn: FixtureTurn) => Promise<void> | void = () => {}
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'model',
			name: 'Fixture',
			kind: 'chat',
			protocol: 'anthropic',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'model',
		transcription: '',
		cleanup: '',
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {
		system_prompt: 'Fixture prompt',
		tool_schema: '[]',
	}}))
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const [, id, action] = new URL(request.url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			if (request.method() === 'GET') {
				const items = [...conversations.values()].map(conversation => ({
					id: conversation.id,
					title: conversation.title,
					turn_count: conversation.turns.length,
					running: conversation.turns.some(turn => turn.status === 'running'),
				}))
				return route.fulfill({json: {items, total: items.length, total_pages: 1}})
			}
			const created: FixtureConversation = {
				id: crypto.randomUUID(),
				title: '',
				turns: [],
				compactions: [],
			}
			conversations.set(created.id, created)
			return route.fulfill({status: 201, json: created})
		}
		const conversation = conversations.get(id)
		if (!conversation) return route.fulfill({status: 404, json: {message: 'Not found'}})
		if (action === 'events') {
			const activity = {turn: conversation.turns.at(-1), compacting: false, compactions: []}
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `event: activity\ndata: ${JSON.stringify(activity)}\n\n`,
			})
		}
		if (action === 'messages' && request.method() === 'POST') {
			const body = request.postDataJSON()
			const turn: FixtureTurn = {
				id: crypto.randomUUID(),
				request_id: body.request_id,
				prompt: body.message,
				status: 'running',
				result: {
					reply: '',
					stage: 'model',
					steps: [],
					actions: [],
				},
			}
			conversation.title ||= body.message
			conversation.turns.push(turn)
			await respond(turn)
			return route.fulfill({status: 201, json: conversation})
		}
		return route.fulfill({json: conversation})
	})
	return {
		conversations,
		onMessage(handler: typeof respond) {
			respond = handler
		},
		seed(conversation: FixtureConversation) {
			conversations.set(conversation.id, conversation)
		},
	}
}

function realApi(apiContext: APIRequestContext, token: string) {
	const root = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
	const headers = {Authorization: `Bearer ${token}`}
	return {
		async createTask(project: number, title: string) {
			const response = await apiContext.post(`${root}/projects/${project}/tasks`, {headers, data: {title}})
			expect(response.ok()).toBe(true)
			return response.text()
		},
		async updateTask(id: number, changes: object) {
			const response = await apiContext.patch(`${root}/tasks/${id}`, {
				headers: {
					...headers,
					'Content-Type': 'application/merge-patch+json',
				},
				data: changes,
			})
			expect(response.ok()).toBe(true)
			return response.text()
		},
		async deleteTask(id: number) {
			const response = await apiContext.delete(`${root}/tasks/${id}`, {headers})
			expect(response.ok()).toBe(true)
			return '{"success":true,"deleted":true}'
		},
		async task(id: number) {
			const response = await apiContext.get(`${root}/tasks/${id}`, {headers})
			return {status: response.status(), body: response.ok() ? await response.json() : undefined}
		},
	}
}

// Counts API requests from the moment it is called.
function track(page: Page, matches: (url: URL, method: string) => boolean) {
	const seen: string[] = []
	page.on('request', request => {
		const url = new URL(request.url())
		if (matches(url, request.method())) seen.push(`${request.method()} ${url.pathname}${url.search}`)
	})
	return seen
}

// Rows as seeded; the factories are untyped.
type Seeded = {id: number}

async function seedProject({doneBucket = false} = {}) {
	const [project] = await ProjectFactory.create(1, {title: 'Launch'}) as Seeded[]
	await ProjectViewFactory.create(1, {
		id: 1,
		project_id: project.id,
		title: 'List',
		view_kind: 0,
		position: 100,
	})
	await ProjectViewFactory.create(1, {
		id: 4,
		project_id: project.id,
		title: 'Board',
		view_kind: 3,
		bucket_configuration_mode: 1,
		position: 400,
		...(doneBucket ? {done_bucket_id: 2} : {}),
	}, false)
	await BucketFactory.create(2, {
		id: '{increment}',
		project_view_id: 4,
		title: (i: number) => i === 1 ? 'Backlog' : 'Done',
		position: (i: number) => i * 100,
	})
	return project
}

async function seedTasks(project: number, titles: string[], attributes: Record<string, unknown> = {}) {
	// The server stores whole seconds. A seed with milliseconds in the same second as a receipt's write would look
	// newer than that write, and the receipt would rightly be ignored as stale.
	const seededAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString()
	const tasks = await TaskFactory.create(titles.length, {
		project_id: project,
		title: (i: number) => titles[i - 1],
		created: seededAt,
		updated: seededAt,
		...attributes,
	}) as Seeded[]
	await TaskBucketFactory.create(tasks.length, {
		task_id: (i: number) => tasks[i - 1].id,
		bucket_id: 1,
		project_view_id: 4,
	})
	return tasks
}

async function askFloatingArona(page: Page, message: string) {
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	await panel.getByLabel('Your request').fill(message)
	const send = panel.getByRole('button', {name: 'Send request', exact: true})
	await expect(send).toBeEnabled()
	await send.click()
	return panel
}

const isBoardRead = (url: URL, method: string) => method === 'GET'
	&& url.pathname.endsWith('/api/v2/projects/1/views/4/buckets/tasks')
const isBucketPageRead = (url: URL, method: string) => method === 'GET'
	&& url.pathname.endsWith('/api/v2/projects/1/views/4/tasks')

test.describe('Arona receipts update open pages live', () => {
	test.beforeEach(async ({authenticatedPage: page}) => {
		await page.setViewportSize({width: 1440, height: 900})
	})

	test('a task Arona creates appears on the open board once and its loaded pages are reconciled', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject()
		await seedTasks(project.id, Array.from({length: 30}, (_, index) => `Backlog card ${index + 1}`))
		await page.goto(`/projects/${project.id}/4`)
		const backlog = page.locator('.kanban .bucket').first()
		await expect(backlog.locator('.tasks .task')).toHaveCount(25)

		// Load the backlog's second page; a board refetch would collapse it back to 25 cards.
		const secondPage = page.waitForResponse(response =>
			isBucketPageRead(new URL(response.url()), response.request().method()))
		await backlog.locator('.tasks').evaluate(element => {
			element.scrollTop = element.scrollHeight
			element.dispatchEvent(new Event('scroll'))
		})
		await secondPage
		await expect(backlog.locator('.tasks .task')).toHaveCount(30)

		await page.evaluate(() => {
			(window as unknown as {aronaSamePage: boolean}).aronaSamePage = true
		})
		const boardReads = track(page, isBoardRead)
		const pageReads = track(page, isBucketPageRead)
		let created = ''
		server.onMessage(async turn => {
			created = await api.createTask(project.id, 'Written by Arona')
			complete(turn, [receipt('create_task', {project_id: project.id, title: 'Written by Arona'}, created)])
		})
		const panel = await askFloatingArona(page, 'Add a card for the launch FAQ')
		await expect(panel.locator('.chat-markdown')).toContainText('Done.')

		await expect(backlog.locator('.tasks .task').filter({hasText: 'Written by Arona'})).toHaveCount(1)
		await expect(backlog.locator('.tasks .task')).toHaveCount(31)
		await expect(backlog.locator('.tasks .task').filter({hasText: 'Backlog card'})).toHaveCount(30)
		await page.waitForTimeout(1500)
		await expect(backlog.locator('.tasks .task').filter({hasText: 'Written by Arona'})).toHaveCount(1)
		await expect(backlog.locator('.tasks .task')).toHaveCount(31)
		// A create changes bucket counts and pages, so the board is reconciled once through every loaded
		// page: the bucket list, then the backlog's page 2. Never a first-page-only refetch of 25 cards.
		expect(boardReads).toHaveLength(1)
		expect(pageReads).toHaveLength(1)
		expect(pageReads[0]).toContain('page=2')
		expect(await page.evaluate(() => (window as unknown as {aronaSamePage?: boolean}).aronaSamePage)).toBe(true)
		expect((await api.task(JSON.parse(created).id)).body.title).toBe('Written by Arona')
	})

	test('a task Arona completes moves to the done bucket of the open board', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject({doneBucket: true})
		const [ship] = await seedTasks(project.id, ['Ship release', 'Keep in backlog'])
		await page.goto(`/projects/${project.id}/4`)
		const backlog = page.locator('.kanban .bucket').nth(0)
		const done = page.locator('.kanban .bucket').nth(1)
		await expect(backlog.locator('.tasks')).toContainText('Ship release')

		const boardReads = track(page, isBoardRead)
		server.onMessage(async turn => complete(turn, [
			receipt('update_task', {id: ship.id, done: true}, await api.updateTask(ship.id, {done: true})),
		]))
		await askFloatingArona(page, 'Mark the release as shipped')

		await expect(done.locator('.tasks')).toContainText('Ship release')
		await expect(backlog.locator('.tasks')).not.toContainText('Ship release')
		await expect(backlog.locator('.tasks')).toContainText('Keep in backlog')
		// Completion on an unfiltered board moves the card locally; there is nothing to reconcile.
		expect(boardReads).toEqual([])

		await page.reload()
		await expect(done.locator('.tasks')).toContainText('Ship release')
		expect((await api.task(ship.id)).body.done).toBe(true)
	})

	test('a task Arona completes leaves an open upcoming list that hides done tasks', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject()
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
		const [ship] = await seedTasks(project.id, ['Ship release', 'Keep visible'], {due_date: tomorrow})
		await page.goto('/tasks/by/upcoming')
		const upcoming = page.locator('.upcoming')
		await expect(upcoming.getByText('Ship release', {exact: true})).toBeVisible()
		await expect(upcoming.getByText('Keep visible', {exact: true})).toBeVisible()

		const listReads = track(page, (url, method) => method === 'GET' && url.pathname.endsWith('/api/v2/tasks'))
		server.onMessage(async turn => complete(turn, [
			receipt('update_task', {id: ship.id, done: true}, await api.updateTask(ship.id, {done: true})),
		]))
		await askFloatingArona(page, 'Mark the release as shipped')

		await expect(upcoming.getByText('Ship release', {exact: true})).toHaveCount(0)
		await expect(upcoming.getByText('Keep visible', {exact: true})).toBeVisible()
		await page.waitForTimeout(1500)
		// One membership refetch of the open list, not one per observer or per poll.
		expect(listReads).toHaveLength(1)
	})

	test('a task Arona deletes while its detail is open shows the deleted state', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject()
		const [doomed] = await seedTasks(project.id, ['Obsolete draft'])
		await page.goto(`/tasks/${doomed.id}`)
		await expect(page.locator('.task-view h1[contenteditable="true"]')).toHaveText('Obsolete draft')

		server.onMessage(async turn => complete(turn, [
			receipt('delete_task', {id: doomed.id}, await api.deleteTask(doomed.id)),
		]))
		await askFloatingArona(page, 'Delete this draft')

		// The open detail itself changes, not only the card lists: no stale, editable task stays on screen.
		await expect(page.locator('.task-view-deleted [role="alert"]')).toContainText('This task was deleted.')
		await expect(page.locator('h1[contenteditable]')).toHaveCount(0)
		await expect(page.locator('[contenteditable="true"]').filter({hasText: 'Obsolete draft'})).toHaveCount(0)
		await expect(page).toHaveURL(new RegExp(`/tasks/${doomed.id}$`))
		expect((await api.task(doomed.id)).status).toBe(404)
	})

	test('opening an old completed chat replays none of its write receipts', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject()
		const [current, kept] = await seedTasks(project.id, ['Current title', 'Still here'])
		const stored = (await api.task(current.id)).body
		const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
		server.seed({
			id: 'old-chat',
			title: 'Last week',
			compactions: [],
			turns: [{
				id: 'old-turn',
				request_id: 'old-request',
				prompt: 'Tidy up the launch',
				status: 'completed',
				result: {
					reply: 'Tidied up last week.',
					stage: 'completed',
					steps: [],
					actions: [
						// If these were replayed, the title would be overwritten (the result even looks newer) and
						// the row deleted, and open lists would refetch.
						receipt('update_task', {id: current.id, title: 'Old title'}, JSON.stringify({
							...stored,
							title: 'Old title',
							updated: nextYear,
						})),
						receipt('delete_task', {id: kept.id}, '{"success":true,"deleted":true}'),
						receipt('create_task', {project_id: project.id, title: 'Old card'}, JSON.stringify({
							...stored,
							id: 999,
							title: 'Old card',
						})),
					],
				},
			}],
		})
		await page.goto(`/projects/${project.id}/1`)
		await expect(page.getByText('Still here', {exact: true})).toBeVisible()

		await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
		const panel = page.getByRole('region', {name: 'Arona', exact: true})
		await panel.getByRole('button', {name: 'Conversations', exact: true}).click()
		const oldChat = panel.locator('li[data-chat-id="old-chat"] .history-link')
		await expect(oldChat).toBeVisible()
		await page.waitForTimeout(500)

		const entityRequests = track(page, url => /\/api\/v2\/(tasks|projects|labels)(\/|$)/.test(url.pathname))
		await oldChat.click()
		await expect(panel.locator('.chat-markdown')).toContainText('Tidied up last week.')
		await page.waitForTimeout(2000)

		expect(entityRequests).toEqual([])
		await expect(page.getByText('Still here', {exact: true})).toBeVisible()
		await expect(page.getByText('Current title', {exact: true})).toBeVisible()
		await expect(page.getByText('Old title', {exact: true})).toHaveCount(0)
	})

	test('a run started on the assistant page keeps updating a project page without the floating panel', async ({authenticatedPage: page, apiContext, userToken}) => {
		const api = realApi(apiContext, userToken)
		const server = await aronaServer(page)
		const project = await seedProject()
		const [outline] = await seedTasks(project.id, ['Draft outline'])
		server.seed({
			id: 'archived-chat',
			title: 'Older chat',
			compactions: [],
			turns: [],
		})
		let liveTurn: FixtureTurn | undefined
		server.onMessage(turn => {
			liveTurn = turn
		})

		await page.goto('/ai')
		await page.getByLabel('Your request').fill('Rename the outline while I look at the project')
		await expect(page.getByRole('button', {name: 'Send request', exact: true})).toBeEnabled()
		await page.getByLabel('Your request').press('Enter')
		await expect.poll(() => liveTurn?.status).toBe('running')
		const liveChat = [...server.conversations.values()].find(conversation => conversation.turns.length)!.id

		await page.evaluate(() => {
			(window as unknown as {aronaSamePage: boolean}).aronaSamePage = true
		})
		await page.locator(`li[data-project-id="${project.id}"] .list-menu-link`).first().click()
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/1`))
		await expect(page.getByText('Draft outline', {exact: true})).toBeVisible()

		const streams = track(page, (url, method) => method === 'GET' && url.pathname.endsWith('/events'))
		const archiveReads = track(page, (url, method) => method === 'GET'
			&& url.pathname.endsWith('/api/v2/ai/conversations'))
		const listReads = track(page, (url, method) => method === 'GET'
			&& url.pathname.endsWith(`/api/v2/projects/${project.id}/views/1/tasks`))
		const renamed = await api.updateTask(outline.id, {title: 'Renamed by Arona'})
		complete(liveTurn!, [receipt('update_task', {id: outline.id, title: 'Renamed by Arona'}, renamed)])

		await expect(page.getByText('Renamed by Arona', {exact: true})).toBeVisible({timeout: 10_000})
		await expect(page.getByText('Draft outline', {exact: true})).toHaveCount(0)
		// The finished run is no longer followed.
		await page.waitForTimeout(4000)
		const settledStreams = streams.length
		await page.waitForTimeout(3000)
		expect(streams.length).toBe(settledStreams)

		await expect(page.locator('.arona-panel')).toHaveCount(0)
		expect(await page.evaluate(() => (window as unknown as {aronaSamePage?: boolean}).aronaSamePage)).toBe(true)
		expect(streams.every(request => request.includes(`/ai/conversations/${liveChat}/events`))).toBe(true)
		expect(archiveReads).toEqual([])
		expect(listReads).toHaveLength(1)
	})
})
