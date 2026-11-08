import {test, expect} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'
import {UserFactory} from '../../factories/user'
import {login} from '../../support/authenticateUser'

test.beforeEach(async ({apiContext, userToken}) => {
	// Account templates are file-backed outside SQL fixtures; start the handoff test with the real default.
	const headers = {Authorization: `Bearer ${userToken}`}
	const current = await apiContext.get('/api/v2/ai/preferences', {headers})
	expect(current.ok()).toBe(true)
	const saved = await apiContext.post('/api/v2/ai/preferences', {headers, data: {revision: (await current.json()).revision ?? 0, default_profile: 'ask', profiles: []}})
	expect(saved.ok()).toBe(true)
})

for (const viewport of [
	{width: 1440, height: 1000, language: 'en'},
	{width: 390, height: 844, language: 'zh-CN'},
]) {
	test(`personal note article and selected transcript persist at ${viewport.width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		const zh = viewport.language === 'zh-CN'
		const labels = zh ? {
			new: '新建笔记', title: '笔记标题', article: 'Markdown 文章正文', save: '保存',
			saved: '已保存', raw: '原始转录', select: '选择本页', arona: '交给阿罗娜',
			open: '打开聊天草稿', draft: '选中的原文', export: '导出 Markdown',
		} : {
			new: 'New note', title: 'Note title', article: 'Article in Markdown', save: 'Save',
			saved: 'Saved', raw: 'Raw transcript', select: 'Select this page', arona: 'Work with Arona',
			open: 'Open chat draft', draft: 'Selected source text', export: 'Export Markdown',
		}
		await page.goto('/notes')
		const creation = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === '/api/v2/notes')
		await page.locator('.notes-page__header').getByRole('button', {name: labels.new, exact: true}).click()
		const created = await (await creation).json()
		await expect(page).toHaveURL(new RegExp(`/notes/${created.id}$`))
		const title = `Research notes ${viewport.width} — 保留灵感与完整的长标题`
		await page.getByRole('textbox', {name: labels.title, exact: true}).fill(title)
		await page.getByRole('textbox', {name: labels.article, exact: true}).fill('## Decisions\n\nKeep the original transcript separately.')
		const saving = page.waitForResponse(response => response.request().method() === 'PUT'
			&& new URL(response.url()).pathname === `/api/v2/notes/${created.id}`)
		await page.locator('.note-editor__actions').getByRole('button', {name: labels.save, exact: true}).click()
		expect((await saving).ok()).toBe(true)
		await expect(page.locator('.note-editor__status')).toHaveText(labels.saved)
		const storedResponse = await apiContext.get(`/api/v2/notes/${created.id}`, {headers: {Authorization: `Bearer ${userToken}`}})
		expect(storedResponse.ok()).toBe(true)
		const stored = await storedResponse.json()
		expect(stored.content).toBe('## Decisions\n\nKeep the original transcript separately.')
		const rawText = 'Discuss the first experiment next Tuesday. Keep the original wording.'
		const append = await apiContext.post(`/api/v2/notes/${created.id}/segments`, {
			headers: {Authorization: `Bearer ${userToken}`},
			data: {client_id: crypto.randomUUID(), text: rawText, start_ms: 0, end_ms: 6000},
		})
		expect(append.ok(), await append.text()).toBe(true)
		await page.reload()
		await expect(page.getByRole('textbox', {name: labels.title, exact: true})).toHaveValue(title)
		await expect(page.getByRole('textbox', {name: labels.article, exact: true})).toHaveValue(stored.content)
		const downloadPromise = page.waitForEvent('download')
		await page.getByRole('button', {name: labels.export, exact: true}).click()
		const download = await downloadPromise
		expect(download.suggestedFilename()).toMatch(/\.md$/)
		if (viewport.width < 901) await page.getByRole('tab', {name: new RegExp(`^${labels.raw}`)}).click()
		await expect(page.locator('.note-transcript__content p')).toHaveText(rawText)
		await page.getByRole('button', {name: labels.select, exact: true}).click()
		await page.getByRole('button', {name: labels.arona, exact: true}).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog.getByRole('textbox', {name: labels.draft})).toHaveValue(`[00:00–00:06] ${rawText}`)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`notes-transcript-handoff-${viewport.width}.png`), animations: 'disabled'})
		let sends = 0
		page.on('request', request => {
			if (request.method() === 'POST' && /\/conversations\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) sends++
		})
		await dialog.getByRole('button', {name: labels.open, exact: true}).click()
		await expect(page).toHaveURL(/\/ai\?notesDraft=/)
		await expect.poll(() => page.locator('textarea[data-tour="ai-prompt"]').inputValue()).toContain(rawText)
		await expect.poll(() => page.locator('textarea[data-tour="ai-prompt"]').inputValue()).toContain(`/notes/${created.id}`)
		await expect.poll(() => page.locator('textarea[data-tour="ai-prompt"]').inputValue()).toContain(`#${created.id}`)
		await page.locator('.configuration-toggle:visible').click()
		await page.getByRole('button', {name: zh ? '工具能力范围' : 'Tool capabilities', exact: true}).click()
		await expect(page.locator('.tool-module-picker').getByRole('combobox', {name: zh ? '个人笔记' : 'Personal notes', exact: true})).toHaveValue('off')
		await page.keyboard.press('Escape')
		expect(sends).toBe(0)
		const reread = await apiContext.get(`/api/v2/notes/${created.id}`, {headers: {Authorization: `Bearer ${userToken}`}})
		const unchanged = await reread.json()
		expect(unchanged.content).toBe(stored.content)
		expect(unchanged.revision).toBe(stored.revision)
		expect(unchanged.segment_count).toBe(1)
	})
}

