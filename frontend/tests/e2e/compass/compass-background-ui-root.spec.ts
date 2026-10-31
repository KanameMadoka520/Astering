import {readFile} from 'node:fs/promises'

import {test, expect} from '../../support/fixtures'
import {COMPASS_API, createCompassSpace, readCompassSpace} from './compassApi'

test('space settings saves a Drive background and clears it without deleting the file', async ({
	authenticatedPage: page, apiContext, userToken,
}, testInfo) => {
	test.setTimeout(120_000)
	const headers = {Authorization: `Bearer ${userToken}`}
	const bytes = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const upload = await apiContext.post(`${COMPASS_API}/drive/files`, {
		headers,
		multipart: {file: {name: 'background-from-drive.png', mimeType: 'image/png', buffer: bytes}},
	})
	expect(upload.ok(), await upload.text()).toBe(true)
	const {file_id: fileId} = await upload.json() as {file_id: number}
	expect(fileId).toBeGreaterThan(0)
	const space = await createCompassSpace(apiContext, userToken, {title: 'A sky of my own', theme: 'nebula'})
	await page.setViewportSize({width: 390, height: 844})
	await page.emulateMedia({reducedMotion: 'reduce'})
	const settingsPath = `/compass/spaces/${space.id}/settings`
	await page.goto(settingsPath)
	const background = page.getByRole('group', {name: 'Background image', exact: true})
	await background.getByRole('button', {name: 'From Drive', exact: true}).click()
	const picker = page.getByRole('dialog', {name: 'Choose from Drive', exact: true})
	await expect(picker).toBeVisible()
	await picker.locator('.drive-card').filter({hasText: 'background-from-drive.png'})
		.getByRole('button', {name: 'Choose from Drive', exact: true}).click()
	await expect(picker).toBeHidden()
	const focusImage = background.locator('.compass-focus__image')
	await expect(focusImage).toBeVisible()
	await expect.poll(() => focusImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
	const focus = background.locator('.compass-focus__frame')
	await focus.focus()
	await page.keyboard.press('Home')
	await page.keyboard.press('ArrowRight')
	await expect(focus).toHaveAttribute('aria-label', 'Focal point: 55% across, 50% down')
	const save = page.locator('.compass-settings-form').getByRole('button', {name: 'Save', exact: true})
	const status = page.locator('.compass-settings-form__status')
	async function saveSettings() {
		await expect(save).not.toHaveAttribute('aria-disabled', 'true')
		const written = page.waitForResponse(response => response.request().method() === 'PUT'
			&& new URL(response.url()).pathname === `/api/v2/compass/spaces/${space.id}`)
		await save.click()
		expect((await written).status()).toBe(200)
		await expect(status).toContainText('Saved')
		await expect(save).toHaveAttribute('aria-disabled', 'true')
	}
	await saveSettings()
	expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
		background_file_id: fileId,
		background_focus_x: 55,
		background_focus_y: 50,
		theme: 'nebula',
	})
	// Reopening must populate the form from the saved server state, including its focal point.
	await page.reload()
	await expect(focusImage).toBeVisible()
	await expect(focus).toHaveAttribute('aria-label', 'Focal point: 55% across, 50% down')
	await page.screenshot({path: testInfo.outputPath('phone-background-settings-saved.png'), fullPage: true})
	await background.getByRole('button', {name: 'Back to the theme sky', exact: true}).click()
	await expect(focusImage).toHaveCount(0)
	await saveSettings()
	expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({background_file_id: 0, theme: 'nebula'})
	await page.reload()
	await expect(background).toBeVisible()
	await expect(background.getByRole('button', {name: 'Back to the theme sky', exact: true})).toHaveCount(0)
	await expect(focusImage).toHaveCount(0)
	await expect(page.locator('.compass-settings-form')).toHaveAttribute('data-compass-theme', 'nebula')
	const download = await apiContext.get(`${COMPASS_API}/drive/files/${fileId}/download`, {headers})
	expect(download.status()).toBe(200)
	expect(await download.body()).toEqual(bytes)
	await page.screenshot({path: testInfo.outputPath('phone-background-settings-cleared.png'), fullPage: true})
})
