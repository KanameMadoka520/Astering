import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

type Destination = 'calendar' | 'drive' | 'timeline'
const destinations: {name: Destination, path: string}[] = [
	{name: 'calendar', path: '/calendar'},
	{name: 'drive', path: '/drive'},
	{name: 'timeline', path: '/projects/history'},
]

async function followSidebar(page: Page, path: string, width: number) {
	const sidebar = page.locator('#app-sidebar')
	if (width <= 768) {
		await page.locator('.menu-show-button').click()
		await expect(sidebar).toHaveClass(/\bis-active\b/)
	}
	await sidebar.locator(`.top-menu a[href="${path}"]`).click()
	await expect(page).toHaveURL(url => url.pathname === path)
	if (width <= 768) await expect(sidebar).not.toHaveClass(/\bis-active\b/)
}

async function expectActualPage(page: Page, name: Destination, width: number) {
	if (name === 'calendar') {
		await expect(page.locator('.calendar-load-status')).toContainText('0 scheduled tasks')
		if (width <= 768) {
			await expect(page.locator('.calendar-empty')).toBeVisible()
		} else {
			await expect(page.locator('.calendar-time-body')).toBeVisible()
			await expect(page.locator('.calendar-time-column')).toHaveCount(7)
			await expect(page.locator('.calendar-time-placement')).toHaveCount(0)
		}
	} else if (name === 'drive') {
		await expect(page.locator('.drive-browser .empty-state')).toBeVisible()
		await expect(page.locator('.drive-browser .drive-files.is-skeleton')).toHaveCount(0)
	} else {
		await expect(page.locator('.project-timeline .timeline-stats')).toBeVisible()
		await expect(page.locator('.project-timeline .timeline-projects-body .empty-state')).toBeVisible()
		await expect(page.locator('.timeline-skeleton')).toHaveCount(0)
	}
}

for (const width of [1440, 390]) {
	test(`weakNetwork navigation keeps the SPA and unsent chat draft at ${width}px`, async ({authenticatedPage: page}, testInfo) => {
		test.setTimeout(120_000)
		await page.setViewportSize({width, height: 900})
		await page.goto('/ai')
		const composer = page.locator('#main-content .tcy-assistant:not(.is-embedded) .composer textarea')
		await expect(composer).toBeVisible()
		const draft = 'Keep this unsent request while checking my empty workspace'
		await composer.fill(draft)
		const marker = await page.evaluate(() => {
			const value = crypto.randomUUID()
			Object.assign(window, {weakNavigationDocument: value})
			return value
		})
		const requests = {calendar: 0, drive: 0, timeline: 0, user: 0}
		page.on('request', request => {
			if (request.method() !== 'GET') return
			const path = new URL(request.url()).pathname
			if (path.endsWith('/api/v2/tasks/calendar')) requests.calendar++
			else if (path.endsWith('/api/v2/drive/files')) requests.drive++
			else if (path.endsWith('/api/v2/projects/timeline')) requests.timeline++
			else if (path.endsWith('/api/v2/user')) requests.user++
		})
		const client = await page.context().newCDPSession(page)
		const conditions = {
			offline: false,
			latency: 1000,
			downloadThroughput: 100 * 1024,
			uploadThroughput: 50 * 1024,
			connectionType: 'cellular3g',
		}
		const samples: {phase: 'cold' | 'warm', destination: Destination, elapsedMs: number}[] = []
		await client.send('Network.enable')
		await client.send('Network.emulateNetworkConditions', conditions)
		try {
			for (const phase of ['cold', 'warm'] as const) {
				for (const destination of destinations) {
					const before = {...requests}
					const start = performance.now()
					await followSidebar(page, destination.path, width)
					await expectActualPage(page, destination.name, width)
					samples.push({phase, destination: destination.name, elapsedMs: Math.round(performance.now() - start)})
					// These are real, successful API reads. A fresh revisit reuses the same-account
					// query cache rather than waiting for a second throttled request or a polling period.
					if (phase === 'cold') expect(requests[destination.name]).toBeGreaterThan(before[destination.name])
					else expect(requests[destination.name]).toBe(before[destination.name])
					expect(await page.evaluate(() => (window as Window & {weakNavigationDocument?: string}).weakNavigationDocument)).toBe(marker)
				}
			}
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`weak-navigation-${width}.png`)})
			await followSidebar(page, '/ai', width)
			await expect(composer).toHaveValue(draft)
			expect(await page.evaluate(() => (window as Window & {weakNavigationDocument?: string}).weakNavigationDocument)).toBe(marker)
			await expect(page.locator('.chunk-load-recovery')).toHaveCount(0)
			await testInfo.attach('weak-navigation-measurements', {
				contentType: 'application/json',
				body: Buffer.from(JSON.stringify({
					width,
					conditions,
					samples,
					requests,
					method: 'Real Chromium network emulation; UI sidebar navigation; no intercepted requests. Warm means query reuse, not an HTTP-cache claim.',
				}, null, 2)),
			})
		} finally {
			await client.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			})
			await client.detach()
		}
	})
}
