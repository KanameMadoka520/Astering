import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {Factory} from '../../support/factory'
import {createProjects} from '../project/prepareProjects'
import {TaskFactory} from '../../factories/task'

async function upload(api: APIRequestContext, token: string, name: string) {
	const response = await api.post('/api/v2/drive/files', {
		headers: {Authorization: `Bearer ${token}`},
		multipart: {file: {name, mimeType: 'text/plain', buffer: Buffer.from(`Isolated fixture: ${name}`)}},
	})
	expect(response.status()).toBe(200)
	return response.json()
}

async function list(api: APIRequestContext, token: string, trash = false) {
	const response = await api.get(`/api/v2/drive/files?trash=${trash}`, {headers: {Authorization: `Bearer ${token}`}})
	expect(response.ok()).toBe(true)
	return (await response.json()).files as {file_id: number, revision: number, pinned: boolean, category: string, file: {name: string}}[]
}

async function selectPage(page: Page) {
	const enter = page.getByRole('button', {name: 'Select files', exact: true})
	if (await enter.isVisible()) await enter.click()
	await page.getByRole('button', {name: 'Select current page', exact: true}).click()
}

function review(page: Page) {
	return page.getByRole('dialog', {name: 'Review selected files', exact: true})
}

async function finish(page: Page, count: number) {
	const dialog = review(page)
	await dialog.getByRole('button', {name: 'Apply to eligible files', exact: true}).click()
	await expect(dialog.locator('.drive-batch-review[data-stage="results"]')).toBeVisible()
	await expect(dialog.locator('.drive-batch-review__files > li').filter({hasText: 'Completed'})).toHaveCount(count)
	await dialog.getByRole('button', {name: 'Close', exact: true}).click()
	await expect(dialog).not.toBeVisible()
}

