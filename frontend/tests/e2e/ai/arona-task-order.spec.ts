import type {
	APIRequestContext,
	Locator,
	Page,
} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {Factory} from '../../support/factory'
import {apiRootUrl} from '../../support/apiUrl'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {BucketFactory} from '../../factories/bucket'
import {TaskFactory} from '../../factories/task'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {updateUserSettings} from '../../support/updateUserSettings'

const labels = {
	en: {open: 'Open floating Arona', arona: 'Arona', request: 'Your request', send: 'Send request', manual: 'View manual order'},
	'zh-CN': {open: '打开悬浮阿罗娜', arona: '阿罗娜', request: '你的指令', send: '发送指令', manual: '按手动顺序查看'},
}

class TaskPositionFactory extends Factory {
	static table = 'task_positions'
}

type OrderScope = {
	project_id: number
	view_id: number
	bucket_id: number
}

type OrderPage = {
	order_version: string
	items: {
		id: number
		position: number
	}[]
}

type OrderResult = OrderScope & {
	view_kind: 'list' | 'table' | 'kanban'
	task_ids: number[]
	order_version: string
	changed_positions: {
		task_id: number
		project_view_id: number
		position: number
	}[]
	position_recalculated: boolean
	manual_order_saved: boolean
	verified: boolean
}

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
	status: 'completed'
	result: {
		reply: string
		stage: 'completed'
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

// Only the model/conversation is scripted. Every reported reorder uses the real authenticated API first.
async function scriptedArona(page: Page, reorder: () => Promise<FixtureAction>, withModelStep = false) {
	let conversation: FixtureConversation | undefined
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'order-fixture',
			name: 'Order fixture',
			kind: 'chat',
			protocol: 'anthropic',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'order-fixture',
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
				const items = conversation ? [{
					id: conversation.id,
					title: conversation.title,
					turn_count: conversation.turns.length,
					running: false,
				}] : []
				return route.fulfill({json: {
					items,
					total: items.length,
					total_pages: 1,
				}})
			}
			conversation = {
				id: crypto.randomUUID(),
				title: 'Manual order',
				turns: [],
				compactions: [],
			}
			return route.fulfill({status: 201, json: conversation})
		}
		if (!conversation || conversation.id !== id) {
			return route.fulfill({status: 404, json: {message: 'Not found'}})
		}
		if (action === 'events') {
			const activity = {
				turn: conversation.turns.at(-1),
				compacting: false,
				compactions: [],
				compact_error: '',
				compact_progress: undefined,
			}
			return route.fulfill({
				contentType: 'text/event-stream',
				body: `event: activity\ndata: ${JSON.stringify(activity)}\n\n`,
			})
		}
		if (action === 'messages' && request.method() === 'POST') {
			const body = request.postDataJSON()
			const action = await reorder()
			conversation.turns.push({
				id: crypto.randomUUID(),
				request_id: body.request_id,
				prompt: body.message,
				status: 'completed',
				result: {
					reply: 'Manual order saved.',
					stage: 'completed',
					steps: withModelStep ? [{round: action.round}] : [],
					actions: [action],
				},
			})
			return route.fulfill({status: 201, json: conversation})
		}
		return route.fulfill({json: conversation})
	})
}

