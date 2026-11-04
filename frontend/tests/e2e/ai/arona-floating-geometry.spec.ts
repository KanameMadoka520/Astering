import type {Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

const layoutKey = 'astering-floating-arona-layout:v1'

async function openArona(page: Page) {
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'layout-fixture',
			name: 'Layout fixture',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'layout-fixture',
		transcription: '',
		cleanup: '',
	}}))
	await page.goto('/')
	await page.evaluate(key => localStorage.removeItem(key), layoutKey)
	await page.reload()
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.locator('.arona-panel')
	await expect(panel.getByLabel('Your request', {exact: true})).toBeVisible()
	return panel
}

async function rect(locator: Locator) {
	const box = await locator.boundingBox()
	expect(box).not.toBeNull()
	return box!
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
	const start = await rect(handle)
	const x = start.x + start.width / 2
	const y = start.y + start.height / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + dx, y + dy, {steps: 12})
	await page.mouse.up()
}

test('floating Arona moves, resizes, clamps and restores its layout without losing the draft at 1440px', async ({authenticatedPage: page}, testInfo) => {
	await page.setViewportSize({width: 1440, height: 1000})
	const panel = await openArona(page)
	const input = panel.getByLabel('Your request', {exact: true})
	await input.fill('An unsent draft must survive moving and resizing the window.')
	const composer = await input.elementHandle()
	const before = await rect(panel)
	await testInfo.attach('floating-before', {body: await page.screenshot({path: testInfo.outputPath('floating-before.png')}), contentType: 'image/png'})
	await drag(page, panel.getByRole('button', {name: 'Move floating window', exact: true}), -180, -60)
	let current = await rect(panel)
	expect(current.x).toBeCloseTo(before.x - 180, 0)
	expect(current.y).toBeCloseTo(before.y - 60, 0)
	await drag(page, panel.locator('.panel-resize--se'), 100, 20)
	current = await rect(panel)
	expect(current.width).toBeCloseTo(before.width + 100, 0)
	expect(current.height).toBeCloseTo(before.height + 20, 0)
	const opposite = {
		x: current.x + current.width,
		y: current.y + current.height,
	}
	await drag(page, panel.locator('.panel-resize--nw'), -60, -30)
	current = await rect(panel)
	expect(current.x + current.width).toBeCloseTo(opposite.x, 0)
	expect(current.y + current.height).toBeCloseTo(opposite.y, 0)
	expect(await composer?.evaluate(node => node.isConnected && node === document.querySelector('.arona-panel textarea'))).toBe(true)
	await expect(input).toHaveValue('An unsent draft must survive moving and resizing the window.')
	const grip = await rect(panel.getByRole('button', {name: 'Move floating window', exact: true}))
	await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
	await page.mouse.down()
	await page.mouse.move(grip.x - 150, grip.y + 60, {steps: 8})
	await page.keyboard.press('Escape')
	await page.mouse.up()
	const cancelled = await rect(panel)
	expect(cancelled.x).toBeCloseTo(current.x, 0)
	expect(cancelled.y).toBeCloseTo(current.y, 0)
	await expect(input).toHaveValue('An unsent draft must survive moving and resizing the window.')
	await testInfo.attach('floating-custom-layout', {body: await page.screenshot({path: testInfo.outputPath('floating-custom-layout.png')}), contentType: 'image/png'})
	const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), layoutKey)
	expect(Object.keys(saved).sort()).toEqual(['height', 'width', 'x', 'y'])
	await page.reload()
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	await expect(panel).toBeVisible()
	const restored = await rect(panel)
	expect(restored.x).toBeCloseTo(saved.x, 0)
	expect(restored.y).toBeCloseTo(saved.y, 0)
	expect(restored.width).toBeCloseTo(saved.width, 0)
	expect(restored.height).toBeCloseTo(saved.height, 0)
	await page.setViewportSize({width: 820, height: 620})
	await expect.poll(async () => {
		const small = await rect(panel)
		return small.x >= 12 && small.y >= 64 && small.x + small.width <= 808 && small.y + small.height <= 608
	}).toBe(true)
	await page.setViewportSize({width: 1440, height: 1000})
	await panel.getByRole('button', {name: 'Restore default size and position', exact: true}).click()
	await expect.poll(async () => (await rect(panel)).width).toBeCloseTo(460, 0)
	const reset = await rect(panel)
	expect(reset.x).toBeCloseTo(before.x, 0)
	expect(reset.y).toBeCloseTo(before.y, 0)
	expect(await page.evaluate(key => localStorage.getItem(key), layoutKey)).toBeNull()
})

test('floating Arona keeps a scrollable touch layout and unsent draft at 390px', async ({authenticatedPage: page}, testInfo) => {
	await page.setViewportSize({width: 390, height: 844})
	const panel = await openArona(page)
	await expect(panel.locator('.panel-resize')).toHaveCount(0)
	await expect(panel.locator('.panel-move')).toHaveCount(0)
	const input = panel.getByLabel('Your request', {exact: true})
	await input.fill('Keep the phone draft when minimizing and reopening.')
	const composer = await input.elementHandle()
	await page.locator('.arona-launcher').click()
	await expect(panel).not.toBeVisible()
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	await expect(input).toHaveValue('Keep the phone draft when minimizing and reopening.')
	expect(await composer?.evaluate(node => node.isConnected && node === document.querySelector('.arona-panel textarea'))).toBe(true)
	const box = await rect(panel)
	expect(box.x).toBeGreaterThanOrEqual(0)
	expect(box.x + box.width).toBeLessThanOrEqual(390)
	expect(box.y + box.height).toBeLessThanOrEqual(844)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await testInfo.attach('floating-mobile', {body: await page.screenshot({path: testInfo.outputPath('floating-mobile.png')}), contentType: 'image/png'})
})