for (const width of [1440, 390]) {
	test(`Drive multi-select preserves fields, categorizes, pins, recycles and restores at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		test.setTimeout(90_000)
		await upload(apiContext, userToken, 'first-batch.txt')
		await upload(apiContext, userToken, 'second-batch.txt')
		await page.setViewportSize({width, height: 900})
		await page.goto('/drive')
		await expect(page.locator('.drive-card')).toHaveCount(2)
		await selectPage(page)
		await expect(page.locator('.drive-batch')).toContainText('2 selected')
		await page.screenshot({path: testInfo.outputPath(`drive-selection-${width}.png`), fullPage: true})
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.getByRole('button', {name: 'Pin selected', exact: true}).click()
		await finish(page, 2)
		let files = await list(apiContext, userToken)
		expect(files.every(file => file.pinned)).toBe(true)
		expect(files.map(file => file.file.name).sort()).toEqual(['first-batch.txt', 'second-batch.txt'])

		await selectPage(page)
		await page.getByRole('button', {name: 'Set category', exact: true}).click()
		await review(page).getByLabel('Category', {exact: true}).fill('Research')
		await finish(page, 2)
		files = await list(apiContext, userToken)
		expect(files.every(file => file.category === 'Research' && file.pinned)).toBe(true)

		await selectPage(page)
		await page.getByRole('button', {name: 'Unpin selected', exact: true}).click()
		await finish(page, 2)
		files = await list(apiContext, userToken)
		expect(files.every(file => file.category === 'Research' && !file.pinned)).toBe(true)

		await selectPage(page)
		await page.getByRole('button', {name: 'Move selected to recycle bin', exact: true}).click()
		const dialog = review(page)
		await expect(dialog.getByRole('button', {name: 'Apply to eligible files', exact: true})).toHaveAttribute('aria-disabled', 'true')
		const surface = dialog.locator('.drive-batch-review')
		expect(await surface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
		if (width < 600) {
			const box = (await surface.boundingBox())!
			expect(box.x).toBeGreaterThanOrEqual(12)
			expect(Math.abs(box.x - (width - box.x - box.width))).toBeLessThanOrEqual(2)
		}
		await dialog.getByRole('checkbox', {name: /^I confirm recycling 2 unused files\.$/}).check()
		await page.screenshot({path: testInfo.outputPath(`drive-review-${width}.png`)})
		await finish(page, 2)
		await expect(page.locator('.drive-card')).toHaveCount(0)
		expect(await list(apiContext, userToken, true)).toHaveLength(2)

		await page.getByRole('button', {name: 'Recycle bin', exact: true}).click()
		await expect(page.locator('.drive-card')).toHaveCount(2)
		await selectPage(page)
		await page.getByRole('button', {name: 'Restore selected', exact: true}).click()
		await finish(page, 2)
		expect(await list(apiContext, userToken, true)).toHaveLength(0)
		files = await list(apiContext, userToken)
		expect(files).toHaveLength(2)
		expect(files.every(file => file.category === 'Research' && !file.pinned)).toBe(true)
		await page.reload()
		await expect(page.getByRole('button', {name: 'Select files', exact: true})).toBeVisible()
	})
}

test('batch recycling protects referenced files while processing eligible files', async ({authenticatedPage: page, apiContext, userToken}) => {
	await createProjects(1)
	await TaskFactory.create(1, {id: 1, title: 'Protected attachment'})
	const referenced = await upload(apiContext, userToken, 'still-used.txt')
	await upload(apiContext, userToken, 'unused.txt')
	const attached = await apiContext.post(`/api/v2/drive/files/${referenced.file_id}/attach`, {
		headers: {Authorization: `Bearer ${userToken}`}, data: {revision: referenced.revision, task_id: 1},
	})
	expect(attached.status()).toBe(200)
	await page.goto('/drive')
	await expect(page.locator('.drive-card')).toHaveCount(2)
	await selectPage(page)
	await page.getByRole('button', {name: 'Move selected to recycle bin', exact: true}).click()
	const dialog = review(page)
	const protectedRow = dialog.locator('.drive-batch-review__files > li').filter({hasText: 'still-used.txt'})
	await expect(protectedRow).toContainText('Protected')
	await expect(protectedRow.locator('details')).toContainText('Protected attachment')
	await dialog.getByRole('checkbox', {name: /^I confirm recycling 1 unused files?\.$/}).check()
	await finish(page, 1)
	await expect(page.locator('.drive-card')).toHaveCount(1)
	await expect(page.locator('.drive-card')).toContainText('still-used.txt')
	const headers = {Authorization: `Bearer ${userToken}`}
	const preserved = await apiContext.get(`/api/v2/drive/files/${referenced.file_id}/download`, {headers})
	expect(preserved.status()).toBe(200)
	expect(await preserved.text()).toBe('Isolated fixture: still-used.txt')
	const task = await (await apiContext.get('/api/v2/tasks/1', {headers})).json()
	expect(task.attachments.some((file: {file: {id: number}}) => file.file.id === referenced.file_id)).toBe(true)
})

test('selection is limited to the current page and clears across paging and filters', async ({authenticatedPage: page, currentUser}) => {
	await Factory.seed('files', Array.from({length: 61}, (_, i) => ({id: i + 1, name: `batch-page-${i + 1}.txt`, mime: 'text/plain', size: 1, created_by_id: currentUser.id})))
	await Factory.seed('drive_files', Array.from({length: 61}, (_, i) => ({file_id: i + 1, owner_id: currentUser.id, revision: 1, pinned: false, category: ''})))
	await page.goto('/drive')
	await expect(page.locator('.drive-card')).toHaveCount(60)
	await selectPage(page)
	await expect(page.locator('.drive-batch')).toContainText('60 selected')
	await page.getByRole('button', {name: 'Next', exact: true}).click()
	await expect(page.locator('.drive-card')).toHaveCount(1)
	await expect(page.getByRole('button', {name: 'Select files', exact: true})).toBeVisible()
	await selectPage(page)
	await expect(page.locator('.drive-batch')).toContainText('1 selected')
	await page.getByRole('searchbox').fill('does-not-exist')
	await expect(page.getByRole('button', {name: 'Select files', exact: true})).toBeVisible()
	await expect(page.getByRole('button', {name: 'Pin selected', exact: true})).toHaveCount(0)
	await expect(page.locator('.drive-card')).toHaveCount(0)
})

test('a changed file is protected without rolling back successful files', async ({authenticatedPage: page, apiContext, userToken}) => {
	const first = await upload(apiContext, userToken, 'changed-elsewhere.txt')
	await upload(apiContext, userToken, 'unchanged.txt')
	await page.goto('/drive')
	await expect(page.locator('.drive-card')).toHaveCount(2)
	await selectPage(page)
	await page.getByRole('button', {name: 'Pin selected', exact: true}).click()
	await expect(review(page).locator('.drive-batch-review[data-stage="review"]')).toBeVisible()
	const edited = await apiContext.patch(`/api/v2/drive/files/${first.file_id}`, {
		headers: {Authorization: `Bearer ${userToken}`},
		data: {action: 'edit', revision: first.revision, name: 'renamed-elsewhere.txt', category: 'Other tab', pinned: false},
	})
	expect(edited.ok()).toBe(true)
	await finish(page, 1)
	const files = await list(apiContext, userToken)
	expect(files.find(file => file.file_id === first.file_id)).toMatchObject({category: 'Other tab', pinned: false, file: {name: 'renamed-elsewhere.txt'}})
	expect(files.find(file => file.file_id !== first.file_id)?.pinned).toBe(true)
})

test('recycling the final page preserves its result before returning to the remaining files', async ({authenticatedPage: page, currentUser}) => {
	await Factory.seed('files', Array.from({length: 61}, (_, i) => ({id: i + 1, name: `last-page-${i + 1}.txt`, mime: 'text/plain', size: 1, created_by_id: currentUser.id})))
	await Factory.seed('drive_files', Array.from({length: 61}, (_, i) => ({file_id: i + 1, owner_id: currentUser.id, revision: 1, pinned: false, category: ''})))
	await page.goto('/drive')
	await expect(page.locator('.drive-card')).toHaveCount(60)
	await page.getByRole('button', {name: 'Next', exact: true}).click()
	await expect(page.locator('.drive-card')).toHaveCount(1)
	await selectPage(page)
	await page.getByRole('button', {name: 'Move selected to recycle bin', exact: true}).click()
	await review(page).getByRole('checkbox', {name: /^I confirm recycling 1 unused files?\.$/}).check()
	await finish(page, 1)
	await expect(page.locator('.drive-card')).toHaveCount(60)
})

test('a lost write acknowledgement is reported as unknown and never automatically replayed', async ({authenticatedPage: page, apiContext, userToken}) => {
	await upload(apiContext, userToken, 'acknowledgement.txt')
	await page.goto('/drive')
	await expect(page.locator('.drive-card')).toHaveCount(1)
	let writes = 0
	await page.route('**/api/v2/drive/files/*', async route => {
		if (route.request().method() !== 'PATCH') return route.continue()
		writes++
		const applied = await route.fetch()
		expect(applied.ok()).toBe(true)
		await route.abort('connectionreset')
	})
	await selectPage(page)
	await page.getByRole('button', {name: 'Pin selected', exact: true}).click()
	const dialog = review(page)
	await dialog.getByRole('button', {name: 'Apply to eligible files', exact: true}).click()
	await expect(dialog.locator('.drive-batch-review[data-stage="results"]')).toBeVisible()
	await expect(dialog).toContainText('Result unknown')
	expect(writes).toBe(1)
	expect((await list(apiContext, userToken))[0].pinned).toBe(true)
})
