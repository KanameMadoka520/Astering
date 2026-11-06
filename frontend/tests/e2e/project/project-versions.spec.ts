import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import type {
	APIRequestContext,
	Page,
} from '@playwright/test'
import {
	test,
	expect,
} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {updateUserSettings} from '../../support/updateUserSettings'
import {login} from '../../support/authenticateUser'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {UserFactory} from '../../factories/user'
import {UserProjectFactory} from '../../factories/users_project'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {createDefaultViews} from './prepareProjects'

const api = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
const headers = (token: string) => ({Authorization: `Bearer ${token}`})

async function seed(owner = 1, archived = false) {
	await ProjectFactory.create(1, {
		id: 1,
		title: 'Research project',
		owner_id: owner,
		is_archived: archived,
	})
	await createDefaultViews(1, 1)
	await TaskFactory.create(1, {
		id: 1,
		title: 'Saved task',
		description: '<p>Saved description <strong>with detail</strong></p>',
		project_id: 1,
		due_date: '2027-01-15T09:00:00Z',
	})
	await BucketFactory.create(1, {
		id: 1,
		title: 'Saved bucket',
		project_view_id: 4,
	})
	await TaskBucketFactory.create(1, {
		task_id: 1,
		bucket_id: 1,
		project_view_id: 4,
	})
}

async function checkpoint(request: APIRequestContext, token: string, name = 'Before launch') {
	const response = await request.post(`${api}/projects/1/versions`, {
		headers: headers(token),
		data: {
			name,
			request_id: randomUUID(),
		},
	})
	expect(response.ok(), await response.text()).toBe(true)
	return response.json()
}

async function patchTask(request: APIRequestContext, token: string, title: string) {
	const response = await request.patch(`${api}/tasks/1`, {
		headers: {
			...headers(token),
			'Content-Type': 'application/json-patch+json',
		},
		data: [
			{
				op: 'replace',
				path: '/title',
				value: title,
			},
			{
				op: 'replace',
				path: '/description',
				value: '<p>Current description after the checkpoint</p>',
			},
			{
				op: 'replace',
				path: '/due_date',
				value: '2027-06-20T10:00:00Z',
			},
		],
	})
	expect(response.ok(), await response.text()).toBe(true)
}

async function readVersions(request: APIRequestContext, token: string) {
	const response = await request.get(`${api}/projects/1/versions`, {headers: headers(token)})
	expect(response.ok()).toBe(true)
	return response.json()
}

