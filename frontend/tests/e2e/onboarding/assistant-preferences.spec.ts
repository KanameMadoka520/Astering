import {test, expect} from '../../support/fixtures'
import type {Page} from '@playwright/test'
import type {AssistantPreferences} from '../../../src/client/generated'
import {apiRootUrl} from '../../support/apiUrl'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
test.beforeEach(async ({apiContext, userToken}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const old = await (await apiContext.get(`${api}/ai/preferences`, {headers})).json()
	expect((await apiContext.post(`${api}/ai/preferences`, {headers, data: {revision: old.revision ?? 0, default_profile: 'ask', profiles: []}})).ok()).toBeTruthy()
})

for (const width of [1440, 390]) {
	test(`scenario templates ${width}px explain permissions, persist defaults and keep composer reachable`, async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width, height: 900})
		await page.goto('/ai')
		await expect(page.locator('.profile-switch select')).toHaveValue('ask')
		await expect(page.getByLabel('Working mode')).toHaveCount(0)
		await expect(page.getByLabel('Segment token soft limit')).toHaveCount(0)
		await page.getByRole('button', {name: 'Scenarios & preferences', exact: true}).waitFor()
		await expect(page.locator('.vikunja-loading')).not.toBeVisible()
		await page.screenshot({path: testInfo.outputPath(`assistant-welcome-${width}.png`)})
		const open = page.getByRole('button', {name: 'Scenarios & preferences', exact: true})
		await open.click()
		const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
		await expect(panel).toBeVisible()
		await expect(panel.getByLabel('Allow task deletion for this request')).toBeDisabled()
		await panel.getByRole('button', {name: /Plan & review Turn ideas/}).click()
		await expect(panel.getByLabel('Working mode')).toHaveValue('write')
		await expect(panel.getByLabel('Operation review policy')).toHaveValue('review')
		await panel.getByText('Advanced execution budget', {exact: true}).click()
		await expect(panel).toContainText('Each model request after reading tool results')
		await panel.getByLabel('Model requests (1–40)').fill('18')
		await panel.getByLabel('Save a personal template', {exact: true}).fill('Weekly review')
		await panel.getByRole('button', {name: 'Save as new template'}).click()
		await expect(panel.getByLabel('My templates')).toContainText('Weekly review')
		await panel.getByRole('button', {name: 'Make my default'}).click()
		await expect(panel.getByLabel('My templates')).toContainText('Weekly review · Default')
		await page.screenshot({path: testInfo.outputPath(`assistant-preferences-${width}.png`)})
		await panel.getByRole('button', {name: 'Use for upcoming messages'}).click()
		await expect(panel).not.toBeVisible()
		await expect(open).toBeFocused()
		await expect(page.locator('.profile-switch select')).toContainText('Weekly review')
		await page.reload()
		await expect(page.locator('.profile-switch select')).toHaveValue(/^custom-/)
		await open.click()
		await expect(panel.getByLabel('Working mode')).toHaveValue('write')
		await panel.getByText('Advanced execution budget', {exact: true}).click()
		await expect(panel.getByLabel('Model requests (1–40)')).toHaveValue('18')
		await panel.getByLabel('Model requests (1–40)').fill('19')
		await panel.getByRole('button', {name: 'Update this template'}).click()
		// The dialog also keeps a polite status region for display defaults; pick the save confirmation by its text.
		await expect(panel.getByRole('status').filter({hasText: 'Saved to your account'})).toBeVisible()
		// Cancel is a real cancel: editing the dialog never mutates live options.
		await panel.getByLabel('Working mode').selectOption('read')
		await page.keyboard.press('Escape')
		await expect(panel).not.toBeVisible()
		await open.click()
		await expect(panel.getByLabel('Working mode')).toHaveValue('write')
		await panel.getByRole('button', {name: 'Delete this template'}).click()
		await expect(panel.getByLabel('My templates')).toHaveCount(0)
		await panel.getByRole('button', {name: 'Use for upcoming messages'}).click()
		await expect(page.locator('.profile-switch select')).toHaveValue('ask')
		// A smaller visual viewport approximates a mobile keyboard without moving input off screen.
		await page.setViewportSize({width, height: 500})
		await page.getByLabel('Your request').fill('Long draft\n'.repeat(20))
		const box = await page.locator('.composer').boundingBox()
		expect(box!.y + box!.height).toBeLessThanOrEqual(500)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath(`assistant-keyboard-${width}.png`)})
	})
}

