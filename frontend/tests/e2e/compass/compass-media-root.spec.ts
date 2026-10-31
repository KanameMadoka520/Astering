import {readFile} from 'node:fs/promises'
import type {APIRequestContext, APIResponse, Locator, Page, TestInfo} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {
	COMPASS_API,
	createCompassEntry,
	createCompassSpace,
	readCompassEntry,
	readCompassSpace,
	updateCompassEntry,
} from './compassApi'

type DriveUsage = {kind: string, title: string, url: string, restricted: boolean}

async function responseJson<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true)
	return response.json() as Promise<T>
}

async function uploadPNG(request: APIRequestContext, token: string) {
	const bytes = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const uploaded = await responseJson<{file_id: number}>(await request.post(`${COMPASS_API}/drive/files`, {
		headers: {Authorization: `Bearer ${token}`},
		multipart: {file: {name: 'compass-media-regression.png', mimeType: 'image/png', buffer: bytes}},
	}))
	expect(uploaded.file_id).toBeGreaterThan(0)
	return {id: uploaded.file_id, bytes}
}

async function usages(request: APIRequestContext, token: string, fileId: number) {
	return responseJson<DriveUsage[]>(await request.get(`${COMPASS_API}/drive/files/${fileId}/usages`, {
		headers: {Authorization: `Bearer ${token}`},
	}))
}

async function expectLoadedImage(image: Locator) {
	await expect(image).toBeVisible()
	await expect(image).toHaveAttribute('src', /^blob:/)
	// A visible element or successful metadata request alone does not prove its bytes decoded.
	await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
		element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
	)).toBe(true)
}

async function captureWithoutOverflow(page: Page, testInfo: TestInfo, name: string) {
	await expect.poll(() => page.evaluate(() =>
		Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
	)).toBeLessThanOrEqual(1)
	await page.screenshot({path: testInfo.outputPath(`${name}.png`), fullPage: true})
}