async function noOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const width of [1440, 390]) {
	test(`named project versions inspect actual content and restore stored tasks, views and attachments at ${width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, testInfo) => {
		test.setTimeout(90_000)
		await seed()
		const chinese = width === 390
		if (chinese) await updateUserSettings(apiContext, userToken, {language: 'zh-CN'})
		await page.setViewportSize({
			width,
			height: 900,
		})
		const comments = `${api}/tasks/1/comments`
		expect((await apiContext.post(comments, {
			headers: headers(userToken),
			data: {comment: '<p>Before checkpoint</p>'},
		})).ok()).toBe(true)
		const upload = await apiContext.post(`${api}/tasks/1/attachments`, {
			headers: headers(userToken),
			multipart: {
				files: {
					name: 'retained.png',
					mimeType: 'image/png',
					buffer: readFileSync(new URL('../../fixtures/image-blue.png', import.meta.url)),
				},
			},
		})
		expect(upload.ok(), await upload.text()).toBe(true)
		const attachments = await upload.json()
		expect(attachments.success, `Attachment upload result: ${JSON.stringify(attachments)}`).toHaveLength(1)
		const attachment = attachments.success[0]
		expect((await apiContext.patch(`${api}/tasks/1`, {
			headers: {
				...headers(userToken),
				'Content-Type': 'application/json-patch+json',
			},
			data: [{
				op: 'replace',
				path: '/description',
				value: `<p>Saved description <strong>with detail</strong></p><img src="/api/v2/tasks/1/attachments/${attachment.id}" alt="Saved image">`,
			}],
		})).ok()).toBe(true)
		await page.goto('/projects/1/1')
		await page.locator('header.navbar').getByRole('button', {name: chinese ? '打开项目设置菜单' : 'Open project settings menu'}).click()
		await page.getByRole('link', {
			name: chinese ? '项目历史版本' : 'Project versions',
			exact: true,
		}).click()
		await expect(page).toHaveURL(/\/projects\/1\/versions$/)
		await page.getByTestId('version-save').click()
		let dialog = page.getByRole('dialog', {
			name: chinese ? '保存版本' : 'Save checkpoint',
			exact: true,
		})
		await dialog.getByLabel(chinese ? '保存点名称' : 'Checkpoint name', {exact: true}).fill('Before launch')
		await dialog.getByRole('button', {
			name: chinese ? '保存版本' : 'Save checkpoint',
			exact: true,
		}).click()
		await expect(dialog).toBeHidden()
		const saved = (await readVersions(apiContext, userToken)).items[0]
		expect(saved.name).toBe('Before launch')
		expect(saved.task_count).toBe(1)
		expect(saved.attachment_count).toBe(1)
		await patchTask(apiContext, userToken, 'Current task title')
		const added = await apiContext.post(`${api}/projects/1/tasks`, {
			headers: headers(userToken),
			data: {
				title: 'Extra current task',
				description: '<p>Current-only body</p>',
			},
		})
		expect(added.ok(), await added.text()).toBe(true)
		const addedTask = await added.json()
		const currentView = await (await apiContext.get(`${api}/projects/1`, {headers: headers(userToken)})).json()
		const kanban = currentView.views.find((view: {id: number}) => view.id === 4)
		expect((await apiContext.put(`${api}/projects/1/views/4`, {
			headers: headers(userToken),
			data: {
				...kanban,
				title: 'Current board',
			},
		})).ok()).toBe(true)
		expect((await apiContext.put(`${api}/projects/1/views/4/buckets/1`, {
			headers: headers(userToken),
			data: {title: 'Current bucket'},
		})).ok()).toBe(true)
		expect((await apiContext.delete(`${api}/tasks/1/attachments/${attachment.id}`, {headers: headers(userToken)})).ok()).toBe(true)
		expect((await apiContext.post(comments, {
			headers: headers(userToken),
			data: {comment: '<p>After checkpoint fact</p>'},
		})).ok()).toBe(true)
		await page.reload()
		const taskChange = page.locator('.project-versions__changes details').filter({has: page.locator('summary', {hasText: 'Saved task'})})
		await taskChange.locator('summary').focus()
		await page.keyboard.press('Enter')
		await expect(taskChange).toContainText('Saved description with detail')
		await expect(taskChange).toContainText('Current description after the checkpoint')
		await expect(taskChange).toContainText('2027')
		await expect(taskChange.getByAltText('Saved image')).toBeVisible()
		await expect.poll(() => taskChange.getByAltText('Saved image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
		const download = page.waitForEvent('download')
		await taskChange.getByRole('button', {
			name: chinese ? '下载原文件' : 'Download original',
			exact: true,
		}).click()
		const original = await download
		expect(readFileSync((await original.path())!)).toEqual(readFileSync(new URL('../../fixtures/image-blue.png', import.meta.url)))
		const removed = page.locator('.project-versions__changes details').filter({has: page.locator('summary', {hasText: 'Extra current task'})})
		await removed.locator('summary').click()
		await expect(removed).toContainText('Current-only body')
		await expect(removed).toContainText(chinese ? '这一侧没有此内容' : 'This item is absent on this side')
		await noOverflow(page)
		await page.evaluate(() => window.scrollTo(0, 0))
		await page.screenshot({
			path: testInfo.outputPath(`versions-compare-${width}.png`),
			fullPage: true,
			animations: 'disabled',
		})
		await page.evaluate(() => {Object.assign(window, {projectVersionsDocument: 'same-document'})})
		await expect(page.getByTestId('version-restore')).not.toHaveAttribute('aria-disabled', 'true')
		await page.getByTestId('version-restore').click()
		dialog = page.getByRole('dialog', {
			name: chinese ? '恢复此版本' : 'Restore this checkpoint',
			exact: true,
		})
		await expect(dialog).toContainText('Research project — Before launch')
		await expect(dialog).toContainText(chinese ? '评论、实际打卡' : 'Comments, actual check-ins')
		await page.screenshot({
			path: testInfo.outputPath(`versions-confirm-${width}.png`),
			animations: 'disabled',
		})
		await dialog.getByRole('button', {
			name: chinese ? '恢复此版本' : 'Restore this checkpoint',
			exact: true,
		}).click()
		await expect(dialog).toBeHidden({timeout: 30_000})
		expect(await page.evaluate(() => (window as Window & {projectVersionsDocument?: string}).projectVersionsDocument)).toBe('same-document')
		const task = await (await apiContext.get(`${api}/tasks/1`, {headers: headers(userToken)})).json()
		expect(task.title).toBe('Saved task')
		expect(task.description).toContain('Saved description')
		expect(task.due_date).toContain('2027-01-15')
		expect(task.attachments).toHaveLength(1)
		expect(task.attachments[0].file.id).toBe(attachment.file.id)
		const removedTask = await apiContext.get(`${api}/tasks/${addedTask.id}`, {headers: headers(userToken)})
		expect([403, 404]).toContain(removedTask.status())
		const facts = await (await apiContext.get(comments, {headers: headers(userToken)})).json()
		expect(Array.isArray(facts) ? facts.length : facts.items.length).toBe(2)
		const project = await (await apiContext.get(`${api}/projects/1`, {headers: headers(userToken)})).json()
		expect(project.views.find((view: {id: number}) => view.id === 4).title).toBe(kanban.title)
		const buckets = await (await apiContext.get(`${api}/projects/1/views/4/buckets`, {headers: headers(userToken)})).json()
		expect((Array.isArray(buckets) ? buckets : buckets.items).find((bucket: {id: number}) => bucket.id === 1).title).toBe('Saved bucket')
		const versions = await readVersions(apiContext, userToken)
		expect(versions.items.map((version: {kind: string}) => version.kind)).toEqual(['restored', 'before_restore', 'manual'])
		await page.reload()
		await expect(page.getByRole('heading', {
			name: 'Before launch',
			exact: true,
		})).toBeVisible()
		await page.getByRole('link', {
			name: chinese ? '返回项目' : 'Back to project',
			exact: true,
		}).click()
		await expect(page.locator('.tasktext').filter({hasText: 'Saved task'}).first()).toBeVisible()
		await noOverflow(page)
	})
}

for (const permission of [0, 1]) {
	test(`current project member permission ${permission} exposes only authorized version actions`, async ({
		authenticatedPage: page, apiContext, userToken,
	}) => {
		const [owner] = await UserFactory.create(1, {id: 2}, false)
		await seed(2)
		await UserProjectFactory.create(1, {
			project_id: 1,
			user_id: 1,
			permission,
		})
		const ownerToken = (await login(null, apiContext, owner)).token
		const saved = await checkpoint(apiContext, ownerToken)
		await page.setViewportSize({
			width: 390,
			height: 844,
		})
		await page.goto('/projects/1/1')
		await page.locator('header.navbar').getByRole('button', {name: 'Open project settings menu'}).click()
		await page.getByRole('link', {
			name: 'Project versions',
			exact: true,
		}).click()
		await page.getByTestId('version-point').filter({hasText: 'Before launch'}).click()
		await expect(page.getByRole('heading', {
			name: 'Before launch',
			exact: true,
		})).toBeVisible()
		await expect(page.getByTestId('version-restore')).toHaveCount(0)
		await expect(page.getByRole('button', {
			name: 'Delete checkpoint',
			exact: true,
		})).toHaveCount(0)
		await expect(page.getByTestId('version-save')).toHaveCount(permission === 1 ? 1 : 0)
		const plan = await (await apiContext.get(`${api}/projects/1/versions/${saved.id}/preview`, {headers: headers(userToken)})).json()
		expect(plan.can_restore).toBe(false)
		const denied = await apiContext.post(`${api}/projects/1/versions/${saved.id}/restore`, {
			headers: headers(userToken),
			data: {
				expected_current_hash: plan.current_hash,
				plan_hash: plan.plan_hash,
				request_id: randomUUID(),
			},
		})
		expect(denied.status()).toBe(403)
		if (permission === 1) {
			await page.getByTestId('version-save').click()
			const dialog = page.getByRole('dialog', {
				name: 'Save checkpoint',
				exact: true,
			})
			await dialog.getByLabel('Checkpoint name', {exact: true}).fill('Writer checkpoint')
			await dialog.getByRole('button', {
				name: 'Save checkpoint',
				exact: true,
			}).click()
			await expect(dialog).toBeHidden()
			expect((await readVersions(apiContext, userToken)).items[0].name).toBe('Writer checkpoint')
		} else {
			const deniedSave = await apiContext.post(`${api}/projects/1/versions`, {
				headers: headers(userToken),
				data: {
					name: 'Denied save',
					request_id: randomUUID(),
				},
			})
			expect(deniedSave.status()).toBe(403)
		}
	})
}

test('a stale restore preview writes nothing and requires a fresh confirmation', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	await seed()
	const saved = await checkpoint(apiContext, userToken)
	await patchTask(apiContext, userToken, 'Current before preview')
	await page.goto(`/projects/1/versions?version=${saved.id}`)
	await expect(page.getByTestId('version-restore')).not.toHaveAttribute('aria-disabled', 'true')
	await page.getByTestId('version-restore').click()
	const dialog = page.getByRole('dialog', {
		name: 'Restore this checkpoint',
		exact: true,
	})
	await patchTask(apiContext, userToken, 'Concurrent latest edit')
	await dialog.getByRole('button', {
		name: 'Restore this checkpoint',
		exact: true,
	}).click()
	await expect(dialog.getByRole('alert')).toContainText('project or restore plan changed')
	await expect(dialog.getByRole('button', {
		name: 'Restore this checkpoint',
		exact: true,
	})).toHaveAttribute('aria-disabled', 'true')
	const task = await (await apiContext.get(`${api}/tasks/1`, {headers: headers(userToken)})).json()
	expect(task.title).toBe('Concurrent latest edit')
	expect((await readVersions(apiContext, userToken)).total).toBe(1)
	await dialog.getByRole('button', {
		name: 'Cancel',
		exact: true,
	}).click()
	await expect(page.getByTestId('version-restore')).not.toHaveAttribute('aria-disabled', 'true')
})

test('saving retries a lost response with the same request ID and keeps the entered name', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	await seed()
	await page.goto('/projects/1/versions')
	let loseReply = true
	await page.route('**/api/v2/projects/1/versions', async route => {
		if (route.request().method() !== 'POST' || !loseReply) return route.continue()
		loseReply = false
		const committed = await route.fetch()
		expect(committed.ok()).toBe(true)
		await route.abort('failed')
	})
	await page.getByTestId('version-save').click()
	const dialog = page.getByRole('dialog', {
		name: 'Save checkpoint',
		exact: true,
	})
	await dialog.getByLabel('Checkpoint name', {exact: true}).fill('Keep this name')
	await dialog.getByRole('button', {
		name: 'Save checkpoint',
		exact: true,
	}).click()
	await expect(dialog.getByRole('alert')).toBeVisible()
	await expect(dialog.getByLabel('Checkpoint name', {exact: true})).toHaveValue('Keep this name')
	await dialog.getByRole('button', {
		name: 'Save checkpoint',
		exact: true,
	}).click()
	await expect(dialog).toBeHidden()
	const versions = await readVersions(apiContext, userToken)
	expect(versions.total).toBe(1)
	expect(versions.items[0].name).toBe('Keep this name')
})

test('archived projects can save checkpoints but require an explicit unarchive before restore', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	await seed(1, true)
	const saved = await checkpoint(apiContext, userToken)
	await page.goto(`/projects/1/versions?version=${saved.id}`)
	await expect(page.getByTestId('version-save')).toBeVisible()
	await expect(page.getByTestId('version-restore')).toHaveAttribute('aria-disabled', 'true')
	await expect(page.locator('.project-versions__detail')).toContainText('Explicitly unarchive')
	await expect(page.getByTestId('version-restore')).toBeDisabled()
	await expect(page.getByRole('dialog', {
		name: 'Restore this checkpoint',
		exact: true,
	})).toHaveCount(0)
})

test('checkpoint pagination survives reload and deleting the last row returns to an existing page', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	test.setTimeout(120_000)
	await seed()
	await checkpoint(apiContext, userToken, 'Checkpoint 1')
	const perPage = (await readVersions(apiContext, userToken)).per_page
	for (let index = 2; index <= perPage + 1; index++) await checkpoint(apiContext, userToken, `Checkpoint ${index}`)
	await page.goto('/projects/1/versions?page=2')
	await expect(page.getByTestId('version-point')).toHaveCount(1)
	await page.getByTestId('version-point').click()
	await page.reload()
	await expect(page.getByRole('heading', {
		name: 'Checkpoint 1',
		exact: true,
	})).toBeVisible()
	await expect(page).toHaveURL(/page=2/)
	await page.getByRole('button', {
		name: 'Delete checkpoint',
		exact: true,
	}).click()
	const dialog = page.getByRole('dialog', {
		name: 'Delete checkpoint',
		exact: true,
	})
	await dialog.getByLabel('Enter the exact checkpoint name to confirm').fill('Wrong name')
	await expect(dialog.getByRole('button', {
		name: 'Delete checkpoint',
		exact: true,
	})).toBeDisabled()
	await expect(dialog).toBeVisible()
	await dialog.getByLabel('Enter the exact checkpoint name to confirm').fill('Checkpoint 1')
	await dialog.getByRole('button', {
		name: 'Delete checkpoint',
		exact: true,
	}).click()
	await expect(dialog).toBeHidden()
	await expect(page).toHaveURL(/page=1/)
	await expect(page.getByTestId('version-point')).toHaveCount(perPage)
	expect((await readVersions(apiContext, userToken)).total).toBe(perPage)
})

test('returning to a view removed by restore selects a valid restored view without reloading the document', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
}) => {
	await seed()
	const saved = await checkpoint(apiContext, userToken)
	const created = await apiContext.post(`${api}/projects/1/views`, {
		headers: headers(userToken),
		data: {
			title: 'Temporary view',
			view_kind: 'list',
			position: 5,
		},
	})
	expect(created.ok(), await created.text()).toBe(true)
	const temporary = await created.json()
	expect((await apiContext.delete(`${api}/projects/1/views/4`, {headers: headers(userToken)})).ok()).toBe(true)
	await page.goto(`/projects/1/${temporary.id}`)
	await expect(page.locator('.project-view-shell')).toBeVisible()
	await page.evaluate(() => {Object.assign(window, {projectVersionsDocument: 'view-document'})})
	await page.locator('header.navbar').getByRole('button', {name: 'Open project settings menu'}).click()
	await page.getByRole('link', {
		name: 'Project versions',
		exact: true,
	}).click()
	await expect(page.locator('header.navbar').getByRole('button', {name: 'Open project settings menu'})).toHaveAttribute('aria-expanded', 'false')
	await page.getByTestId('version-point').filter({hasText: saved.name}).click()
	await expect(page.getByTestId('version-restore')).not.toHaveAttribute('aria-disabled', 'true')
	await page.getByTestId('version-restore').click()
	const dialog = page.getByRole('dialog', {
		name: 'Restore this checkpoint',
		exact: true,
	})
	const response = page.waitForResponse(reply => reply.request().method() === 'POST'
		&& new URL(reply.url()).pathname.endsWith(`/projects/1/versions/${saved.id}/restore`))
	await dialog.getByRole('button', {
		name: 'Restore this checkpoint',
		exact: true,
	}).click()
	const receipt = await (await response).json()
	expect(receipt.verified).toBe(true)
	expect(receipt.id_map.views['4']).toBeGreaterThan(0)
	await expect(dialog).toBeHidden()
	await page.goBack()
	await page.goBack()
	const project = await (await apiContext.get(`${api}/projects/1`, {headers: headers(userToken)})).json()
	const liveViews = project.views.map((view: {id: number}) => view.id)
	await expect.poll(() => Number(new URL(page.url()).pathname.split('/').pop())).not.toBe(temporary.id)
	expect(liveViews).toContain(Number(new URL(page.url()).pathname.split('/').pop()))
	await expect(page.locator('.project-view-shell')).toBeVisible()
	await expect(page.locator('.tasktext').filter({hasText: 'Saved task'}).first()).toBeVisible()
	expect(await page.evaluate(() => (window as Window & {projectVersionsDocument?: string}).projectVersionsDocument)).toBe('view-document')
})
