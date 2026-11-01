import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {TaskFactory} from '../../factories/task'
import {login} from '../../support/authenticateUser'

async function logout(page) {
	await page.locator('.navbar .username-dropdown-trigger').click()
	await page.locator('.navbar .dropdown-item').filter({hasText: 'Logout'}).click()
}

test.describe('Log out', () => {
	test.use({
		// All tests in this describe block use the authenticatedPage fixture
	})

	test('Logs the user out', async ({authenticatedPage: page}) => {
		await page.goto('/')

		// Check that token exists before logout
		const tokenBefore = await page.evaluate(() => localStorage.getItem('token'))
		expect(tokenBefore).not.toBeNull()

		await logout(page)

		// Check URL redirects to login
		await expect(page).toHaveURL(/\/login/)

		// Check that token is removed after logout
		const tokenAfter = await page.evaluate(() => localStorage.getItem('token'))
		expect(tokenAfter).toBeNull()
	})

	test('Should clear the project history after logging the user out', async ({authenticatedPage: page}) => {
		const projects = await ProjectFactory.create(1)
		await ProjectViewFactory.create(1, {
			id: projects[0].id,
			project_id: projects[0].id,
		}, false)

		// Wait for the project page to load and history to be saved
		const loadProjectPromise = page.waitForResponse(response =>
			response.url().includes(`/projects/${projects[0].id}`) && response.request().method() === 'GET',
		)
		await page.goto(`/projects/${projects[0].id}/${projects[0].id}`)
		await loadProjectPromise

		// Wait for history to be saved to localStorage
		await page.waitForFunction(
			(projectId) => {
				const history = JSON.parse(localStorage.getItem('projectHistory') || '[]')
				return history.some((h: {id: number}) => h.id === projectId)
			},
			projects[0].id,
		)

		// Check that project history exists
		const historyBefore = await page.evaluate(() => localStorage.getItem('projectHistory'))
		expect(historyBefore).not.toBeNull()

		await logout(page)

		// Check URL redirects to login
		await expect(page).toHaveURL(/\/login/)

		// Verify the project history is cleared after logout
		const historyAfter = await page.evaluate(() => localStorage.getItem('projectHistory'))
		expect(historyAfter).toBeNull()
	})

	test.describe('with unsaved task text in this browser', () => {
		const description = '.task-view .details.content.description'
		const editor = `${description} .tiptap__editor .tiptap.ProseMirror`

		// The description cannot reach the server, so it stays in this browser as an unsaved draft.
		async function leaveUnsavedDescription(page) {
			await ProjectFactory.create(1)
			const [task] = await TaskFactory.create(1, {id: 1, description: 'Saved description'})
			await page.route(/\/tasks\/\d+/, route => route.request().method() === 'GET' ? route.continue() : route.abort())
			await page.goto(`/tasks/${task.id}`)
			await page.locator(`${description} .tiptap button.done-edit`).click()
			await page.locator(editor).fill('Half a sentence nobody saved')
			await page.locator('[data-cy="saveEditor"]').filter({hasText: 'Save'}).click()
			await expect(page.locator('.global-notification')).toBeVisible()
			return task
		}

		const scopedDraftKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('editorDraft-v2:')))

		test('keeps it by default and offers it again to the same account', async ({authenticatedPage: page, apiContext, currentUser}) => {
			const task = await leaveUnsavedDescription(page)
			await logout(page)

			const dialog = page.getByRole('dialog')
			await expect(dialog).toContainText('Unsaved writing in this browser')
			await expect(dialog).toContainText('1 unsent task text')
			await expect(dialog.getByRole('checkbox', {name: 'Also remove these drafts from this browser'})).not.toBeChecked()
			await dialog.getByRole('button', {name: 'Log out and keep drafts'}).click()

			await expect(page).toHaveURL(/\/login/)
			expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull()
			expect(await scopedDraftKeys(page)).toHaveLength(1)

			await page.unroute(/\/tasks\/\d+/)
			// Logging out ended that session; the same account signs in again.
			await login(page, apiContext, currentUser)
			await page.goto(`/tasks/${task.id}`)
			await expect(page.locator(description)).toContainText('unsaved version of this description')
			await expect(page.getByRole('button', {name: 'Restore and save'})).toBeVisible()
		})

		test('removes it only when asked to', async ({authenticatedPage: page}) => {
			await leaveUnsavedDescription(page)
			await logout(page)

			const dialog = page.getByRole('dialog')
			await dialog.getByRole('checkbox', {name: 'Also remove these drafts from this browser'}).check()
			await dialog.getByRole('button', {name: 'Log out and remove drafts'}).click()

			await expect(page).toHaveURL(/\/login/)
			expect(await scopedDraftKeys(page)).toHaveLength(0)
		})

		test('Cancel keeps the user logged in', async ({authenticatedPage: page}) => {
			const task = await leaveUnsavedDescription(page)
			await logout(page)

			await page.getByRole('dialog').getByRole('button', {name: 'Cancel'}).click()

			await expect(page.getByRole('dialog')).toHaveCount(0)
			await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}`))
			expect(await page.evaluate(() => localStorage.getItem('token'))).not.toBeNull()
		})
	})
})