test.describe('Compass media API and reader integration', () => {
	test('retains readable historical images and Drive references after removing the current image', async ({
		authenticatedPage: page, apiContext, userToken,
	}, testInfo) => {
		test.setTimeout(120_000)
		await page.emulateMedia({reducedMotion: 'reduce'})
		const errors: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		const file = await uploadPNG(apiContext, userToken)
		const space = await createCompassSpace(apiContext, userToken, {title: 'Pictures worth remembering'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'An illustrated memory',
			kind: 'memory',
			// Deliberately wider than a phone: rendering must constrain the stored image dimensions.
			content: `<p>Keep this picture with the original memory.</p><img data-compass-image="${file.id}" alt="Blue memory" title="Original illustration" width="1600" height="900">`,
		})
		const stored = await readCompassEntry(apiContext, userToken, entry.id)
		expect(stored.content).toContain(`data-compass-image="${file.id}"`)
		expect(stored.content).not.toMatch(/\bsrc(?:set)?=/)
		expect(await usages(apiContext, userToken, file.id)).toEqual(expect.arrayContaining([
			expect.objectContaining({kind: 'compass_entry', url: `/compass/entries/${entry.id}`, restricted: false}),
		]))

		for (const width of [1280, 390]) {
			await page.setViewportSize({width, height: 900})
			await page.goto(`/compass/entries/${entry.id}`)
			await expect(page.getByRole('heading', {level: 1, name: entry.title, exact: true})).toBeVisible()
			const image = page.locator(`.compass-reader__body img[data-compass-image="${file.id}"]`)
			await expectLoadedImage(image)
			await expect(image).toHaveAttribute('alt', 'Blue memory')
			await captureWithoutOverflow(page, testInfo, `current-image-${width}`)
		}

		const updated = await updateCompassEntry(apiContext, userToken, entry.id, {
			content: '<p>The current entry no longer contains the illustration.</p>',
		})
		expect(updated.revision).toBeGreaterThan(entry.revision)
		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.getByText('The current entry no longer contains the illustration.', {exact: true})).toBeVisible()
		await expect(page.locator('.compass-reader__body img[data-compass-image]')).toHaveCount(0)
		const references = await usages(apiContext, userToken, file.id)
		expect(references).toEqual(expect.arrayContaining([
			expect.objectContaining({kind: 'compass_history', url: `/compass/entries/${entry.id}/history`, restricted: false}),
		]))
		expect(references.some(reference => reference.kind === 'compass_entry')).toBe(false)
		const imageResponse = await apiContext.get(`${COMPASS_API}/compass/spaces/${space.id}/images/${file.id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(imageResponse.status()).toBe(200)
		expect(imageResponse.headers()['content-type']).toContain('image/png')
		expect(await imageResponse.body()).toEqual(file.bytes)

		for (const width of [1280, 390]) {
			await page.setViewportSize({width, height: 900})
			await page.goto(`/compass/entries/${entry.id}/history?revision=${entry.revision}`)
			const historical = page.getByRole('region', {name: `Version ${entry.revision}`, exact: true})
			await expectLoadedImage(historical.locator(`img[data-compass-image="${file.id}"]`))
			await expect(historical.getByText('Keep this picture with the original memory.', {exact: true})).toBeVisible()
			await captureWithoutOverflow(page, testInfo, `historical-image-${width}`)
		}
		expect(errors).toEqual([])
	})

	test('persists a space photograph and restores the chosen theme when it is cleared', async ({
		authenticatedPage: page, apiContext, userToken,
	}, testInfo) => {
		test.setTimeout(120_000)
		await page.emulateMedia({reducedMotion: 'reduce'})
		const file = await uploadPNG(apiContext, userToken)
		const space = await createCompassSpace(apiContext, userToken, {title: 'My photographic sky', theme: 'solar'})
		async function saveBackground(fileId: number) {
			const latest = await readCompassSpace(apiContext, userToken, space.id)
			return responseJson<{background_file_id: number, theme: string}>(await apiContext.put(`${COMPASS_API}/compass/spaces/${space.id}`, {
				headers: {Authorization: `Bearer ${userToken}`},
				data: {
					title: latest.title,
					motto: latest.motto ?? '',
					introduction: latest.introduction ?? '',
					theme: latest.theme,
					revision: latest.revision,
					background_file_id: fileId,
					background_focus_x: 25,
					background_focus_y: 75,
					background_scrim: 'strong',
				},
			}))
		}
		expect((await saveBackground(file.id)).background_file_id).toBe(file.id)
		expect(await usages(apiContext, userToken, file.id)).toEqual(expect.arrayContaining([
			expect.objectContaining({kind: 'compass_background', url: `/compass/spaces/${space.id}/settings`}),
		]))
		for (const width of [1280, 390]) {
			await page.setViewportSize({width, height: 900})
			await page.goto(`/compass/spaces/${space.id}`)
			await expectLoadedImage(page.locator('.compass-sky-header .compass-backdrop__image'))
			// Reload forces image retrieval from persisted server state instead of an editor preview.
			await page.reload()
			const image = page.locator('.compass-sky-header .compass-backdrop__image')
			await expectLoadedImage(image)
			await expect(image).toHaveCSS('object-position', '25% 75%')
			await expect(page.locator('.compass-sky-header .compass-backdrop')).toHaveAttribute('data-scrim', 'strong')
			await captureWithoutOverflow(page, testInfo, `space-background-${width}`)
		}
		expect(await saveBackground(0)).toMatchObject({background_file_id: 0, theme: 'solar'})
		for (const width of [1280, 390]) {
			await page.setViewportSize({width, height: 900})
			await page.goto(`/compass/spaces/${space.id}`)
			await expect(page.getByRole('heading', {level: 1, name: space.title, exact: true})).toBeVisible()
			await expect(page.locator('.compass-sky-header .compass-backdrop')).toHaveCount(0)
			await expect(page.locator('.compass-sky-header .compass-sky')).toBeVisible()
			await expect(page.locator('.compass-space')).toHaveAttribute('data-compass-theme', 'solar')
			await captureWithoutOverflow(page, testInfo, `space-theme-restored-${width}`)
		}
		expect((await usages(apiContext, userToken, file.id)).some(reference => reference.kind === 'compass_background')).toBe(false)
		// Clearing a backdrop must not delete the reusable Drive file.
		const download = await apiContext.get(`${COMPASS_API}/drive/files/${file.id}/download`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(download.status()).toBe(200)
		expect(await download.body()).toEqual(file.bytes)
	})
})
