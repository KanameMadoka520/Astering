import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {createDefaultViews} from '../project/prepareProjects'

test('comment create, edit and delete persist after reload', async ({authenticatedPage: page, apiContext, userToken}) => {
	const [project] = await ProjectFactory.create(1)
	await createDefaultViews(project.id)
	const [task] = await TaskFactory.create(1, {project_id: project.id})
	const headers = {Authorization: `Bearer ${userToken}`}
	await page.goto(`/tasks/${task.id}`)
	await page.locator('.comments .tiptap[contenteditable="true"]').fill('Original comment')
	await page.locator('.comments').getByRole('button', {name: 'Comment', exact: true}).click()
	const row = page.locator('.comments .comment[id^="comment-"]')
	await expect(row).toContainText('Original comment')
	await expect(page.locator('.global-notification')).toContainText('Success')
	await page.reload()
	await expect(row).toContainText('Original comment')
	await row.getByRole('button', {name: 'Edit', exact: true}).click()
	await row.locator('.tiptap[contenteditable="true"]').fill('Updated comment')
	await row.getByRole('button', {name: 'Save', exact: true}).click()
	await expect(row).toContainText('Updated comment')
	await page.reload()
	await expect(row).toContainText('Updated comment')
	let stored = await apiContext.get(`tasks/${task.id}/comments`, {headers})
	expect(stored.ok()).toBeTruthy()
	expect(await stored.json()).toEqual([expect.objectContaining({comment: '<p>Updated comment</p>'})])
	await row.getByRole('button', {name: 'Delete', exact: true}).click()
	await page.getByRole('dialog').getByRole('button', {name: 'Delete this comment', exact: true}).click()
	await expect(row).toHaveCount(0)
	await page.reload()
	await expect(page.locator('.comments').getByRole('button', {name: 'Comment', exact: true})).toBeVisible()
	await expect(row).toHaveCount(0)
	stored = await apiContext.get(`tasks/${task.id}/comments`, {headers})
	expect(stored.ok()).toBeTruthy()
	expect(await stored.json()).toEqual([])
})

test('a comment edit that fails to save says so and can be retried', async ({authenticatedPage: page, apiContext, userToken}) => {
	const [project] = await ProjectFactory.create(1)
	await createDefaultViews(project.id)
	const [task] = await TaskFactory.create(1, {project_id: project.id})
	const headers = {Authorization: `Bearer ${userToken}`}
	await page.goto(`/tasks/${task.id}`)
	await page.locator('.comments .tiptap[contenteditable="true"]').fill('Original comment')
	await page.locator('.comments').getByRole('button', {name: 'Comment', exact: true}).click()
	const row = page.locator('.comments .comment[id^="comment-"]')
	await expect(row).toContainText('Original comment')

	const commentUrl = /\/tasks\/\d+\/comments\/\d+$/
	await page.route(commentUrl, route => route.request().method() === 'GET'
		? route.continue()
		: route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Server error'})}))
	await row.getByRole('button', {name: 'Edit', exact: true}).click()
	await row.locator('.tiptap[contenteditable="true"]').fill('Edited while the server fails')
	await row.getByRole('button', {name: 'Save', exact: true}).click()

	const alert = row.getByRole('alert')
	await expect(alert).toContainText('This change to your comment wasn\'t saved.')
	await expect(row).toContainText('Edited while the server fails')
	let stored = await apiContext.get(`tasks/${task.id}/comments`, {headers})
	expect(await stored.json()).toEqual([expect.objectContaining({comment: '<p>Original comment</p>'})])

	await page.unroute(commentUrl)
	await alert.getByRole('button', {name: 'Retry'}).click()
	await expect(alert).toHaveCount(0)
	await expect.poll(async () => {
		stored = await apiContext.get(`tasks/${task.id}/comments`, {headers})
		return (await stored.json())[0]?.comment
	}).toBe('<p>Edited while the server fails</p>')
})
