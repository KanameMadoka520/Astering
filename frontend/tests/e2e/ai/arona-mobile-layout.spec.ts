import type {Page, TestInfo} from '@playwright/test'
import {writeFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {test, expect} from '../../support/fixtures'
import {MOBILE_CHAT_ID, mobileArona, mobileChatUrl} from '../../support/mobileArona'

async function metrics(page: Page, embedded = false) {
	return page.locator(embedded ? '.arona-panel .tcy-assistant' : '.tcy-assistant:not(.is-embedded)').evaluate(root => {
		const box = (selector: string) => {
			const rect = root.querySelector(selector)!.getBoundingClientRect()
			return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom}
		}
		return {
			viewportHeight: window.visualViewport?.height ?? innerHeight,
			viewportTop: window.visualViewport?.offsetTop ?? 0,
			layoutViewportHeight: innerHeight,
			dock: box('.composer-dock'),
			header: box('.assistant-heading'),
			conversation: box('.conversation'),
			width: document.documentElement.scrollWidth,
			viewportWidth: innerWidth,
		}
	})
}

async function recordMetrics(testInfo: TestInfo, name: string, layout: Awaited<ReturnType<typeof metrics>>) {
	const path = testInfo.outputPath(`${name}.json`)
	await writeFile(path, JSON.stringify(layout, null, 2))
	await testInfo.attach(name, {path, contentType: 'application/json'})
}

async function installVisibleViewport(page: Page, width = 390, height = 844) {
	await page.addInitScript(({width, height}) => {
		const viewport = Object.assign(new EventTarget(), {
			width,
			height,
			offsetLeft: 0,
			offsetTop: 0,
			pageLeft: 0,
			pageTop: 0,
			scale: 1,
		})
		Object.defineProperty(window, 'visualViewport', {configurable: true, value: viewport})
	}, {width, height})
}

async function resizeVisibleViewport(page: Page, height: number, offsetTop = 0) {
	await page.evaluate(({height, offsetTop}) => {
		Object.assign(window.visualViewport!, {height, offsetTop})
		window.visualViewport!.dispatchEvent(new Event('resize'))
		window.visualViewport!.dispatchEvent(new Event('scroll'))
	}, {height, offsetTop})
}