test('a stale template save retains edits and asks to reload instead of overwriting another window', async ({authenticatedPage: page, apiContext, userToken}) => {
	await page.goto('/ai')
	await page.getByRole('button', {name: 'Scenarios & preferences', exact: true}).click()
	const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
	await panel.getByLabel('Save a personal template', {exact: true}).fill('Do not lose this')
	const headers = {Authorization: `Bearer ${userToken}`}
	const old = await (await apiContext.get(`${api}/ai/preferences`, {headers})).json()
	expect((await apiContext.post(`${api}/ai/preferences`, {headers, data: {...old, profiles: [], default_profile: 'plan'}})).ok()).toBeTruthy()
	await panel.getByRole('button', {name: 'Save as new template'}).click()
	await expect(panel.getByRole('alert')).toContainText('Another window')
	await expect(panel.getByLabel('Save a personal template', {exact: true})).toHaveValue('Do not lose this')
	await panel.getByRole('button', {name: 'Try again', exact: true}).click()
	await panel.getByRole('button', {name: 'Save as new template'}).click()
	await expect(panel.getByLabel('My templates')).toContainText('Do not lose this')
})

// Real preferences API: the template must carry both runtime switches, not just the dialog's draft.
test('parallel subtasks and pausing at the segment limit are stored in a template and restored from it', async ({authenticatedPage: page, apiContext, userToken}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const storedTemplates = async () => ((await (await apiContext.get(`${api}/ai/preferences`, {headers})).json()) as AssistantPreferences).profiles ?? []
	await page.goto('/ai')
	const open = page.getByRole('button', {name: 'Scenarios & preferences', exact: true})
	const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
	// The label also carries an "Experimental" tag.
	const subagents = panel.getByRole('checkbox', {name: /^Parallel subtasks/})
	const pauseAtLimit = panel.getByRole('checkbox', {name: 'Pause when a segment reaches its limit', exact: true})
	const advanced = panel.getByText('Advanced execution budget', {exact: true})
	await open.click()
	await expect(subagents).not.toBeChecked()
	await subagents.check()
	await advanced.click()
	await expect(pauseAtLimit).not.toBeChecked()
	await pauseAtLimit.check()
	await panel.getByLabel('Save a personal template', {exact: true}).fill('Parallel audit')
	await panel.getByRole('button', {name: 'Save as new template'}).click()
	await expect(panel.getByLabel('My templates')).toContainText('Parallel audit')
	const saved = (await storedTemplates()).find(profile => profile.name === 'Parallel audit')
	expect(saved?.options).toMatchObject({enable_subagents: true, stop_at_segment_limit: true})

	// Cancel without applying: after the reload only the stored template can bring the switches back.
	await page.keyboard.press('Escape')
	await expect(panel).not.toBeVisible()
	await page.reload()
	await open.click()
	await expect(subagents).not.toBeChecked()
	await panel.getByLabel('My templates').selectOption({label: 'Parallel audit'})
	await expect(subagents).toBeChecked()
	await advanced.click()
	await expect(pauseAtLimit).toBeChecked()

	await panel.getByRole('button', {name: 'Delete this template'}).click()
	await expect(panel.getByLabel('My templates')).toHaveCount(0)
	expect(await storedTemplates()).toEqual([])
	await page.keyboard.press('Escape')
	await expect(panel).not.toBeVisible()
})

for (const width of [1440, 390]) {
	test(`dark assistant ${width}px keeps preference fields and conversation readable`, async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width, height: 900})
		await page.goto('/ai')
		await expect(page.locator('.vikunja-loading')).not.toBeVisible()
		await page.evaluate(() => document.documentElement.classList.replace('light', 'dark'))
		await page.getByRole('button', {name: 'Scenarios & preferences', exact: true}).click()
		const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
		await expect.poll(() => panel.evaluate(el => {
			const color = getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number)
			return color[0] + color[1] + color[2]
		})).toBeLessThan(300)
		const colors = await panel.getByLabel('Working mode').evaluate(el => ({text: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor}))
		expect(colors.text).not.toBe(colors.background)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath(`assistant-dark-${width}.png`)})
		await page.keyboard.press('Escape')
		await expect(panel).not.toBeVisible()
		await page.getByLabel('Your request').fill('A draft in dark mode')
		await page.screenshot({path: testInfo.outputPath(`assistant-dark-composer-${width}.png`)})
	})
}

const INTERIM = 'Checking the Launch project before answering.'
const ANSWER = 'All launch tasks are on track.'

