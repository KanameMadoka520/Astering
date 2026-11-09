import {
	test,
	expect,
} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'
for (const width of [1440, 390]) {
	test(`captured transcript dates and idempotent article append preserve local drafts at ${width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		await page.setViewportSize({
			width,
			height: 900,
		})
		await updateUserSettings(apiContext, userToken, {
			language: 'en',
			frontend_settings: {live_notes_timezone: 'Asia/Shanghai'},
		})
		const headers = {Authorization: `Bearer ${userToken}`}
		const createdResponse = await apiContext.post('/api/v2/notes', {
			headers,
			data: {
				title: 'Capture clock',
				content: 'Manual introduction',
			},
		})
		expect(createdResponse.ok()).toBe(true)
		const note = await createdResponse.json()
		const legacy = await apiContext.post(`/api/v2/notes/${note.id}/segments`, {
			headers,
			data: {
				client_id: crypto.randomUUID(),
				text: 'Legacy date is unknown',
				start_ms: 0,
				end_ms: 2000,
			},
		})
		expect(legacy.ok()).toBe(true)
		const input = {
			client_id: crypto.randomUUID(),
			text: 'A captured thought',
			start_ms: 1000,
			end_ms: 3000,
			recording_offset_ms: 1000,
			recording_id: crypto.randomUUID(),
			recording_started_at: '2026-11-09T07:08:09.123Z',
			timezone: 'Asia/Shanghai',
			append_to_article: true,
		}
		const post = () => apiContext.post(`/api/v2/notes/${note.id}/segments/import`, {
			headers,
			data: input,
		})
		const first = await post()
		expect(first.ok(), await first.text()).toBe(true)
		const committed = await first.json()
		expect(committed.segment.captured_at).toBe('2026-11-09T07:08:10.123Z')
		expect(committed.segment.start_ms).toBe(3000)
		const retry = await post()
		expect((await retry.json()).segment.id).toBe(committed.segment.id)
		await page.goto(`/notes/${note.id}`)
		const article = page.getByRole('textbox', {
			name: 'Article in Markdown',
			exact: true,
		})
		await expect(article).toBeVisible()
		await expect(article).toHaveValue(/Manual introduction[\s\S]*15:08:10[\s\S]*A captured thought/)
		if (width < 901) await page.getByRole('tab', {name: /^Raw transcript/}).click()
		await expect(page.locator('.note-transcript__meta')).toContainText(['Recording date unknown', '15:08:10'])
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({
			path: info.outputPath(`note-capture-clock-${width}.png`),
			fullPage: true,
			animations: 'disabled',
		})
		if (width < 901) await page.getByRole('tab', {
			name: 'Article',
			exact: true,
		}).click()
		await article.fill('A personal draft must not be overwritten')
		const next = await apiContext.post(`/api/v2/notes/${note.id}/segments/import`, {
			headers,
			data: {
				...input,
				client_id: crypto.randomUUID(),
				text: 'Another captured thought',
				recording_offset_ms: 4000,
				start_ms: 4000,
				end_ms: 5000,
			},
		})
		expect(next.ok()).toBe(true)
		await page.locator('.note-editor__actions').getByRole('button', {
			name: 'Save',
			exact: true,
		}).click()
		await expect(page.getByText('Newer version available', {exact: true})).toBeVisible()
		await expect(article).toHaveValue('A personal draft must not be overwritten')
		await page.getByRole('button', {
			name: 'Review server version',
			exact: true,
		}).click()
		await expect(page.getByRole('dialog')).toContainText('Another captured thought')
		await expect(page.getByRole('dialog')).toContainText('A personal draft must not be overwritten')
	})
}
