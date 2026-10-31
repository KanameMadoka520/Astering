import {readFile} from 'node:fs/promises'
import type {Locator} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {COMPASS_API, createCompassEntry, createCompassSpace, readCompassEntry} from './compassApi'

async function expectDecoded(image: Locator) {
	await expect(image).toBeVisible()
	await expect(image).toHaveAttribute('src', /^blob:/)
	await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
		element.complete && element.naturalWidth > 0,
	)).toBe(true)
}

test('a phone writer chooses WebP once for two images and saves both in the entry', async ({
	authenticatedPage: page, apiContext, userToken,
}, testInfo) => {
	test.setTimeout(120_000)
	const space = await createCompassSpace(apiContext, userToken, {title: 'Pictures from my phone'})
	await page.setViewportSize({width: 390, height: 844})
	await page.emulateMedia({reducedMotion: 'reduce'})
	await page.goto(`/compass/spaces/${space.id}/write`)
	const desk = page.locator('form.compass-desk')
	await expect(desk.getByLabel('Title', {exact: true})).toBeVisible()
	// Different pixels ensure deduplication cannot hide one lost upload.
	const images = await page.evaluate(() => ['#267ac4', '#d26a35'].map(color => {
		const canvas = document.createElement('canvas')
		canvas.width = 96
		canvas.height = 64
		const context = canvas.getContext('2d')!
		context.fillStyle = color
		context.fillRect(0, 0, canvas.width, canvas.height)
		return canvas.toDataURL('image/png').split(',')[1]
	}))
	await page.locator('dialog.image-upload-dialog').waitFor({state: 'attached'})
	await page.evaluate(() => {
		const dialog = document.querySelector('dialog.image-upload-dialog')!
		const counter = window as unknown as {compassFormatOpenings: number}
		counter.compassFormatOpenings = 0
		new MutationObserver(records => {
			counter.compassFormatOpenings += records.filter(record => record.oldValue === null).length
		}).observe(dialog, {attributes: true, attributeFilter: ['open'], attributeOldValue: true})
	})
	// Hold the first real upload until its queue is inspected, instead of racing a fast localhost transfer.
	let releaseUpload!: () => void
	const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
	const modes: (string | undefined)[] = []
	await page.route('**/api/v2/drive/files', async route => {
		if (route.request().method() !== 'POST') return route.continue()
		modes.push(route.request().headers()['x-vikunja-image-mode'])
		if (modes.length === 1) await uploadGate
		return route.continue()
	})
	await desk.locator('.compass-desk__media input[type=file]').setInputFiles(images.map((data, index) => ({
		name: `memory-${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64'),
	})))
	const choice = page.getByRole('dialog', {name: 'Choose how to upload images'})
	await expect(choice).toBeVisible()
	await expect(choice.getByRole('listitem')).toHaveCount(2)
	await choice.getByLabel('Compress to WebP before uploading').check()
	await choice.getByRole('button', {name: 'Upload images', exact: true}).click()
	try {
		await expect(choice).toBeHidden()
		const tray = desk.locator('.compass-image-tray')
		await expect(tray).toBeVisible()
		await expect(tray).toHaveAttribute('aria-busy', 'true')
		await expect(tray.locator('.compass-image-tray__item')).toHaveCount(2)
		await expect(tray.locator('[data-state="queued"]')).toHaveCount(1)
		await expect(tray.locator('[data-state="uploading"]')).toHaveCount(1)
		await page.screenshot({path: testInfo.outputPath('phone-image-upload-queue.png'), fullPage: true})
	} finally {
		releaseUpload()
	}
	const editorImages = desk.locator('.compass-editor-image img')
	await expect(editorImages).toHaveCount(2)
	for (const image of await editorImages.all()) await expectDecoded(image)
	expect(modes).toEqual(['webp', 'webp'])
	await expect(choice).toBeHidden()
	expect(await page.evaluate(() => (window as unknown as {compassFormatOpenings: number}).compassFormatOpenings)).toBe(1)
	await desk.getByLabel('Title', {exact: true}).fill('Two images, one choice')
	const savedResponse = page.waitForResponse(response =>
		response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v2/compass/spaces/${space.id}/entries`,
	)
	await desk.locator('.compass-desk__save').click()
	const response = await savedResponse
	expect(response.status()).toBe(201)
	const {id} = await response.json() as {id: number}
	await expect(page).toHaveURL(new RegExp(`/compass/entries/${id}/edit$`))
	const stored = await readCompassEntry(apiContext, userToken, id)
	const imageIds = [...(stored.content ?? '').matchAll(/data-compass-image="(\d+)"/g)].map(match => match[1])
	expect(new Set(imageIds).size).toBe(2)
	for (const fileId of imageIds) {
		const image = await apiContext.get(`${COMPASS_API}/compass/spaces/${space.id}/images/${fileId}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(image.status()).toBe(200)
		expect(image.headers()['content-type']).toContain('image/webp')
	}
	await page.goto(`/compass/entries/${id}`)
	await expect(page.getByRole('heading', {name: 'Two images, one choice', level: 1, exact: true})).toBeVisible()
	const readerImages = page.locator('.compass-reader__body img[data-compass-image]')
	await expect(readerImages).toHaveCount(2)
	for (const image of await readerImages.all()) await expectDecoded(image)
	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
	await page.screenshot({path: testInfo.outputPath('phone-saved-webp-images.png'), fullPage: true})
})

test('the reader downloads a real ZIP containing the illustrated entry', async ({
	authenticatedPage: page, apiContext, userToken,
}, testInfo) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const bytes = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const upload = await apiContext.post(`${COMPASS_API}/drive/files`, {
		headers,
		multipart: {file: {name: 'export-memory.png', mimeType: 'image/png', buffer: bytes}},
	})
	expect(upload.ok(), await upload.text()).toBe(true)
	const {file_id: fileId} = await upload.json() as {file_id: number}
	const space = await createCompassSpace(apiContext, userToken, {title: 'Exported memories'})
	const entry = await createCompassEntry(apiContext, userToken, space.id, {
		title: 'A memory with its picture',
		content: `<p>Keep the image beside these words.</p><img data-compass-image="${fileId}" alt="Blue memory" width="96" height="64">`,
	})
	await page.goto(`/compass/entries/${entry.id}`)
	await expectDecoded(page.locator(`.compass-reader__body img[data-compass-image="${fileId}"]`))
	await page.getByRole('group', {name: 'Entry actions'}).getByRole('button', {name: 'Export', exact: true}).click()
	const downloadEvent = page.waitForEvent('download')
	await page.getByRole('button', {name: 'Download with images (.zip)', exact: true}).click()
	const download = await downloadEvent
	expect(download.suggestedFilename()).toBe('A memory with its picture.zip')
	expect(await download.failure()).toBeNull()
	const path = testInfo.outputPath('compass-illustrated-entry.zip')
	await download.saveAs(path)
	const zip = await readFile(path)
	expect(zip.length).toBeGreaterThan(bytes.length)
	expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
	// Keep the original download for the release's independent archive/content inspection.
	await testInfo.attach('illustrated-entry-zip', {path, contentType: 'application/zip'})
})
