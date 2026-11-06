import {test, expect} from '../../support/fixtures'
import {createProjects} from '../project/prepareProjects'
import {TaskFactory} from '../../factories/task'
import {updateUserSettings} from '../../support/updateUserSettings'
import {apiRootUrl} from '../../support/apiUrl'

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
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).check()
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).press('Space')
		await expect(page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true})).not.toBeChecked()
		await expect(page.getByRole('button', {name: 'Review cleanup', exact: true})).toHaveCount(0)
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).press('Space')
		await expect(page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true})).toBeChecked()
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
		await page.getByRole('checkbox', {name: 'Select selective-cleanup.txt', exact: true}).check()
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

test('deleting a conversation through storage keeps its task image and Drive original', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
	test.setTimeout(60_000)
	await page.setViewportSize({width: 390, height: 900})
	await createProjects(1)
	await TaskFactory.create(1, {title: 'Retained task image'})
	const headers = {Authorization: `Bearer ${userToken}`}
	const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQ6/lKU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAL2yfFv5tHQyAAAAAElFTkSuQmCC', 'base64')
	const uploaded = await apiContext.post('/api/v2/drive/files', {
		headers,
		multipart: {file: {name: 'retained-image.png', mimeType: 'image/png', buffer: image}},
	})
	expect(uploaded.ok()).toBe(true)
	const file = await uploaded.json()
	const created = await apiContext.post('/api/v2/ai/conversations', {
		headers,
		data: {title: 'A conversation with a saved task image'},
	})
	expect(created.ok()).toBe(true)
	const conversation = await created.json()
	const referenced = await apiContext.post(`/api/v2/ai/conversations/${conversation.id}/attachments/from-drive`, {
		headers,
		data: {file_id: file.file_id},
	})
	expect(referenced.ok()).toBe(true)
	const drive = await (await apiContext.get('/api/v2/drive/files', {headers})).json()
	expect(drive.files).toHaveLength(1)
	const attached = await apiContext.post(`/api/v2/drive/files/${file.file_id}/attach`, {
		headers,
		data: {revision: drive.files[0].revision, task_id: 1},
	})
	expect(attached.ok()).toBe(true)
	const attachment = await attached.json()
	const api = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
	const savedDescription = await apiContext.patch('/api/v2/tasks/1', {
		headers: {...headers, 'Content-Type': 'application/json-patch+json'},
		data: [{op: 'add', path: '/description', value: `<p>Kept task notes</p><img src="${api}/tasks/1/attachments/${attachment.id}">`}],
	})
	expect(savedDescription.ok()).toBe(true)
	await page.goto('/user/settings/storage')
	await page.locator('.storage-tabs').getByRole('button', {name: 'Conversations', exact: true}).click()
	await page.getByRole('checkbox', {name: 'Select A conversation with a saved task image', exact: true}).check()
	await page.getByRole('button', {name: 'Review cleanup', exact: true}).click()
	const dialog = page.getByRole('dialog', {name: 'Review cleanup', exact: true})
	await expect(dialog).toContainText('keeps Drive originals and images already attached to tasks')
	await dialog.getByRole('button', {name: 'Continue to confirmation', exact: true}).click()
	await expect(dialog).toContainText('keeps Drive originals and images already attached to tasks')
	await page.screenshot({path: testInfo.outputPath('storage-chat-retention-390.png')})
	await dialog.getByRole('checkbox').check()
	await dialog.getByLabel('Type DELETE to confirm', {exact: true}).fill('DELETE')
	await dialog.getByRole('button', {name: 'Delete permanently', exact: true}).click()
	await expect(dialog.locator('[data-cy=storage-results]')).toContainText('Processed 1 of 1 requests')
	expect((await apiContext.get(`/api/v2/ai/conversations/${conversation.id}`, {headers})).status()).toBe(404)
	const taskImage = await apiContext.get(`/api/v2/tasks/1/attachments/${attachment.id}`, {headers})
	expect(taskImage.status()).toBe(200)
	expect(await taskImage.body()).toEqual(image)
	const remaining = await (await apiContext.get('/api/v2/drive/files', {headers})).json()
	expect(remaining.files).toHaveLength(1)
	expect(remaining.files[0].file_id).toBe(file.file_id)
	const original = await apiContext.get(`/api/v2/drive/files/${file.file_id}/download`, {headers})
	expect(original.status()).toBe(200)
	expect(await original.body()).toEqual(image)
	await page.goto('/tasks/1')
	const description = page.locator('.tiptap__task-description')
	await expect(description.locator('img')).toBeVisible()
	await expect.poll(() => description.locator('img').evaluate(image => image instanceof HTMLImageElement
		&& image.complete && image.naturalWidth === 32)).toBe(true)
	await description.locator('button.done-edit').click()
	const editor = description.locator('[contenteditable=true]')
	await editor.fill('Kept task notes')
	await description.getByRole('button', {name: 'Save', exact: true}).click()
	await expect(page.getByText('Removed from the description. Files in task attachments and Drive are kept.', {exact: true})).toBeVisible()
	await expect(description.locator('img')).toHaveCount(0)
	await expect(page.locator('.content.attachments')).toContainText('retained-image.png')
	const finalTask = await (await apiContext.get('/api/v2/tasks/1', {headers})).json()
	expect(finalTask.description).not.toContain('attachments/')
	expect(finalTask.attachments).toHaveLength(1)
	expect(finalTask.attachments[0].file.id).toBe(file.file_id)
	expect(await (await apiContext.get(`/api/v2/drive/files/${file.file_id}/download`, {headers})).body()).toEqual(image)
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
