import {randomBytes} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {updateUserSettings} from '../../support/updateUserSettings'

for (const scenario of [
	{width: 1440, language: 'en', resource: 'Drive list', elapsed: /\d+s elapsed/, phase: 'Waiting for the server'},
	{width: 390, language: 'zh-CN', resource: '网盘列表', elapsed: /已等待 \d+ 秒/, phase: '等待服务器响应'},
]) {
	test(`networkActivity expands real pending reads and measured downloads at ${scenario.width}px`, async ({
		authenticatedPage: page, apiContext, userToken,
	}, testInfo) => {
		test.setTimeout(60_000)
		await page.setViewportSize({width: scenario.width, height: 900})
		await updateUserSettings(apiContext, userToken, {language: scenario.language})
		const root = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
		const bytes = randomBytes(96 * 1024)
		const upload = await apiContext.post(`${root}/drive/files`, {
			headers: {Authorization: `Bearer ${userToken}`},
			multipart: {file: {name: 'private-network-fixture.bin', mimeType: 'application/octet-stream', buffer: bytes}},
		})
		expect(upload.ok()).toBe(true)
		const file = await upload.json()
		let release!: () => void
		const waiting = new Promise<void>(resolve => { release = resolve })
		const listRoute = /\/api\/v2\/drive\/files(?:\?|$)/
		await page.route(listRoute, async route => {
			if (route.request().method() !== 'GET') return route.continue()
			await waiting
			await route.continue().catch(() => {})
		})
		try {
			await page.goto('/drive')
			const activity = page.locator('.network-activity')
			await expect(activity).toBeVisible()
			await expect(activity.getByRole('status')).toContainText(scenario.resource)
			const toggle = activity.locator('.activity-toggle')
			await toggle.focus()
			await page.keyboard.press('Enter')
			await expect(toggle).toHaveAttribute('aria-expanded', 'true')
			await expect(activity.locator('.activity-task')).toContainText(scenario.resource)
			await expect(activity.locator('.activity-task')).toContainText(scenario.elapsed)
			await expect(activity.locator('.activity-task')).toContainText(scenario.phase)
			await expect(activity.locator('progress')).toHaveCount(0)
			await expect(activity).not.toContainText(/KiB|MiB|%|private-network-fixture/)
			const bounds = await activity.boundingBox()
			expect(bounds!.x).toBeGreaterThanOrEqual(0)
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scenario.width)
			await page.screenshot({path: testInfo.outputPath(`network-list-${scenario.width}.png`)})
			// The loading notice leaves the underlying search and its draft usable.
			const search = page.locator('.drive-search input')
			await search.fill('draft while waiting')
			await expect(search).toHaveValue('draft while waiting')
			await search.fill('')
			release()
			await expect(page.locator('.drive-card')).toHaveCount(1)
			await expect(activity).toHaveCount(0)
			await page.unroute(listRoute)

			const detailsLabel = scenario.language === 'en' ? 'Details and usages' : '详情与使用位置'
			await page.locator('.drive-card').getByRole('button', {name: detailsLabel, exact: true}).click()
			const details = page.getByRole('dialog', {name: detailsLabel})
			await expect(details.locator('.drive-usages-section')).toBeVisible()
			const cdp = await page.context().newCDPSession(page)
			try {
				await cdp.send('Network.enable')
				await cdp.send('Network.emulateNetworkConditions', {
					offline: false,
					latency: 250,
					downloadThroughput: 16 * 1024,
					uploadThroughput: -1,
				})
				const downloadButton = details.getByRole('button', {
					name: scenario.language === 'en' ? 'Download original' : '下载原文件',
					exact: true,
				})
				await expect(downloadButton).toBeVisible()
				const completed = page.waitForEvent('download', {timeout: 20_000})
				// A failed click or progress assertion must not leave a rejected event wait unhandled.
				void completed.catch(() => {})
				await downloadButton.click({timeout: 5000})
				// The shared panel follows the native modal into the browser's top layer.
				const panel = details.locator('.network-activity')
				await expect(panel).toBeVisible()
				await panel.locator('.activity-toggle').click()
				await expect(panel.locator('.activity-task')).toContainText(`#${file.file_id}`)
				await expect(panel.locator('.activity-measurements')).toContainText(/KiB|MiB/, {timeout: 15_000})
				await expect(panel).not.toContainText('private-network-fixture')
				if (await panel.locator('progress').count() === 0) await expect(panel).not.toContainText('%')
				await page.screenshot({path: testInfo.outputPath(`network-file-${scenario.width}.png`)})
				await cdp.send('Network.emulateNetworkConditions', {
					offline: false,
					latency: 0,
					downloadThroughput: -1,
					uploadThroughput: -1,
				})
				const downloaded = await completed
				expect(await readFile((await downloaded.path())!)).toEqual(bytes)
				await expect(panel).toHaveCount(0)
			} finally {
				await cdp.send('Network.emulateNetworkConditions', {
					offline: false,
					latency: 0,
					downloadThroughput: -1,
					uploadThroughput: -1,
				}).catch(() => {})
				await cdp.detach().catch(() => {})
			}
		} finally {
			release()
			await page.unroute(listRoute).catch(() => {})
		}
	})
}
