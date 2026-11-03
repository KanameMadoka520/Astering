import type {Page} from '@playwright/test'
import type {Action, ChatTurn, Conversation} from '../../../src/client/generated'
import {test, expect} from '../../support/fixtures'
import {
	createCompassEntry,
	createCompassSpace,
	listCompassEntries,
	readCompassEntry,
	updateCompassEntry,
} from '../compass/compassApi'

// Only the model conversation is scripted. Each reported Compass write goes through the real API
// first; the open page then consumes the same action receipt as a production assistant run.
async function compassAssistant(page: Page, respond: () => Promise<Action>) {
	const conversations = new Map<string, Conversation>()
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'fixture',
			name: 'Fixture',
			kind: 'chat',
			protocol: 'anthropic',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'fixture',
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {system_prompt: 'Fixture', tool_schema: '[]'}}))
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const [, id, action] = new URL(request.url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			if (request.method() === 'GET') return route.fulfill({json: {
				items: [...conversations.values()].map(item => ({
					id: item.id,
					title: item.title,
					turn_count: item.turns?.length ?? 0,
					running: false,
				})),
				total: conversations.size,
				total_pages: 1,
			}})
			const created: Conversation = {id: crypto.randomUUID(), title: '', turns: [], compactions: []}
			conversations.set(created.id!, created)
			return route.fulfill({status: 201, json: created})
		}
		const conversation = conversations.get(id)
		if (!conversation) return route.fulfill({status: 404, json: {message: 'Not found'}})
		if (action === 'events') return route.fulfill({
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({
				turn: conversation.turns?.at(-1),
				compacting: false,
				compactions: [],
				compact_error: '',
				compact_progress: null,
			})}\n\n`,
		})
		if (action === 'messages' && request.method() === 'POST') {
			const body = request.postDataJSON()
			const turn: ChatTurn = {
				id: crypto.randomUUID(),
				request_id: body.request_id,
				prompt: body.message,
				status: 'completed',
				result: {
					reply: 'Compass fixture complete',
					stage: 'completed',
					steps: [],
					actions: [await respond()],
				},
			}
			conversation.title ||= body.message
			conversation.turns!.push(turn)
			return route.fulfill({status: 201, json: conversation})
		}
		return route.fulfill({json: conversation})
	})
}

function receipt(tool: string, args: object, result: object): Action {
	return {
		round: 1,
		tool,
		arguments: JSON.stringify(args),
		result: JSON.stringify(result),
		success: true,
		duration_ms: 12,
	}
}

async function ask(page: Page) {
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	await panel.getByLabel('Your request').fill('Apply the prepared Compass fixture')
	await panel.getByRole('button', {name: 'Send request', exact: true}).click()
	await expect(panel.getByText('Compass fixture complete', {exact: true})).toBeVisible()
	await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
}

for (const width of [1440, 390]) {
	test(`Compass receipts update the open library without reloading at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}) => {
		await page.setViewportSize({width, height: 900})
		const space = await createCompassSpace(apiContext, userToken, {title: 'Receipt library'})
		await createCompassEntry(apiContext, userToken, space.id, {title: 'Existing entry'})
		let createdId = 0
		await compassAssistant(page, async () => {
			const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Added through Arona', category: 'Compass receipts'})
			createdId = entry.id
			return receipt('create_compass_entry', {space_id: space.id, title: entry.title}, entry)
		})
		await page.goto(`/compass/spaces/${space.id}`)
		const titles = page.locator('.compass-library__list > li .compass-entry-row__title')
		await expect(titles).toHaveText(['Existing entry'])
		const marker = await page.evaluate(() => {
			Object.assign(window, {compassReceiptDocument: crypto.randomUUID()})
			return (window as Window & {compassReceiptDocument: string}).compassReceiptDocument
		})
		const taskReads: string[] = []
		page.on('request', request => {
			if (request.method() === 'GET' && /\/api\/v2\/(tasks(?:\/|$)|projects\/\d+\/views\/)/.test(new URL(request.url()).pathname)) taskReads.push(request.url())
		})
		await ask(page)
		await expect(titles).toHaveText(['Added through Arona', 'Existing entry'])
		await expect(page.locator('.compass-library__summary')).toHaveText('2 entries')
		expect(taskReads).toHaveLength(0)
		expect(await page.evaluate(() => (window as Window & {compassReceiptDocument?: string}).compassReceiptDocument)).toBe(marker)
		expect((await listCompassEntries(apiContext, userToken, space.id)).items.map(item => item.id)).toContain(createdId)
		await page.reload()
		await expect(titles).toHaveText(['Added through Arona', 'Existing entry'])
	})
}

test('a Compass receipt refresh preserves a dirty editor and its real revision conflict', async ({authenticatedPage: page, apiContext, userToken}) => {
	await page.setViewportSize({width: 1440, height: 900})
	const space = await createCompassSpace(apiContext, userToken)
	const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Original', content: '<p>Original body</p>'})
	await compassAssistant(page, async () => {
		const changed = await updateCompassEntry(apiContext, userToken, entry.id, {title: 'Saved by Arona', content: '<p>Server content</p>'})
		return receipt('update_compass_entry', {id: entry.id, revision: entry.revision, title: changed.title}, changed)
	})
	await page.goto(`/compass/entries/${entry.id}/edit`)
	const desk = page.locator('.compass-desk')
	const title = desk.getByLabel('Title', {exact: true})
	await expect(title).toHaveValue('Original')
	await title.fill('My unsaved draft')
	let refreshed = 0
	page.on('response', response => {
		if (response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith(`/compass/entries/${entry.id}`)) refreshed++
	})
	await ask(page)
	await expect.poll(() => refreshed).toBeGreaterThan(0)
	await expect(title).toHaveValue('My unsaved draft')
	await desk.locator('.compass-desk__save').click()
	await expect(desk.locator('.compass-conflict')).toBeVisible()
	await expect(title).toHaveValue('My unsaved draft')
	expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({title: 'Saved by Arona', revision: entry.revision + 1})
})
