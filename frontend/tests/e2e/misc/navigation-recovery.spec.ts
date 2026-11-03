import type {Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {updateUserSettings} from '../../support/updateUserSettings'

async function documentMarker(page: Page) {
	return page.evaluate(() => {
		const marker = crypto.randomUUID()
		Object.assign(window, {chunkRecoveryDocument: marker})
		return marker
	})
}

async function expectSameDocument(page: Page, marker: string) {
	expect(await page.evaluate(() => (window as Window & {chunkRecoveryDocument?: string}).chunkRecoveryDocument))
		.toBe(marker)
}

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 390, language: 'zh-CN'},
] as const) {
	test(`chunkRecovery keeps the chat draft through one failed retry and an explicitly confirmed refresh at ${scenario.width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, testInfo) => {
		await page.setViewportSize({width: scenario.width, height: 900})
		await updateUserSettings(apiContext, userToken, {language: scenario.language})
		await page.goto('/ai')
		const input = page.locator('#main-content .tcy-assistant:not(.is-embedded) .composer textarea')
		await expect(input).toBeVisible()
		const draft = 'Unsent draft while a different page is loading'
		await input.fill(draft)
		const marker = await documentMarker(page)
		let failedChunks = 0
		const pattern = '**/assets/Drive-*.js'
		await page.route(pattern, route => {
			failedChunks++
			return route.abort('internetdisconnected')
		})
		if (scenario.width <= 768) await page.locator('.menu-show-button').click()
		await page.locator('.menu a[href="/drive"]').click()

		const notice = page.locator('.chunk-load-recovery')
		await expect(notice).toBeVisible()
		expect(failedChunks, 'The test must interrupt a real lazy-loaded route resource').toBeGreaterThan(0)
		await expect(page).toHaveURL(/\/ai$/)
		await expect(input).toHaveValue(draft)
		await expectSameDocument(page, marker)
		await expect(notice).toHaveCount(1)
		await page.screenshot({
			animations: 'disabled',
			path: testInfo.outputPath(`chunk-recovery-${scenario.width}.png`),
		})

		await page.unroute(pattern)
		await notice.getByRole('button', {
			name: scenario.language === 'en' ? 'Retry navigation' : '重试打开页面',
			exact: true,
		}).click()
		await expect(notice.getByRole('button', {
			name: scenario.language === 'en' ? 'Retry navigation' : '重试打开页面',
			exact: true,
		})).toHaveCount(0)
		await expect(notice).toContainText(scenario.language === 'en'
			? 'browser may have retained the failed resource'
			: '浏览器可能保留了加载失败的资源')
		await expect(page).toHaveURL(/\/ai$/)
		await expect(input).toHaveValue(draft)
		await expectSameDocument(page, marker)
		await notice.getByRole('button', {
			name: scenario.language === 'en' ? 'Refresh page…' : '刷新页面…',
			exact: true,
		}).click()
		// Opening the confirmation still preserves both the document and its unsent text.
		await expect(input).toHaveValue(draft)
		await expectSameDocument(page, marker)
		await notice.getByRole('button', {
			name: scenario.language === 'en' ? 'Confirm refresh' : '确认刷新页面',
			exact: true,
		}).click()
		await expect(input).toHaveValue(draft)
		await expect.poll(() => page.evaluate(() =>
			(window as Window & {chunkRecoveryDocument?: string}).chunkRecoveryDocument,
		)).toBeUndefined()
		await expect(input).toHaveValue(draft)
		if (scenario.width <= 768) await page.locator('.menu-show-button').click()
		await page.locator('.menu a[href="/drive"]').click()
		await expect(page).toHaveURL(/\/drive$/)
		await expect(page.locator('.drive-browser')).toBeVisible()
		await expect(notice).toHaveCount(0)
	})
}

test('chunkRecovery preserves the calendar until explicit refresh, then opens the task with its backdrop', async ({
	authenticatedPage: page,
}) => {
	await ProjectFactory.create(1, {id: 1})
	await TaskFactory.create(1, {
		id: 1,
		title: 'Chunk modal task',
		start_date: '2040-06-01T10:00:00Z',
		end_date: '2040-06-01T11:00:00Z',
	})
	await page.goto('/calendar?view=agenda&date=2040-06-01&project=1')
	const event = page.locator('.calendar-agenda-events [data-task-id="1"]').first()
	await expect(event).toBeVisible()
	const backdrop = new URL(page.url()).pathname + new URL(page.url()).search
	const marker = await documentMarker(page)
	const pattern = '**/assets/TaskDetailView-*.js'
	let failedChunks = 0
	await page.route(pattern, route => {
		failedChunks++
		return route.abort('internetdisconnected')
	})
	await event.click()
	const notice = page.locator('.chunk-load-recovery')
	await expect(notice).toBeVisible()
	expect(failedChunks).toBeGreaterThan(0)
	await expect(page).toHaveURL(new RegExp('/calendar\\?'))
	await expectSameDocument(page, marker)

	await page.unroute(pattern)
	await notice.getByRole('button', {name: 'Retry navigation', exact: true}).click()
	await expect(notice.getByRole('button', {name: 'Retry navigation', exact: true})).toHaveCount(0)
	await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === backdrop)
	await expectSameDocument(page, marker)
	await notice.getByRole('button', {name: 'Refresh page…', exact: true}).click()
	await expectSameDocument(page, marker)
	await notice.getByRole('button', {name: 'Confirm refresh', exact: true}).click()
	await expect.poll(() => page.evaluate(() =>
		(window as Window & {chunkRecoveryDocument?: string}).chunkRecoveryDocument,
	)).toBeUndefined()
	await expect(event).toBeVisible()
	await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === backdrop)
	const refreshedMarker = await documentMarker(page)
	expect(refreshedMarker).not.toBe(marker)
	await event.click()
	await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
	await expect(page.locator('.task-view')).toContainText('Chunk modal task')
	expect(await page.evaluate(() => window.history.state.backdropView)).toBe(backdrop)
	await expectSameDocument(page, refreshedMarker)
	await page.keyboard.press('Escape')
	await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
	await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === backdrop)
	await expectSameDocument(page, refreshedMarker)
})
