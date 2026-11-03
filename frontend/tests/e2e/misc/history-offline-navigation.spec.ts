import type {Response} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {Factory} from '../../support/factory'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'

for (const width of [1440, 390]) {
	test(`historyOffline range changes retain the labelled original year and resume at ${width}px`, async ({authenticatedPage: page}, testInfo) => {
		await page.setViewportSize({width, height: 900})
		await ProjectFactory.create(1, {id: 1, title: 'Offline history fixture'})
		await TaskFactory.create(1, {
			id: 1,
			project_id: 1,
			title: 'Scheduled fixture',
			start_date: '2040-06-01T09:00:00Z',
			end_date: '2040-06-02T10:00:00Z',
		})
		await Factory.seed('project_lifecycle_events', [{
			id: 1,
			project_id: 1,
			kind: 'completed',
			occurred_at: '2040-06-01T12:00:00Z',
		}])
		for (const tab of ['timeline', 'lifecycle']) {
			await page.goto(`/projects/history?tab=${tab}&year=2040`)
			const records = page.locator(tab === 'timeline' ? '.lane' : '.history-records li')
			await expect(records).toHaveCount(1)
			await expect(records.first()).toContainText('Offline history fixture')
			let resumed: Promise<Response> | undefined
			try {
				await page.context().setOffline(true)
				await page.getByRole('button', {name: 'Next year', exact: true}).click()
				await expect(page).toHaveURL(/year=2041/)
				const status = page.locator('.history-connection-status')
				await expect(status).toContainText('Waiting for a connection')
				await expect(status).toContainText('2040')
				await expect(records).toHaveCount(1)
				await expect(records.first()).toContainText('Offline history fixture')
				if (tab === 'timeline') await expect(page.locator('#timeline-projects-heading')).toContainText('2040')
				else expect(await page.locator('.year-grid [data-date^="2040-"]').count()).toBe(366)
				await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`history-offline-${tab}-${width}.png`)})
				resumed = page.waitForResponse(response => {
					const url = new URL(response.url())
					return response.request().method() === 'GET'
						&& url.pathname.endsWith(tab === 'timeline' ? '/api/v2/projects/timeline' : '/api/v2/projects/history')
						&& url.searchParams.get('year') === '2041'
				})
			} finally {
				await page.context().setOffline(false)
			}
			expect((await resumed!).status()).toBe(200)
			await expect(page.locator('.history-connection-status')).toHaveCount(0)
			await expect(page.locator('.project-history .load-error, .project-history .history-state[role="alert"]')).toHaveCount(0)
			await expect(records).toHaveCount(0)
			await expect(page.getByRole('combobox', {name: 'Year', exact: true})).toHaveValue('2041')
		}
	})
}
