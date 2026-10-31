import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'

// Uploads and Drive picks go to the real API. Only the model connection is a fixture, since no model runs here.

const api = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
const ATTACH = 'Attach images or files (paste or drop also works)'

type DraftAttachment = {
	name: string
	mime: string
	drive_file_id?: number
}

async function visionModel(page: Page) {
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'vision',
			name: 'Vision fixture',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.example/v1',
			model: 'vision',
			input_types: ['text', 'image'],
			resolved: {input_types: ['text', 'image']},
		}],
		assistant: 'vision',
		transcription: '',
		cleanup: '',
	}}))
}

function authorization(token: string) {
	return {Authorization: `Bearer ${token}`}
}

test('a batch of images asks for the format once and retries one failed file without asking again', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
}) => {
	const headers = authorization(userToken)
	await visionModel(page)
	const created = await apiContext.post(`${api}/ai/conversations`, {headers, data: {title: 'Image batch'}})
	expect(created.ok()).toBe(true)
	const {id} = await created.json()
	const sent: {mode?: string, clientOnly: string[]}[] = []
	await page.route(`**/api/v2/ai/conversations/${id}/attachments`, async route => {
		const request = route.request()
		if (request.method() !== 'POST') return route.fallback()
		const requestHeaders = await request.allHeaders()
		sent.push({
			mode: requestHeaders['x-vikunja-image-mode'],
			clientOnly: Object.keys(requestHeaders).filter(name => name.startsWith('x-tcy-upload')),
		})
		// One transient server failure, on the second file of the selection.
		if (sent.length === 2) return route.fulfill({status: 500, json: {message: 'Fixture storage hiccup'}})
		return route.continue()
	})
	await page.setViewportSize({width: 390, height: 844})
	await page.goto(`/ai?chat=${id}`)
	await expect(page.getByRole('button', {name: ATTACH, exact: true})).toBeEnabled()

	// Distinct pixels: identical bytes are stored once and could hide a lost upload.
	const images = await page.evaluate(() => [0, 1, 2].map(index => {
		const canvas = document.createElement('canvas')
		canvas.width = 48
		canvas.height = 32
		const context = canvas.getContext('2d')!
		context.fillStyle = `rgb(${40 + index * 90}, 120, 200)`
		context.fillRect(0, 0, canvas.width, canvas.height)
		return canvas.toDataURL('image/png').split(',')[1]
	}))
	await page.locator('dialog.image-upload-dialog').waitFor({state: 'attached'})
	await page.evaluate(() => {
		const dialog = document.querySelector('dialog.image-upload-dialog')!
		const counter = window as unknown as {imageChoiceOpenings: number}
		counter.imageChoiceOpenings = 0
		// An added "open" attribute is one opening, even if it closes again within the same batch of records.
		new MutationObserver(records => {
			counter.imageChoiceOpenings += records.filter(record => record.oldValue === null).length
		}).observe(dialog, {attributes: true, attributeFilter: ['open'], attributeOldValue: true})
	})

	await page.locator('.composer input[type=file]').first().setInputFiles(images.map((data, index) => ({
		name: `photo-${index + 1}.png`,
		mimeType: 'image/png',
		buffer: Buffer.from(data, 'base64'),
	})))
	const choice = page.getByRole('dialog', {name: 'Choose how to upload images'})
	await expect(choice).toBeVisible()
	await expect(choice.getByRole('listitem')).toHaveCount(3)
	await expect(choice.locator('.image-batch-note')).toBeVisible()
	await choice.getByLabel('Compress to WebP before uploading').check()
	await choice.getByRole('button', {name: 'Upload images', exact: true}).click()
	await expect(choice).toBeHidden()

	const failed = page.locator('.chat-upload-tray .chat-upload-item[data-state="failed"]')
	await expect(failed).toHaveCount(1)
	await expect(failed).toContainText('photo-2.png')
	await expect(page.locator('.draft-files .chat-file')).toHaveCount(2)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

	await page.getByRole('button', {name: 'Retry uploading photo-2.png', exact: true}).click()
	await expect(page.locator('.draft-files .chat-file')).toHaveCount(3)
	await expect(failed).toHaveCount(0)
	await expect(choice).toBeHidden()
	expect(await page.evaluate(() => (window as unknown as {imageChoiceOpenings: number}).imageChoiceOpenings)).toBe(1)
	// The one choice applied to every request, the retry included; the client-only batch headers never left the page.
	expect(sent.map(request => request.mode)).toEqual(['webp', 'webp', 'webp', 'webp'])
	expect(sent.flatMap(request => request.clientOnly)).toEqual([])

	const saved = await (await apiContext.get(`${api}/ai/conversations/${id}`, {headers})).json()
	const drafts: DraftAttachment[] = saved.draft_attachments
	expect(drafts.map(file => file.name).sort()).toEqual(['photo-1.webp', 'photo-2.webp', 'photo-3.webp'])
	expect(drafts.every(file => file.mime === 'image/webp')).toBe(true)
	await page.reload()
	await expect(page.locator('.draft-files .chat-file')).toHaveCount(3)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

// Needs root's POST /api/v2/ai/conversations/{id}/attachments/from-drive and ChatAttachment.drive_file_id.
test('a Drive file is attached by reference through the keyboard menu', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
}) => {
	const headers = authorization(userToken)
	await visionModel(page)
	const created = await apiContext.post(`${api}/ai/conversations`, {headers, data: {title: 'Drive attachment'}})
	expect(created.ok()).toBe(true)
	const {id} = await created.json()
	const uploaded = await apiContext.post(`${api}/drive/files`, {
		headers,
		multipart: {
			file: {
				name: 'launch-notes.txt',
				mimeType: 'text/plain',
				buffer: Buffer.from('Launch checklist kept in Drive'),
			},
		},
	})
	expect(uploaded.ok()).toBe(true)
	const driveFile = await uploaded.json()
	await page.setViewportSize({width: 1440, height: 900})
	await page.goto(`/ai?chat=${id}`)

	const trigger = page.getByRole('button', {name: ATTACH, exact: true})
	await expect(trigger).toBeEnabled()
	await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
	await trigger.focus()
	await page.keyboard.press('Enter')
	await expect(page.getByRole('menuitem', {name: 'Upload from this device', exact: true})).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect(page.getByRole('menuitem', {name: 'Choose from Drive', exact: true})).toBeFocused()
	await page.keyboard.press('Enter')
	const picker = page.getByRole('dialog', {name: 'Choose from Drive'})
	await picker.locator('.drive-card')
		.filter({hasText: 'launch-notes.txt'})
		.getByRole('button', {name: 'Choose from Drive', exact: true})
		.click()
	await expect(picker).toBeHidden()

	const draft = page.locator('.draft-files .chat-file').filter({hasText: 'launch-notes.txt'})
	await expect(draft).toHaveCount(1)
	await expect(draft.locator('.in-drive')).toBeVisible()
	const saved = await (await apiContext.get(`${api}/ai/conversations/${id}`, {headers})).json()
	expect(saved.draft_attachments).toEqual([expect.objectContaining({
		name: 'launch-notes.txt',
		drive_file_id: driveFile.file_id,
	})])
	// Referenced, not copied: the Drive still holds the one file.
	const drive = await (await apiContext.get(`${api}/drive/files`, {headers})).json()
	expect(drive.total).toBe(1)
	await page.reload()
	await expect(draft.locator('.in-drive')).toBeVisible()
})