// A saved two-round turn: an interim reply with one tool call, then the answer. Display defaults never touch it.
async function savedToolTurn(page: Page) {
	const conversation = {
		id: crypto.randomUUID(),
		title: 'Display defaults',
		compactions: [],
		turns: [{
			id: crypto.randomUUID(),
			request_id: crypto.randomUUID(),
			prompt: 'How is the launch going?',
			status: 'completed',
			result: {
				stage: 'completed',
				model: 'fixture',
				reply: ANSWER,
				steps: [
					{
						round: 1,
						model: 'fixture',
						text: INTERIM,
						tool_calls: [{
							id: 'call-1',
							function: {
								name: 'list_projects',
								arguments: '{}',
							},
						}],
					},
					{
						round: 2,
						model: 'fixture',
						text: ANSWER,
					},
				],
				actions: [{
					round: 1,
					tool: 'list_projects',
					arguments: '{}',
					result: '{"items":[{"title":"Launch fixture result"}]}',
					success: true,
					duration_ms: 12,
				}],
			},
		}],
	}
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'model',
			name: 'Fixture',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'model',
		transcription: '',
		cleanup: '',
	}}))
	await page.route('**/api/v2/ai/conversations**', route => {
		const [, id, action] = new URL(route.request().url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			const items = [{
				id: conversation.id,
				title: conversation.title,
				turn_count: 1,
				running: false,
			}]
			return route.fulfill({json: {items, total: 1, total_pages: 1}})
		}
		if (action === 'events') {
			const activity = {turn: conversation.turns[0], compacting: false, compactions: []}
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `event: activity\ndata: ${JSON.stringify(activity)}\n\n`,
			})
		}
		return route.fulfill({json: conversation})
	})
	return conversation.id
}

function storedDisplayPreferences(page: Page) {
	return page.evaluate(() => {
		const values: unknown[] = []
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index)
			if (key?.startsWith('arona-display:v1:')) values.push(JSON.parse(localStorage.getItem(key)!))
		}
		return values
	})
}

test('display defaults apply at once, stay on this device after reload and restore', async ({
	authenticatedPage: page,
}) => {
	const id = await savedToolTurn(page)
	await page.goto(`/ai?chat=${id}`)
	const tool = page.locator('.timeline-step[data-round="1"] .tool-row')
	const interim = page.locator('.timeline-step[data-round="1"] .step-reply')
	await expect(page.locator('.chat-markdown')).toHaveText(ANSWER)
	await expect(interim).toHaveText(INTERIM)
	await expect(tool).toHaveCount(1)
	await expect(tool).not.toHaveAttribute('open')
	await expect(tool.locator('.tool-body')).toHaveCount(0)

	const open = page.getByRole('button', {name: 'Scenarios & preferences', exact: true})
	const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
	const display = panel.locator('section.display-preferences')
	const toolDetails = display.getByRole('checkbox', {name: 'Expand tool arguments and results by default', exact: true})
	const fullInterim = display.getByRole('checkbox', {name: 'Show interim replies in full', exact: true})
	await open.click()
	await expect(fullInterim).toBeChecked()
	await toolDetails.check()
	await fullInterim.uncheck()
	// Applied without "Use for upcoming messages", while the dialog is still open.
	await expect(tool).toHaveAttribute('open')
	// Cancelling the request options leaves the device-only display defaults in place.
	await page.keyboard.press('Escape')
	await expect(panel).not.toBeVisible()
	await expect(tool.locator('.tool-body')).toContainText('Launch fixture result')
	await expect(page.locator('.timeline-step[data-round="1"] .step-reply-collapsed')).toHaveCount(1)
	await expect(interim).toHaveCount(0)
	await expect(page.locator('.chat-markdown')).toHaveText(ANSWER)
	expect(await storedDisplayPreferences(page)).toEqual([{
		showIntermediate: false,
		expandReasoning: false,
		expandToolDetails: true,
	}])

	await page.reload()
	await expect(tool).toHaveAttribute('open')
	await expect(tool.locator('.tool-body')).toContainText('Launch fixture result')
	await expect(interim).toHaveCount(0)
	await open.click()
	await expect(toolDetails).toBeChecked()
	await expect(fullInterim).not.toBeChecked()
	await display.getByRole('button', {name: 'Restore defaults', exact: true}).click()
	await expect(toolDetails).not.toBeChecked()
	await expect(fullInterim).toBeChecked()
	await page.keyboard.press('Escape')
	await expect(tool).not.toHaveAttribute('open')
	await expect(interim).toHaveText(INTERIM)
	expect(await storedDisplayPreferences(page)).toEqual([])
	await page.reload()
	await expect(interim).toHaveText(INTERIM)
	await expect(tool).not.toHaveAttribute('open')
})