function orderApi(apiContext: APIRequestContext, token: string) {
	const root = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
	const headers = {Authorization: `Bearer ${token}`}
	function endpoint(scope: OrderScope) {
		return `${root}/projects/${scope.project_id}/views/${scope.view_id}/task-order`
	}
	async function read(scope: OrderScope, page = 1): Promise<OrderPage> {
		const response = await apiContext.get(endpoint(scope), {
			headers,
			params: {
				bucket_id: scope.bucket_id,
				page,
			},
		})
		expect(response.ok()).toBe(true)
		return response.json()
	}
	return {
		read,
		async moveToFront(scope: OrderScope, task: number) {
			const before = await read(scope)
			expect(before.order_version).toMatch(/^[a-f0-9]{64}$/)
			const args = {
				...scope,
				task_ids: [task],
				after_task_id: 0,
				before_task_id: before.items[0].id,
				order_version: before.order_version,
			}
			const response = await apiContext.post(endpoint(scope), {
				headers,
				data: {
					bucket_id: scope.bucket_id,
					task_ids: args.task_ids,
					after_task_id: args.after_task_id,
					before_task_id: args.before_task_id,
					order_version: args.order_version,
				},
			})
			expect(response.ok()).toBe(true)
			const result = await response.json() as OrderResult
			expect(result.view_kind).toBe(scope.view_id === 4 ? 'kanban' : 'list')
			expect(result).toMatchObject({
				...scope,
				task_ids: [task],
				manual_order_saved: true,
				verified: true,
			})
			expect(result.changed_positions.some(position => position.task_id === task)).toBe(true)
			// A normal front insertion uses the available gap and writes only the moved card.
			expect(result.position_recalculated).toBe(false)
			expect(result.changed_positions).toHaveLength(1)
			return {
				round: 1,
				tool: 'reorder_view_tasks',
				arguments: JSON.stringify(args),
				result: JSON.stringify(result),
				success: true,
				duration_ms: 12,
			}
		},
	}
}

async function seedProject(titles: string[]) {
	await ProjectFactory.create(1, {id: 1, title: 'Ordered project'})
	await ProjectViewFactory.create(1, {
		id: 1,
		project_id: 1,
		title: 'List',
		view_kind: 0,
		position: 100,
	})
	await ProjectViewFactory.create(1, {
		id: 4,
		project_id: 1,
		title: 'Board',
		view_kind: 3,
		bucket_configuration_mode: 1,
		position: 400,
	}, false)
	await BucketFactory.create(1, {
		id: 1,
		project_view_id: 4,
		title: 'Backlog',
		position: 100,
	})
	const seededAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString()
	await TaskFactory.create(titles.length, {
		project_id: 1,
		title: (index: number) => titles[index - 1],
		created: seededAt,
		updated: seededAt,
	})
	await TaskBucketFactory.create(titles.length, {
		task_id: '{increment}',
		bucket_id: 1,
		project_view_id: 4,
	})
	for (const view of [1, 4]) {
		await TaskPositionFactory.create(titles.length, {
			task_id: '{increment}',
			project_view_id: view,
			position: (index: number) => index * 100 + index * index,
		}, view === 1)
	}
}

async function ask(page: Page, language: keyof typeof labels = 'en') {
	const text = labels[language]
	await page.getByRole('button', {name: text.open, exact: true}).click()
	const panel = page.getByRole('region', {name: text.arona, exact: true})
	await panel.getByLabel(text.request).fill('Put the last task first in this view')
	await panel.getByRole('button', {name: text.send, exact: true}).click()
	await expect(panel.locator('.chat-markdown')).toContainText('Manual order saved.')
	return panel
}

async function taskIDs(rows: Locator) {
	return rows.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-task-id'))))
}

async function rememberDocument(page: Page) {
	await page.evaluate(() => {
		(window as unknown as {taskOrderDocument: boolean}).taskOrderDocument = true
	})
}

async function expectSameDocument(page: Page) {
	expect(await page.evaluate(() =>
		(window as unknown as {taskOrderDocument?: boolean}).taskOrderDocument)).toBe(true)
}

