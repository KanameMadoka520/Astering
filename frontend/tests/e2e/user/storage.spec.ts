import {test, expect} from '../../support/fixtures'
import {createProjects} from '../project/prepareProjects'
import {TaskFactory} from '../../factories/task'
import {updateUserSettings} from '../../support/updateUserSettings'

for (const width of [1440, 390]) {
	test(`personal storage previews, recycles and permanently deletes an owned file at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		test.setTimeout(90_000)
		await page.setViewportSize({width, height: 900})
		const headers = {Authorization: `Bearer ${userToken}`}
		const data = Buffer.from('A synthetic file for selective cleanup.')
		const response = await apiContext.post('/api/v2/drive/files', {
			headers,
			multipart: {file: {name: 'selective-cleanup.txt', mimeType: 'text/plain', buffer: data}},
		})
		expect(response.status()).toBe(200)
		const file = await response.json()
		await page.goto('/user/settings/storage')
		await expect(page.getByRole('heading', {name: 'Storage', exact: true})).toBeVisible()
		await expect(page.locator('[data-cy=storage-files]')).toContainText('selective-cleanup.txt')
		await expect(page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true})).not.toBeChecked()
		await testInfo.attach(`storage-${width}`, {body: await page.screenshot({path: testInfo.outputPath(`storage-${width}.png`)}), contentType: 'image/png'})
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).click()
		await page.getByRole('button', {name: 'Review cleanup', exact: true}).click()
		const dialog = page.getByRole('dialog', {name: 'Review cleanup', exact: true})
		await expect(dialog).toContainText('Ready for confirmation')
		await expect(dialog.locator('.storage-cleanup__estimate strong')).toHaveText('0 B')
		await dialog.getByRole('button', {name: 'Confirm cleanup', exact: true}).click()
		await expect(dialog.locator('[data-cy=storage-results]')).toContainText('Processed 1 of 1 requests')
		await expect(dialog.locator('[data-cy=storage-results]')).toContainText('0 B of stored data verified as removed')
		await dialog.getByRole('button', {name: 'Close', exact: true}).click()
		let recycled = await (await apiContext.get('/api/v2/drive/files?trash=true', {headers})).json()
		expect(recycled.files.some((item: {file_id: number}) => item.file_id === file.file_id)).toBe(true)
		await page.getByLabel('What to clean up', {exact: true}).selectOption('purge')
		await page.getByLabel('Location', {exact: true}).selectOption('trash')
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).click()
		await page.getByRole('button', {name: 'Review cleanup', exact: true}).click()
		await expect(dialog).toContainText('Ready for confirmation')
		await dialog.getByRole('button', {name: 'Continue to confirmation', exact: true}).click()
		const purge = dialog.getByRole('button', {name: 'Delete permanently', exact: true})
		await expect(purge).toHaveAttribute('aria-disabled', 'true')
		await dialog.getByRole('checkbox').check()
		await dialog.getByLabel('Type DELETE to confirm', {exact: true}).fill('DELETE')
		await expect(purge).toBeEnabled()
		await dialog.getByRole('button', {name: 'Back to review', exact: true}).click()
		await expect(dialog).toContainText('Ready for confirmation')
		recycled = await (await apiContext.get('/api/v2/drive/files?trash=true', {headers})).json()
		expect(recycled.files.some((item: {file_id: number}) => item.file_id === file.file_id)).toBe(true)
		await dialog.getByRole('button', {name: 'Continue to confirmation', exact: true}).click()
		await expect(dialog.getByRole('checkbox')).not.toBeChecked()
		await expect(dialog.getByLabel('Type DELETE to confirm', {exact: true})).toHaveValue('')
		await expect(purge).toHaveAttribute('aria-disabled', 'true')
		await dialog.getByRole('checkbox').check()
		await dialog.getByLabel('Type DELETE to confirm', {exact: true}).fill('DELETE')
		await purge.click()
		await expect(dialog.locator('[data-cy=storage-results]')).toContainText('Processed 1 of 1 requests')
		await expect(dialog.locator('[data-cy=storage-results]')).toContainText(`${data.length} B of stored data verified as removed`)
		await dialog.getByRole('button', {name: 'Close', exact: true}).click()
		recycled = await (await apiContext.get('/api/v2/drive/files?trash=true', {headers})).json()
		expect(recycled.files.some((item: {file_id: number}) => item.file_id === file.file_id)).toBe(false)
		expect((await apiContext.get(`/api/v2/drive/files/${file.file_id}/download`, {headers})).status()).toBe(404)
		await page.reload()
		await expect(page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true})).toHaveCount(0)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	})
}

test('personal cleanup explains and preserves a file used by a task', async ({authenticatedPage: page, apiContext, userToken}) => {
	await createProjects(1)
	await TaskFactory.create(1, {title: 'Protected attachment task'})
	const headers = {Authorization: `Bearer ${userToken}`}
	const uploaded = await apiContext.post('/api/v2/drive/files', {
		headers,
		multipart: {file: {name: 'referenced.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this original')}},
	})
	const file = await uploaded.json()
	const attached = await apiContext.post(`/api/v2/drive/files/${file.file_id}/attach`, {
		headers,
		data: {revision: file.revision, task_id: 1},
	})
	expect(attached.ok()).toBe(true)
	await page.goto('/user/settings/storage')
	await page.getByRole('checkbox', {name: 'Select referenced.txt', exact: true}).click()
	await page.getByRole('button', {name: 'Review cleanup', exact: true}).click()
	const dialog = page.getByRole('dialog', {name: 'Review cleanup', exact: true})
	await expect(dialog).toContainText('Still in use')
	await expect(dialog).toContainText('Protected attachment task')
	await expect(dialog.getByRole('button', {name: 'Confirm cleanup', exact: true})).toHaveAttribute('aria-disabled', 'true')
	await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
	const task = await (await apiContext.get('/api/v2/tasks/1', {headers})).json()
	expect(task.attachments.some((attachment: {file: {id: number}}) => attachment.file.id === file.file_id)).toBe(true)
	expect((await apiContext.get(`/api/v2/drive/files/${file.file_id}/download`, {headers})).status()).toBe(200)
})

// The narrowest supported touch layout also uses the real persisted Chinese preference.
test('personal storage keeps Chinese filters accessible at 320px', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
	await updateUserSettings(apiContext, userToken, {language: 'zh-CN'})
	await page.setViewportSize({width: 320, height: 844})
	await page.goto('/user/settings/storage')
	await expect(page.getByRole('heading', {name: '存储空间', exact: true})).toBeVisible()
	await expect(page.getByLabel('文件类型', {exact: true})).toBeVisible()
	await page.getByLabel('要进行什么清理', {exact: true}).selectOption('clear_previews')
	await expect(page.getByLabel('要进行什么清理', {exact: true})).toHaveValue('clear_previews')
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.screenshot({path: testInfo.outputPath('storage-chinese-320.png'), fullPage: true})
})