test.describe('mobile chat layout', () => {
	test.use({isMobile: true, hasTouch: true})
	for (const scenario of [
		{width: 320, chinese: false},
		{width: 390, chinese: true},
		{width: 430, chinese: false},
	]) {
		test(`keeps the transcript clear and the composer compact at ${scenario.width}px`, async ({authenticatedPage: page}, testInfo) => {
			await page.setViewportSize({width: scenario.width, height: 844})
			await mobileArona(page, {chinese: scenario.chinese})
			await page.goto(mobileChatUrl())
			await expect(page.locator('.chat-markdown')).toContainText('31 December 2026')
			const layout = await metrics(page)
			await recordMetrics(testInfo, 'mobile-layout-metrics', layout)
			await page.screenshot({path: testInfo.outputPath(`mobile-chat-${scenario.width}.png`)})
			expect(layout.dock.height).toBeLessThanOrEqual(136)
			expect(await page.locator('.composer').evaluate(element => getComputedStyle(element).borderRadius)).toBe('24px')
			expect(layout.header.height).toBeLessThanOrEqual(64)
			expect(layout.conversation.height).toBeGreaterThan(600)
			expect(layout.width).toBeLessThanOrEqual(layout.viewportWidth)
			await expect(page.locator('.conversation-storage')).not.toBeVisible()
			await expect(page.locator('.run-budget')).not.toBeVisible()
			await expect(page.locator('.run-meta .output-speed')).toBeVisible()
			await expect(page.locator('.message-actions .message-action')).toHaveCount(2)
			const input = page.locator('.composer textarea')
			await input.fill('Keep this unsent mobile draft.')
			const inputNode = await input.elementHandle()
			await page.locator('.composer-config-trigger').click()
			const settings = page.getByRole('dialog', {name: scenario.chinese ? '对话配置' : 'Chat configuration', exact: true})
			await expect(settings).toBeVisible()
			await expect(settings.locator('.profile-switch select')).toBeVisible()
			if (scenario.chinese) {
				await expect(settings).toHaveCSS('opacity', '1')
				await expect(settings.locator('.bottom-sheet__panel')).toHaveCSS('opacity', '1')
				await page.screenshot({path: testInfo.outputPath('mobile-configuration-zh.png'), animations: 'disabled'})
			}
			await settings.locator('.profile-switch select').selectOption('plan')
			await settings.getByRole('button', {name: scenario.chinese ? '返回对话' : 'Back to chat', exact: true}).click()
			await expect(settings).not.toBeVisible()
			await expect(input).toHaveValue('Keep this unsent mobile draft.')
			expect(await inputNode?.evaluate(node => node.isConnected && node === document.querySelector('.composer textarea'))).toBe(true)
			await page.locator('.conversation-details-trigger').click()
			const details = page.getByRole('dialog', {name: scenario.chinese ? '会话详情' : 'Conversation details', exact: true})
			await expect(details).toBeVisible()
			await expect(details.locator('.conversation-storage')).toBeVisible()
			if (scenario.chinese) {
				await expect(details).toHaveCSS('opacity', '1')
				await expect(details.locator('.bottom-sheet__panel')).toHaveCSS('opacity', '1')
				await page.screenshot({path: testInfo.outputPath('mobile-conversation-details-zh.png'), animations: 'disabled'})
			}
			await page.keyboard.press('Escape')
			await expect(details).not.toBeVisible()
		})
	}

	test('keeps app navigation, search and account controls available without another header', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 390, height: 844})
		await mobileArona(page)
		await page.goto(mobileChatUrl())
		const input = page.getByLabel('Your request', {exact: true})
		await input.fill('My draft survives opening the site menu.')
		await expect(page.locator('.navbar.is-mobile-assistant')).not.toBeVisible()
		await page.locator('[data-mobile-history-toggle]').click()
		await page.locator('[data-mobile-site-menu]').click()
		await expect(page.locator('#mobile-assistant-site-actions')).toBeVisible()
		const siteActions = page.locator('#mobile-assistant-site-actions')
		const account = siteActions.locator('[data-tour="account-menu"]')
		await expect(account).toBeVisible()
		await account.click()
		await expect(siteActions.locator('.dropdown-menu')).toBeVisible()
		await expect(siteActions.getByRole('link', {name: 'Settings', exact: true})).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(siteActions.locator('.dropdown-menu')).not.toBeVisible()
		await siteActions.locator('.notifications .trigger-button').click()
		await expect(siteActions.locator('.notifications-list')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(siteActions.locator('.notifications-list')).not.toBeVisible()
		await expect(page.locator('#app-sidebar')).toBeVisible()
		await siteActions.locator('.quick-actions-trigger').click()
		await expect(page.locator('dialog[open] .quick-actions')).toBeVisible()
		await page.locator('.quick-actions .action-input input').fill('search')
		await page.keyboard.press('Escape')
		await expect(page.locator('dialog[open] .quick-actions')).not.toBeVisible()
		const closeBox = await page.locator('.menu-hide-button').boundingBox()
		expect(closeBox!.y).toBeGreaterThanOrEqual(0)
		expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(844)
		await page.screenshot({path: testInfo.outputPath('mobile-site-navigation.png')})
		await page.locator('.menu-hide-button').click()
		await expect(input).toHaveValue('My draft survives opening the site menu.')
		await expect(page.locator('.chat-sidebar')).not.toBeVisible()
		await expect(page.locator('[data-mobile-history-toggle]')).toBeFocused()
	})

	test('keeps long drafts, model choices and send payload intact through a short viewport', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 390, height: 844})
		const server = await mobileArona(page)
		await page.goto(mobileChatUrl())
		const input = page.getByLabel('Your request', {exact: true})
		await input.fill('A draft before the keyboard opens.')
		await page.setViewportSize({width: 390, height: 420})
		await expect(input).toHaveValue('A draft before the keyboard opens.')
		const layout = await metrics(page)
		expect(layout.dock.bottom).toBeLessThanOrEqual(421)
		expect(layout.conversation.height).toBeGreaterThan(160)
		await page.screenshot({path: testInfo.outputPath('mobile-short-viewport.png')})
		await page.getByRole('button', {name: 'Send request', exact: true}).click()
		await expect.poll(() => server.requests.length).toBe(1)
		expect(server.requests[0]).toMatchObject({message: 'A draft before the keyboard opens.', mode: 'read', connection_id: 'primary'})
		await expect(input).toHaveValue('')
		await expect(page.locator('.chat-markdown')).toHaveCount(2)
	})

	test('restores separate drafts through internal chat links and browser Back/Forward without remounting', async ({authenticatedPage: page}) => {
		await page.setViewportSize({width: 390, height: 844})
		const server = await mobileArona(page)
		const secondID = '256abc6d-87dd-4f99-a043-c4ef9ecf61e1'
		const first = server.conversation()
		first.turns![0].result!.reply = `[Open second conversation](/ai?chat=${secondID})`
		const second = structuredClone(first)
		second.id = secondID
		second.title = 'Second conversation with its own draft'
		second.turns![0].result!.reply = `[Return to first conversation](/ai?chat=${MOBILE_CHAT_ID})`
		await page.route(`**/api/v2/ai/conversations/${secondID}`, route => route.fulfill({json: second}))
		await page.route(`**/api/v2/ai/conversations/${secondID}/events`, route => route.fulfill({
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({
				turn: second.turns?.at(-1),
				storage: second.storage,
				compacting: false,
				compactions: [],
			})}\n\n`,
		}))
		await page.goto(mobileChatUrl())
		const input = page.getByLabel('Your request', {exact: true})
		await input.fill('First conversation keeps this unsent draft.')
		const inputNode = await input.elementHandle()
		await page.getByRole('link', {name: 'Open second conversation', exact: true}).click()
		await expect(page).toHaveURL(new RegExp(`chat=${secondID}`))
		await expect(input).toHaveValue('')
		await input.fill('Second conversation has a different unsent draft.')
		await page.getByRole('link', {name: 'Return to first conversation', exact: true}).click()
		await expect(page).toHaveURL(new RegExp(`chat=${MOBILE_CHAT_ID}`))
		await expect(input).toHaveValue('First conversation keeps this unsent draft.')
		await page.goBack()
		await expect(page).toHaveURL(new RegExp(`chat=${secondID}`))
		await expect(input).toHaveValue('Second conversation has a different unsent draft.')
		await page.goForward()
		await expect(page).toHaveURL(new RegExp(`chat=${MOBILE_CHAT_ID}`))
		await expect(input).toHaveValue('First conversation keeps this unsent draft.')
		expect(await inputNode?.evaluate(node => node.isConnected && node === document.querySelector('.composer textarea'))).toBe(true)
		const stored = await page.evaluate(ids => Object.fromEntries(Object.keys(sessionStorage)
			.filter(key => key.startsWith('tcy-ai-draft:'))
			.map(key => [JSON.parse(key.slice('tcy-ai-draft:'.length))[2], sessionStorage.getItem(key)])
			.filter(([id]) => ids.includes(id))), [MOBILE_CHAT_ID, secondID])
		expect(stored).toEqual({
			[MOBILE_CHAT_ID]: 'First conversation keeps this unsent draft.',
			[secondID]: 'Second conversation has a different unsent draft.',
		})
	})

	test('confirms an arriving unread reply only after the configuration sheet exposes the transcript', async ({authenticatedPage: page}) => {
		await page.setViewportSize({width: 390, height: 844})
		const server = await mobileArona(page, {holdConversation: true})
		await page.goto(mobileChatUrl())
		await page.locator('.composer-config-trigger').click()
		const settings = page.getByRole('dialog', {name: 'Chat configuration', exact: true})
		await expect(settings).toBeVisible()
		server.releaseConversation()
		await expect(page.locator('.chat-markdown')).toContainText('31 December 2026')
		// This spans the 700ms read delay: a rendered reply behind a sheet has not been viewed.
		await page.waitForTimeout(1000)
		expect(server.requests.filter(request => request.action === 'read')).toHaveLength(0)
		await settings.getByRole('button', {name: 'Back to chat', exact: true}).click()
		await expect.poll(() => server.requests.filter(request => request.action === 'read').length).toBe(1)
		expect(server.requests.find(request => request.action === 'read')).toMatchObject({through_reply_id: 'mobile-completed-turn'})
		expect(server.conversation().unread).toBe(false)
	})

	for (const covering of ['drive', 'rename', 'export', 'image'] as const) {
		test(`keeps an arriving reply unread behind the ${covering} dialog`, async ({authenticatedPage: page}) => {
			await page.setViewportSize({width: 390, height: 844})
			const server = await mobileArona(page)
			const conversation = server.conversation()
			if (covering === 'image') {
				conversation.turns![0].attachments = [{
					id: 'preview-image',
					name: 'preview-image.png',
					mime: 'image/png',
					size: 100,
				}]
				await page.route('**/api/v2/ai/conversations/*/attachments/preview-image', route => route.fulfill({
					contentType: 'image/png',
					body: readFileSync(new URL('../../fixtures/image-blue.png', import.meta.url)),
				}))
			}
			let announce!: () => void
			const incoming = new Promise<void>(done => { announce = done })
			await page.route('**/api/v2/ai/conversations/*/events', async route => {
				await incoming
				const current = server.conversation()
				await route.fulfill({
					contentType: 'text/event-stream',
					body: `event: activity\ndata: ${JSON.stringify({
						turn: current.turns?.at(-1),
						storage: current.storage,
						unread: current.unread,
						latest_reply_id: current.latest_reply_id,
						compacting: false,
						compactions: [],
					})}\n\n`,
				})
			})
			try {
				await page.goto(mobileChatUrl())
				await expect(page.locator('.chat-markdown')).toContainText('31 December 2026')
				if (covering === 'drive') {
					await page.getByRole('button', {name: 'Attach images or files (paste or drop also works)', exact: true}).click()
					await page.getByRole('menuitem', {name: 'Choose from Drive', exact: true}).click()
				} else if (covering === 'image') {
					await page.getByRole('button', {name: 'Preview preview-image.png', exact: true}).click()
				} else {
					await page.locator('.conversation-toolbar .chat-menu-trigger').click()
					await page.getByRole('menuitem', {
						name: covering === 'rename' ? 'Rename conversation' : 'Export conversation',
						exact: true,
					}).click()
				}
				const dialog = page.getByRole('dialog').filter({visible: true})
				await expect(dialog).toHaveCount(1)
				conversation.unread = true
				conversation.latest_reply_id = 'mobile-completed-turn'
				announce()
				// Intersection geometry stays unchanged under native dialogs; the reply still has not been viewed.
				await page.waitForTimeout(1100)
				expect(server.requests.filter(request => request.action === 'read')).toHaveLength(0)
				await page.keyboard.press('Escape')
				await expect(dialog).toHaveCount(0)
				await expect.poll(() => server.requests.filter(request => request.action === 'read').length).toBe(1)
				expect(server.conversation().unread).toBe(false)
			} finally {
				announce()
			}
		})
	}

	test('keeps the composer above a keyboard that changes only visualViewport, without remounting the draft', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 390, height: 844})
		await installVisibleViewport(page)
		await mobileArona(page)
		await page.goto(mobileChatUrl())
		const input = page.getByLabel('Your request', {exact: true})
		await input.fill('A stable draft while Android keeps the layout viewport unchanged.')
		const node = await input.elementHandle()
		await resizeVisibleViewport(page, 360, 36)
		await expect.poll(async () => (await metrics(page)).dock.bottom).toBeLessThanOrEqual(397)
		const layout = await metrics(page)
		expect(layout.layoutViewportHeight).toBe(844)
		expect(layout.viewportHeight).toBe(360)
		expect(layout.header.y).toBeGreaterThanOrEqual(36)
		expect(layout.conversation.height).toBeGreaterThan(170)
		await recordMetrics(testInfo, 'visual-viewport-only-metrics', layout)
		await page.screenshot({path: testInfo.outputPath('mobile-visual-viewport-only.png')})
		await expect(input).toHaveValue('A stable draft while Android keeps the layout viewport unchanged.')
		expect(await node?.evaluate(element => element.isConnected && element === document.querySelector('.composer textarea'))).toBe(true)
		await resizeVisibleViewport(page, 844)
		await expect.poll(async () => (await metrics(page)).conversation.height).toBeGreaterThan(600)
		await expect(input).toHaveValue('A stable draft while Android keeps the layout viewport unchanged.')
	})

	test('keeps an empty dark conversation usable and scrolls a long draft in a short viewport', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 390, height: 844})
		await mobileArona(page, {empty: true, dark: true, chinese: true})
		await page.goto('/ai')
		await expect(page.locator('html')).toHaveClass(/dark/)
		await expect(page.locator('.welcome')).toBeVisible()
		await expect(page.locator('.vikunja-loading')).not.toBeVisible()
		await page.screenshot({path: testInfo.outputPath('mobile-empty-dark.png')})
		const input = page.locator('.composer textarea')
		const draft = Array.from({length: 16}, (_, index) => `第${index + 1}行：保留这份未发送的草稿。`).join('\n')
		await input.fill(draft)
		await page.setViewportSize({width: 390, height: 420})
		await expect(input).toHaveValue(draft)
		const layout = await metrics(page)
		expect(layout.dock.height).toBeLessThanOrEqual(210)
		expect(layout.dock.bottom).toBeLessThanOrEqual(421)
		expect(layout.conversation.height).toBeGreaterThan(140)
		expect(await input.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
		await page.screenshot({path: testInfo.outputPath('mobile-long-draft-dark.png')})
	})

	test('keeps stop and additional instructions reachable at 320px and preserves a draft when stopping', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 320, height: 640})
		const server = await mobileArona(page, {running: true})
		await page.goto(mobileChatUrl())
		const input = page.getByLabel('Your request', {exact: true})
		const stop = page.locator('.composer-stop')
		await expect(stop).toBeVisible()
		await input.fill('Also include the remaining subtasks.')
		const steer = page.getByRole('button', {name: 'Add instruction', exact: true})
		await expect(steer).toBeVisible()
		const runningLayout = await metrics(page)
		await recordMetrics(testInfo, 'mobile-running-metrics', runningLayout)
		expect(runningLayout.dock.height).toBeLessThanOrEqual(136)
		await page.screenshot({path: testInfo.outputPath('mobile-running-steer-320.png')})
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await steer.click()
		await expect.poll(() => server.requests.length).toBe(1)
		expect(server.requests[0]).toMatchObject({action: 'steer', message: 'Also include the remaining subtasks.', turn_id: 'mobile-completed-turn'})
		await expect(input).toHaveValue('')
		await input.fill('Keep this draft after stopping execution.')
		await stop.click()
		await expect.poll(() => server.requests.some(request => request.action === 'stop')).toBe(true)
		await expect(stop).not.toBeVisible()
		await expect(input).toHaveValue('Keep this draft after stopping execution.')
		await expect(page.getByRole('button', {name: 'Send request', exact: true})).toBeVisible()
		expect(server.conversation().turns?.[0].status).toBe('stopped')
		expect(server.conversation().turns?.[0].prompt).toBe('Keep the project deadline and review my next steps.')
	})

	test('uses the visible viewport for the mobile floating assistant and keeps its draft through minimize', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 390, height: 844})
		await installVisibleViewport(page)
		await mobileArona(page, {empty: true})
		await page.goto('/')
		await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
		const panel = page.locator('.arona-panel')
		const input = panel.getByLabel('Your request', {exact: true})
		await input.fill('Keep the floating draft above the keyboard.')
		const node = await input.elementHandle()
		await resizeVisibleViewport(page, 360, 24)
		await expect.poll(async () => (await metrics(page, true)).dock.bottom).toBeLessThanOrEqual(385)
		const box = await panel.boundingBox()
		expect(box!.y).toBeGreaterThanOrEqual(24)
		expect(box!.y + box!.height).toBeLessThanOrEqual(385)
		await page.screenshot({path: testInfo.outputPath('mobile-floating-keyboard.png')})
		await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
		await expect(panel).not.toBeVisible()
		await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
		await expect(input).toHaveValue('Keep the floating draft above the keyboard.')
		expect(await node?.evaluate(element => element.isConnected && element === document.querySelector('.arona-panel textarea'))).toBe(true)
	})

	test('keeps the single header and touch controls usable in a 768px landscape viewport', async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width: 768, height: 390})
		await mobileArona(page)
		await page.goto(mobileChatUrl())
		await expect(page.locator('.chat-markdown')).toContainText('31 December 2026')
		const layout = await metrics(page)
		expect(layout.header.height).toBeLessThanOrEqual(64)
		expect(layout.dock.height).toBeLessThanOrEqual(136)
		expect(layout.conversation.height).toBeGreaterThan(190)
		expect(layout.width).toBeLessThanOrEqual(768)
		await page.screenshot({path: testInfo.outputPath('mobile-landscape-768.png')})
	})

})

test('desktop retains the conversation, configuration and message details', async ({authenticatedPage: page}, testInfo) => {
	await page.setViewportSize({width: 1440, height: 900})
	await mobileArona(page)
	await page.goto(mobileChatUrl())
	await expect(page.locator('.chat-markdown')).toContainText('31 December 2026')
	await page.locator('.run-summary > summary').click()
	await expect(page.locator('.run-summary [data-scope="turn"]')).toContainText('18,541')
	await expect(page.locator('.request-details')).toBeVisible()
	await page.screenshot({path: testInfo.outputPath('desktop-chat.png')})
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})


for (const width of [390, 1440]) {
	test.describe(`nested configuration controls at ${width}px`, () => {
		test.use({
			viewport: {width, height: 900},
			isMobile: width <= 768,
			hasTouch: width <= 768,
		})

		test('applies model, tool, MCP and permission changes while preserving the draft and execution lock', async ({authenticatedPage: page}, testInfo) => {
			const server = await mobileArona(page, {mcp: true, sendRunning: true})
			await page.goto(mobileChatUrl())
			const input = page.getByLabel('Your request', {exact: true})
			const draft = `Nested configuration draft at ${width}px.`
			await input.fill(draft)
			const node = await input.elementHandle()
			await page.locator('.composer-config-trigger').click()
			const configuration = page.getByRole('dialog', {name: 'Chat configuration', exact: true})
			await expect(configuration).toBeVisible()
			await configuration.locator('.model-switch select').selectOption('secondary')
			await expect(configuration.locator('.model-switch select')).toHaveValue('secondary')

			const toolsTrigger = configuration.locator('.tool-module-trigger')
			await toolsTrigger.click()
			const tools = page.locator('.tool-module-picker')
			await expect(tools).toBeVisible()
			const compass = tools.getByRole('combobox', {name: 'Compass', exact: true})
			await compass.selectOption('read')
			await expect(compass).toHaveValue('read')
			await compass.focus()
			await page.screenshot({path: testInfo.outputPath(`nested-tools-${width}.png`), animations: 'disabled'})
			await page.keyboard.press('Escape')
			await expect(tools).not.toBeVisible()
			await expect(configuration).toBeVisible()
			await expect(toolsTrigger).toBeFocused()

			const mcpTrigger = configuration.locator('.mcp-session-trigger')
			await mcpTrigger.click()
			const mcp = page.locator('.mcp-session-picker')
			const connection = mcp.getByRole('checkbox', {name: 'Layout-only MCP connection', exact: true})
			await connection.check()
			await expect(connection).toBeChecked()
			await connection.focus()
			await page.keyboard.press('Escape')
			await expect(mcp).not.toBeVisible()
			await expect(configuration).toBeVisible()
			await expect(mcpTrigger).toBeFocused()

			await configuration.locator('.preferences-toggle').click()
			const preferences = page.getByRole('dialog', {name: 'Scenarios & preferences', exact: true})
			await expect(preferences).toBeVisible()
			await preferences.getByLabel(/^Working mode/).selectOption('write')
			await page.screenshot({path: testInfo.outputPath(`nested-permissions-${width}.png`), animations: 'disabled'})
			await preferences.getByRole('button', {name: 'Use for upcoming messages', exact: true}).click()
			await expect(preferences).not.toBeVisible()
			await expect(configuration).toBeVisible()
			await expect(configuration.locator('.preferences-toggle')).toBeFocused()
			await expect(configuration.locator('.model-switch select')).toHaveValue('secondary')
			await configuration.getByRole('button', {name: 'Back to chat', exact: true}).click()
			await expect(input).toHaveValue(draft)
			expect(await node?.evaluate(element => element.isConnected && element === document.querySelector('.composer textarea'))).toBe(true)

			await page.getByRole('button', {name: 'Send request', exact: true}).click()
			await expect.poll(() => server.requests.length).toBe(1)
			expect(server.requests[0]).toMatchObject({
				message: draft,
				connection_id: 'secondary',
				mode: 'write',
				tool_modules: {project_tasks: 'read', compass: 'read'},
				mcp_server_ids: ['layout-mcp'],
			})

			await expect(page.locator('.composer-stop')).toBeVisible()
			await page.locator('.composer-config-trigger').click()
			await expect(configuration.locator('.model-switch select')).toBeDisabled()
			await toolsTrigger.click()
			await expect(tools.getByRole('combobox', {name: 'Compass', exact: true})).toBeDisabled()
			await page.keyboard.press('Escape')
			await expect(tools).not.toBeVisible()
			await mcpTrigger.click()
			await expect(connection).toHaveAttribute('aria-disabled', 'true')
			await connection.focus()
			await page.keyboard.press('Space')
			await expect(connection).toBeChecked()
			await page.keyboard.press('Escape')
			await expect(mcp).not.toBeVisible()
			await expect(configuration.locator('.preferences-toggle')).toBeDisabled()
			await expect(preferences).not.toBeVisible()
			await expect(configuration).toBeVisible()
			expect(server.requests).toHaveLength(1)
		})
	})
}