test.describe('Arona view order receipts', () => {
	test('a reorder refreshes two loaded board pages without collapsing or resetting scroll', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, testInfo) => {
		await page.setViewportSize({width: 1440, height: 900})
		await seedProject(Array.from({length: 60}, (_, index) => `Card ${String(index + 1).padStart(2, '0')}`))
		const api = orderApi(apiContext, userToken)
		const scope = {
			project_id: 1,
			view_id: 4,
			bucket_id: 1,
		}
		let scrollBefore = 0
		await scriptedArona(page, async () => {
			scrollBefore = await page.locator('.kanban .bucket .tasks').evaluate(element => element.scrollTop)
			return api.moveToFront(scope, 60)
		}, true)
		await page.goto('/projects/1/4')
		const backlog = page.locator('.kanban .bucket').first()
		const cards = backlog.locator('.task[data-task-id]')
		const scroller = backlog.locator('.tasks')
		await expect(cards).toHaveCount(25)
		const secondPage = page.waitForResponse(response => {
			const url = new URL(response.url())
			return url.pathname.endsWith('/projects/1/views/4/tasks')
				&& url.searchParams.get('page') === '2'
		})
		await scroller.evaluate(element => {
			element.scrollTop = element.scrollHeight
			element.dispatchEvent(new Event('scroll'))
		})
		await secondPage
		await expect(cards).toHaveCount(50)
		await scroller.evaluate(element => {
			element.scrollTop = 450
		})
		await rememberDocument(page)
		const panel = await ask(page)
		await expect(panel.locator('.task-order-receipt')).toHaveCount(1)

		const expected = [60, ...Array.from({length: 49}, (_, index) => index + 1)]
		await expect.poll(() => taskIDs(cards)).toEqual(expected)
		await expect(cards).toHaveCount(50)
		const scrollAfter = await scroller.evaluate(element => element.scrollTop)
		expect(scrollBefore).toBeGreaterThan(200)
		expect(scrollAfter).toBeGreaterThanOrEqual(scrollBefore - 2)
		// Browser scroll anchoring may add one card's height when it is inserted above the viewport.
		const cardHeight = await cards.first().evaluate(element => element.getBoundingClientRect().height)
		expect(scrollAfter).toBeLessThanOrEqual(scrollBefore + cardHeight + 24)
		await expectSameDocument(page)
		expect((await api.read(scope)).items.map(item => item.id)).toEqual(expected.slice(0, 25))
		expect((await api.read({...scope, view_id: 1, bucket_id: 0})).items[0].id).toBe(1)
		await page.screenshot({path: testInfo.outputPath('board-order-two-pages.png')})

		await page.reload()
		await expect(cards).toHaveCount(25)
		await expect.poll(() => taskIDs(cards)).toEqual(expected.slice(0, 25))
	})

	for (const {width, language} of [
		{width: 1440, language: 'en'},
		{width: 390, language: 'en'},
		{width: 390, language: 'zh-CN'},
	] as const) {
		test(`title order stays selected until the manual-order link is used at ${width}px ${language}`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
		}, testInfo) => {
			await page.setViewportSize({width, height: 900})
			await updateUserSettings(apiContext, userToken, {language})
			await seedProject(Array.from({length: 60}, (_, index) => `Task ${String(index + 1).padStart(2, '0')}`))
			const api = orderApi(apiContext, userToken)
			const scope = {
				project_id: 1,
				view_id: 1,
				bucket_id: 0,
			}
			await scriptedArona(page, () => api.moveToFront(scope, 60))
			await page.goto('/projects/1/1?sort=title:asc&s=Task&page=2')
			const rows = page.locator('.project-list ul.tasks > [data-task-id]')
			const titlePage = Array.from({length: 10}, (_, index) => index + 51)
			await expect.poll(() => taskIDs(rows)).toEqual(titlePage)
			await rememberDocument(page)
			const panel = await ask(page, language)

			await expect.poll(() => taskIDs(rows)).toEqual(titlePage)
			expect(new URL(page.url()).searchParams.get('sort')).toBe('title:asc')
			expect(new URL(page.url()).searchParams.get('page')).toBe('2')
			const receipt = panel.locator('.task-order-receipt')
			await expect(receipt).toBeVisible()
			const link = receipt.getByRole('link', {name: labels[language].manual, exact: true})
			await expect(link).toBeVisible()
			await link.click()
			await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('position:asc')
			expect(new URL(page.url()).searchParams.get('s')).toBe('Task')
			expect(new URL(page.url()).searchParams.get('page')).not.toBe('2')
			const manualPage = [60, ...Array.from({length: 49}, (_, index) => index + 1)]
			await expect.poll(() => taskIDs(rows)).toEqual(manualPage)
			await expectSameDocument(page)
			expect((await api.read(scope)).items.map(item => item.id)).toEqual(manualPage.slice(0, 25))
			expect((await api.read({...scope, view_id: 4, bucket_id: 1})).items[0].id).toBe(1)
			await page.screenshot({path: testInfo.outputPath(`list-order-receipt-${width}-${language}.png`)})

			await page.reload()
			await expect.poll(() => taskIDs(rows)).toEqual(manualPage)
			expect(new URL(page.url()).searchParams.get('sort')).toBe('position:asc')
		})
	}
})