test('a note conflict keeps the local text until an explicit version choice and save', async ({authenticatedPage: page, apiContext, userToken}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const createdResponse = await apiContext.post('/api/v2/notes', {headers, data: {title: 'Concurrent note', content: 'Version one'}})
	const created = await createdResponse.json()
	await page.goto(`/notes/${created.id}`)
	const body = page.getByRole('textbox', {name: 'Article in Markdown', exact: true})
	await expect(body).toHaveValue('Version one')
	const server = await apiContext.put(`/api/v2/notes/${created.id}`, {
		headers,
		data: {title: 'Concurrent note', content: 'Saved elsewhere', pinned: false, expected_revision: created.revision},
	})
	expect(server.ok()).toBe(true)
	await body.fill('My unsaved local text')
	await page.locator('.note-editor__actions').getByRole('button', {name: 'Save', exact: true}).click()
	await expect(page.getByText('Newer version available', {exact: true})).toBeVisible()
	await expect(body).toHaveValue('My unsaved local text')
	await page.getByRole('button', {name: 'Review server version', exact: true}).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('Saved elsewhere')
	await expect(dialog).toContainText('My unsaved local text')
	await dialog.getByRole('button', {name: 'Keep my draft', exact: true}).click()
	await expect(body).toHaveValue('My unsaved local text')
	await page.locator('.note-editor__actions').getByRole('button', {name: 'Save', exact: true}).click()
	await expect(page.locator('.note-editor__status')).toHaveText('Saved')
	await page.reload()
	await expect(body).toHaveValue('My unsaved local text')
	const latest = await apiContext.get(`/api/v2/notes/${created.id}`, {headers})
	expect((await latest.json()).revision).toBe(created.revision + 2)
})

test('an unrelated account cannot see another person’s note or transcript', async ({authenticatedPage: page, apiContext}) => {
	const [other] = await UserFactory.create(1, {id: 2, username: 'notes-other-owner'}, false)
	const {token} = await login(null, apiContext, other)
	const createdResponse = await apiContext.post('/api/v2/notes', {
		headers: {Authorization: `Bearer ${token}`},
		data: {title: 'Other account private title', content: 'Private article must not appear'},
	})
	const created = await createdResponse.json()
	await page.goto(`/notes/${created.id}`)
	await expect(page.getByText('This note was deleted or is no longer accessible.', {exact: true})).toBeVisible()
	await expect(page.getByRole('textbox', {name: 'Note title', exact: true})).toHaveCount(0)
	await expect(page.getByText('Other account private title', {exact: true})).toHaveCount(0)
	await expect(page.getByText('Private article must not appear', {exact: true})).toHaveCount(0)
})
