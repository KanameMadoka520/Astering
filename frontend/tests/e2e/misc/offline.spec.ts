import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'

test.describe('Losing the connection', () => {
	test('keeps the open page and the text being typed', async ({authenticatedPage: page, apiContext, userToken}) => {
		await ProjectFactory.create(1)
		const [task] = await TaskFactory.create(1, {id: 1, description: 'Initial description'})
		await page.goto(`/tasks/${task.id}`)

		const description = page.locator('.task-view .details.content.description')
		await description.locator('.tiptap button.done-edit').click()
		const editor = description.locator('.tiptap__editor .tiptap.ProseMirror')
		await editor.fill('Typed while the train enters a tunnel')

		await page.context().setOffline(true)
		await expect(page.getByRole('status').filter({hasText: 'You are offline.'})).toBeVisible()
		await expect(editor).toContainText('Typed while the train enters a tunnel')
		await expect(page.locator('.app.offline')).toHaveCount(0)

		await page.context().setOffline(false)
		await expect(page.getByRole('status').filter({hasText: 'You are offline.'})).toHaveCount(0)
		await expect(editor).toContainText('Typed while the train enters a tunnel')

		await page.locator('[data-cy="saveEditor"]').filter({hasText: 'Save'}).click()
		await expect.poll(async () => {
			const response = await apiContext.get(`tasks/${task.id}`, {headers: {Authorization: `Bearer ${userToken}`}})
			return (await response.json()).description
		}).toContain('Typed while the train enters a tunnel')
	})
})
