import {test, expect} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'

test.beforeEach(async ({apiContext, userToken}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	// This account-owned encrypted store intentionally survives SQL fixture resets.
	const response = await apiContext.get('/api/v2/ai/automations', {headers})
	expect(response.ok(), await response.text()).toBe(true)
	for (const item of (await response.json()).items) {
		const deleted = await apiContext.delete(`/api/v2/ai/automations/${item.id}`, {
			headers,
			data: {expected_revision: item.revision},
		})
		expect(deleted.ok(), await deleted.text()).toBe(true)
	}
})

for (const viewport of [
	{width: 1440, height: 1000, language: 'en'},
	{width: 390, height: 844, language: 'zh-CN'},
	{width: 320, height: 740, language: 'en'},
]) {
	test(`reminder CRUD, actual delivery and persisted schedule at ${viewport.width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		const zh = viewport.language === 'zh-CN'
		const labels = zh ? {
			create: '新建自动化', name: '名称', kind: '执行内容', prompt: '提醒内容',
			save: '保存', run: '立即运行', pause: '暂停', resume: '恢复', edit: '编辑', remove: '删除',
			completed: '已完成', frequency: '重复方式', timezone: '计划使用的时区',
		} : {
			create: 'New automation', name: 'Name', kind: 'What should run?', prompt: 'Reminder message',
			save: 'Save', run: 'Run now', pause: 'Pause', resume: 'Resume', edit: 'Edit', remove: 'Delete',
			completed: 'Completed', frequency: 'Repeat', timezone: 'Schedule timezone',
		}
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		await page.goto('/automations')
		await page.getByRole('button', {name: labels.create, exact: true}).click()
		const editor = page.locator('.automation-editor')
		await editor.getByLabel(labels.kind, {exact: true}).selectOption('reminder')
		const title = `Persistent reminder ${viewport.width} · 记录与安排`
		await editor.getByLabel(labels.name, {exact: true}).fill(title)
		await editor.getByLabel(labels.prompt, {exact: true}).fill('A reminder that must be saved and delivered exactly once.')
		await editor.getByLabel(labels.frequency, {exact: true}).selectOption('weekly')
		await editor.getByLabel(labels.timezone, {exact: true}).fill('Asia/Shanghai')
		await expect(editor.getByRole('checkbox', {name: zh ? '周一' : 'Mon', exact: true})).toBeChecked()
		await editor.getByRole('checkbox', {name: zh ? '周五' : 'Fri', exact: true}).check()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`automation-editor-${viewport.width}.png`), animations: 'disabled'})
		const creation = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === '/api/v2/ai/automations')
		await editor.getByRole('button', {name: labels.save, exact: true}).click()
		const createdResponse = await creation
		expect(createdResponse.ok(), await createdResponse.text()).toBe(true)
		const created = await createdResponse.json()
		await expect(page).toHaveURL(new RegExp(`/automations/${created.id}$`))
		await expect(editor).not.toBeVisible()
		await expect(page.locator('.automation-detail h2')).toHaveText(title)
		const headers = {Authorization: `Bearer ${userToken}`}
		const read = async () => {
			const response = await apiContext.get(`/api/v2/ai/automations/${created.id}`, {headers})
			expect(response.ok()).toBe(true)
			return response.json()
		}
		const stored = await read()
		expect(stored.timezone).toBe('Asia/Shanghai')
		expect(stored.schedule.weekdays).toEqual([1, 5])
		expect(stored.kind).toBe('reminder')
		await page.reload()
		await expect(page.locator('.automation-detail h2')).toHaveText(title)
		await page.getByRole('button', {name: labels.run, exact: true}).click()
		await expect(page.locator('.automation-run').first()).toContainText(labels.completed, {timeout: 20_000})
		const runs = await apiContext.get(`/api/v2/ai/automations/${created.id}/runs`, {headers})
		const items = (await runs.json()).items
		expect(items).toHaveLength(1)
		expect(items[0].status).toBe('succeeded')
		expect(items[0].conversation_id).toBe('')
		const notices = await apiContext.get('/api/v2/notifications', {headers})
		expect(notices.ok(), await notices.text()).toBe(true)
		const notice = (await notices.json()).items.find((item: {name?: string, notification?: {automation_id?: string}}) => item.name === 'ai.automation' && item.notification?.automation_id === created.id)
		expect(notice?.notification.message).toBe(stored.prompt)
		await page.getByRole('button', {name: labels.pause, exact: true}).click()
		await expect(page.getByRole('button', {name: labels.resume, exact: true})).toBeVisible()
		expect((await read()).enabled).toBe(false)
		await page.getByRole('button', {name: labels.edit, exact: true}).click()
		await editor.getByLabel(labels.name, {exact: true}).fill(`${title} updated`)
		await editor.getByRole('button', {name: labels.save, exact: true}).click()
		await expect(editor).not.toBeVisible()
		await page.reload()
		await expect(page.locator('.automation-detail h2')).toHaveText(`${title} updated`)
		expect((await read()).prompt).toBe(stored.prompt)
		expect((await read()).enabled).toBe(false)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`automation-history-${viewport.width}.png`), animations: 'disabled'})
		await page.locator('.automation-detail__actions').getByRole('button', {name: labels.remove, exact: true}).click()
		await page.locator('dialog[open] .actions').getByRole('button', {name: labels.remove, exact: true}).click()
		await expect(page).toHaveURL(/\/automations$/)
		expect((await apiContext.get(`/api/v2/ai/automations/${created.id}`, {headers})).status()).toBe(404)
	})
}

test('a due reminder runs while its page is closed, and manual retry keys are idempotent', async ({authenticatedPage: page, apiContext, userToken}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const response = await apiContext.post('/api/v2/ai/automations', {
		headers,
		data: {
			title: 'Background deadline',
			prompt: 'A server-side reminder without a model.',
			kind: 'reminder',
			enabled: true,
			timezone: 'Asia/Shanghai',
			schedule: {kind: 'once', at: new Date(Date.now() + 3000).toISOString()},
			max_runtime_seconds: 60,
			notify_on_success: true,
			notify_on_failure: true,
		},
	})
	expect(response.ok(), await response.text()).toBe(true)
	const item = await response.json()
	await page.goto('/notes')
	await expect.poll(async () => {
		const runs = await apiContext.get(`/api/v2/ai/automations/${item.id}/runs`, {headers})
		return (await runs.json()).items[0]?.status
	}, {timeout: 30_000}).toBe('succeeded')
	const request_id = crypto.randomUUID()
	const first = await apiContext.post(`/api/v2/ai/automations/${item.id}/run`, {headers, data: {request_id}})
	expect(first.ok(), await first.text()).toBe(true)
	const firstRun = await first.json()
	await expect.poll(async () => {
		const runs = await apiContext.get(`/api/v2/ai/automations/${item.id}/runs`, {headers})
		return (await runs.json()).items.find((run: {id: string}) => run.id === firstRun.id)?.status
	}).toBe('succeeded')
	const retry = await apiContext.post(`/api/v2/ai/automations/${item.id}/run`, {headers, data: {request_id}})
	expect(retry.ok(), await retry.text()).toBe(true)
	expect((await retry.json()).id).toBe(firstRun.id)
	const runs = await apiContext.get(`/api/v2/ai/automations/${item.id}/runs`, {headers})
	expect((await runs.json()).items).toHaveLength(2)
	await page.goto(`/automations/${item.id}`)
	await expect(page.locator('.automation-run')).toHaveCount(2)
	const latest = await (await apiContext.get(`/api/v2/ai/automations/${item.id}`, {headers})).json()
	expect((await apiContext.delete(`/api/v2/ai/automations/${item.id}`, {headers, data: {expected_revision: latest.revision}})).ok()).toBe(true)
})
