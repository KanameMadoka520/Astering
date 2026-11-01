import {readFile} from 'node:fs/promises'
import type {Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {login} from '../../support/authenticateUser'
import {UserFactory} from '../../factories/user'

type NetworkRecord = {
	path?: string
	method?: string
	status?: number
	ifNoneMatch?: string
	etag?: string
}

function header(headers: Record<string, string>, name: string) {
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
}

async function browserRead(page: Page, url: string, token: string) {
	return page.evaluate(async ({url, token}) => {
		const response = await fetch(url, {
			credentials: 'include',
			headers: {Authorization: `Bearer ${token}`},
		})
		const blob = await response.blob()
		return {
			status: response.status,
			cacheControl: response.headers.get('Cache-Control'),
			isImage: blob.type.startsWith('image/'),
		}
	}, {url, token})
}

test('browser revalidates private image bytes after UI reload and refuses cached bytes without access', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
}) => {
	test.setTimeout(90_000)
	const api = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
	const fileName = 'private-browser-cache.png'
	const bytes = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const upload = await apiContext.post(`${api}/drive/files`, {
		headers: {Authorization: `Bearer ${userToken}`},
		multipart: {file: {
			name: fileName,
			mimeType: 'image/png',
			buffer: bytes,
		}},
	})
	expect(upload.ok()).toBe(true)
	const file = await upload.json() as {
		file_id: number
		revision: number
	}
	const imagePath = `/api/v2/drive/files/${file.file_id}/preview`
	const imageUrl = `${api}/drive/files/${file.file_id}/preview`
	const requests = new Map<string, NetworkRecord>()
	function record(id: string) {
		let entry = requests.get(id)
		if (!entry) {
			entry = {}
			requests.set(id, entry)
		}
		return entry
	}
	function imageRequests() {
		return [...requests.values()].filter(entry => entry.path === imagePath && entry.method === 'GET')
	}
	const cdp = await page.context().newCDPSession(page)
	try {
		await cdp.send('Network.enable')
		// Request interception disables Chromium's HTTP cache, so this spec deliberately never uses page.route.
		await cdp.send('Network.setCacheDisabled', {cacheDisabled: false})
		cdp.on('Network.requestWillBeSent', event => {
			Object.assign(record(event.requestId), {
				path: new URL(event.request.url).pathname,
				method: event.request.method,
			})
		})
		cdp.on('Network.requestWillBeSentExtraInfo', event => {
			// Retain only the validator; authorization headers must not enter assertion diagnostics.
			record(event.requestId).ifNoneMatch = header(event.headers, 'if-none-match')
		})
		cdp.on('Network.responseReceivedExtraInfo', event => {
			Object.assign(record(event.requestId), {
				status: event.statusCode,
				etag: header(event.headers, 'etag'),
			})
		})
		await page.goto('/drive')
		const thumbnail = page.locator('.drive-card').filter({hasText: fileName}).locator('img')
		async function expectDecodedThumbnail() {
			await expect(thumbnail).toBeVisible()
			await expect(thumbnail).toHaveAttribute('src', /^blob:/)
			await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) =>
				image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
			)).toBe(true)
		}
		await expectDecodedThumbnail()
		await expect.poll(() => imageRequests().some(entry => entry.status === 200 && Boolean(entry.etag))).toBe(true)
		const etag = imageRequests().find(entry => entry.status === 200)!.etag!

		// A full reload drops the QueryClient's Blob cache. Only the browser's HTTP cache can supply these bytes.
		await page.reload()
		await expectDecodedThumbnail()
		await expect.poll(() => imageRequests().some(entry =>
			entry.status === 304 && entry.ifNoneMatch === etag,
		)).toBe(true)

		const ownerToken = await page.evaluate(() => localStorage.getItem('token'))
		expect(ownerToken).not.toBeNull()
		// Ordinary JSON stays non-cacheable even though media requests now permit HTTP revalidation.
		for (let read = 0; read < 2; read++) {
			const metadata = await browserRead(page, `${api}/user`, ownerToken!)
			expect(metadata.status).toBe(200)
			expect(metadata.cacheControl).toContain('no-store')
			expect(metadata.isImage).toBe(false)
		}

		const [other] = await UserFactory.create(1, {
			id: 2,
			username: 'browser-cache-other',
		}, false)
		const {token: otherToken} = await login(null, apiContext, other)
		// Use the SAME browser context and URL: a fresh context would never encounter the owner's cached image.
		expect(await browserRead(page, imageUrl, otherToken)).toMatchObject({
			status: 404,
			isImage: false,
		})

		const recycled = await apiContext.put(`${api}/drive/files/${file.file_id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
			data: {
				action: 'trash',
				revision: file.revision,
			},
		})
		expect(recycled.ok()).toBe(true)
		const {revision} = await recycled.json() as {revision: number}
		const purged = await apiContext.put(`${api}/drive/files/${file.file_id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
			data: {
				action: 'purge',
				revision,
				confirm: true,
				confirm_name: fileName,
			},
		})
		expect(purged.ok()).toBe(true)
		// Even the original identity must recheck existence instead of getting its now-deleted cached image.
		expect(await browserRead(page, imageUrl, ownerToken!)).toMatchObject({
			status: 404,
			isImage: false,
		})
		await page.reload()
		await expect(page.locator('.drive-card')).toHaveCount(0)
	} finally {
		await cdp.detach()
	}
})
