import {test, expect} from '../../support/fixtures'
import {TaskFactory} from '../../factories/task'
import {ProjectFactory} from '../../factories/project'
import {TaskRelationFactory} from '../../factories/task_relation'

test.describe('TipTap Editor Save', () => {
	test.beforeEach(async ({authenticatedPage: page}) => {
		await ProjectFactory.create(1)
	})

	/**
	 * Regression test for https://github.com/go-vikunja/vikunja/issues/1770
	 *
	 * When saving the description editor, a race condition between Vue's DOM
	 * reconciliation and tiptap's internal DOM manipulation during unmount
	 * caused "Cannot read properties of null (reading 'insertBefore')" error.
	 *
	 * The fix uses v-show instead of v-if for EditorToolbar and BubbleMenu
	 * to avoid unmounting them during edit mode transitions.
	 */
	test('Should not crash when saving description (issue #1770)', async ({authenticatedPage: page}) => {
		const tasks = await TaskFactory.create(1, {
			id: 1,
			description: 'Initial description',
		})

		// Collect any page errors and console errors that occur
		const pageErrors: Error[] = []
		const consoleErrors: string[] = []

		page.on('pageerror', (error) => {
			pageErrors.push(error)
		})

		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text())
			}
		})

		await page.goto(`/tasks/${tasks[0].id}`)
		await page.waitForLoadState('networkidle')

		// Click edit button to enter edit mode
		const editButton = page.locator('.task-view .details.content.description .tiptap button.done-edit')
		await expect(editButton).toBeVisible({timeout: 10000})
		await editButton.click()

		// Wait for editor to be visible and editable
		const editor = page.locator('.task-view .details.content.description .tiptap__editor .tiptap.ProseMirror')
		await expect(editor).toBeVisible()

		// Make an edit
		await editor.fill('Updated description text')

		// Save the description - this triggers the mode transition that could crash
		const saveButton = page.locator('[data-cy="saveEditor"]').filter({hasText: 'Save'})
		await expect(saveButton).toBeVisible()
		await saveButton.click()

		// Wait for save confirmation
		await expect(page.locator('.task-view .details.content.description h2 span.is-small.has-text-success')).toContainText('Saved!')

		// Give time for mode transition and any async errors to surface
		await page.waitForTimeout(2000)

		// Check for errors - either the DOM crashes or the edit button should appear
		const insertBeforeErrors = [
			...pageErrors.filter(e =>
				e.message.includes('insertBefore') ||
				e.message.includes('Cannot read properties of null'),
			),
			...consoleErrors.filter(msg =>
				msg.includes('insertBefore') ||
				msg.includes('Cannot read properties of null'),
			),
		]

		// If there are DOM manipulation errors, fail the test
		if (insertBeforeErrors.length > 0) {
			throw new Error(`DOM manipulation errors detected (issue #1770): ${JSON.stringify(insertBeforeErrors)}`)
		}

		// If no errors, the edit button should be visible (mode transition completed)
		await expect(page.locator('.task-view .details.content.description .tiptap button.done-edit')).toBeVisible({timeout: 5000})
	})

	test('Should not crash when rapidly toggling edit mode (issue #1770)', async ({authenticatedPage: page}) => {
		const tasks = await TaskFactory.create(1, {
			id: 1,
			description: 'Test description for rapid toggle',
		})

		// Collect any page errors and console errors that occur
		const pageErrors: Error[] = []
		const consoleErrors: string[] = []

		page.on('pageerror', (error) => {
			pageErrors.push(error)
		})

		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text())
			}
		})

		await page.goto(`/tasks/${tasks[0].id}`)
		await page.waitForLoadState('networkidle')

		// Perform multiple edit/save cycles to stress test the mode transitions
		for (let i = 0; i < 3; i++) {
			// Enter edit mode - click edit button or double-click the editor
			const editButton = page.locator('.task-view .details.content.description .tiptap button.done-edit')
			const isEditButtonVisible = await editButton.isVisible().catch(() => false)

			if (isEditButtonVisible) {
				await editButton.click()
			} else {
				// Already in edit mode or need to double-click to enter
				const editorArea = page.locator('.task-view .details.content.description .tiptap__editor')
				await editorArea.dblclick()
			}

			// Wait for editor to be editable
			const editor = page.locator('.task-view .details.content.description .tiptap__editor .tiptap.ProseMirror')
			await expect(editor).toBeVisible()

			// Make a small edit
			await editor.fill(`Cycle ${i + 1} description`)

			// Save
			const saveButton = page.locator('[data-cy="saveEditor"]').filter({hasText: 'Save'})
			await expect(saveButton).toBeVisible()
			await saveButton.click()

			// Wait for save confirmation
			await expect(page.locator('.task-view .details.content.description h2 span.is-small.has-text-success')).toContainText('Saved!')

			// Give time for mode transition
			await page.waitForTimeout(2000)

			// Check for errors after each cycle
			const domErrors = [
				...pageErrors.filter(e =>
					e.message.includes('insertBefore') ||
					e.message.includes('Cannot read properties of null'),
				),
				...consoleErrors.filter(msg =>
					msg.includes('insertBefore') ||
					msg.includes('Cannot read properties of null'),
				),
			]

			// If there are DOM manipulation errors, fail the test
			if (domErrors.length > 0) {
				throw new Error(`DOM manipulation errors detected in cycle ${i + 1} (issue #1770): ${JSON.stringify(domErrors)}`)
			}

			// Verify mode transition completed (edit button should be visible)
			await expect(page.locator('.task-view .details.content.description .tiptap button.done-edit')).toBeVisible({timeout: 5000})
		}
	})

	test.describe('unsaved description text', () => {
		const description = '.task-view .details.content.description'
		const editorLocator = `${description} .tiptap__editor .tiptap.ProseMirror`

		async function storedDescription(apiContext, userToken: string, id: number) {
			const response = await apiContext.get(`tasks/${id}`, {headers: {Authorization: `Bearer ${userToken}`}})
			expect(response.ok()).toBeTruthy()
			return (await response.json()).description as string
		}

		async function startEditing(page) {
			await page.locator(`${description} .tiptap button.done-edit`).click()
			await expect(page.locator(editorLocator)).toBeVisible()
		}

		test('Ctrl+S sends the description being typed and says so', async ({authenticatedPage: page, apiContext, userToken}) => {
			const [task] = await TaskFactory.create(1, {id: 1, description: 'Initial description'})
			await page.goto(`/tasks/${task.id}`)
			await startEditing(page)
			await page.locator(editorLocator).fill('Saved with the shortcut')
			await page.keyboard.press('ControlOrMeta+s')
			await expect(page.locator('.global-notification')).toContainText('The task was saved successfully.')
			expect(await storedDescription(apiContext, userToken, task.id)).toContain('Saved with the shortcut')
		})

		test('Ctrl+S with nothing unsaved does not claim a save', async ({authenticatedPage: page}) => {
			const [task] = await TaskFactory.create(1, {id: 1, description: 'Initial description'})
			await page.goto(`/tasks/${task.id}`)
			await expect(page.locator(description)).toContainText('Initial description')
			await page.locator('.task-view h1.title').focus()
			await page.locator('.task-view h1.title').blur()
			await page.keyboard.press('ControlOrMeta+s')
			await expect(page.locator('.global-notification')).toContainText('All changes are already saved.')
		})

		test('Esc discards the edit and nothing is saved later', async ({authenticatedPage: page, apiContext, userToken}) => {
			const [task] = await TaskFactory.create(1, {id: 1, description: 'Initial description'})
			await page.goto(`/tasks/${task.id}`)
			await startEditing(page)
			await page.locator(editorLocator).fill('This should be discarded')
			await page.keyboard.press('Escape')
			await expect(page.locator(description)).toContainText('Initial description')
			await page.waitForTimeout(6000)
			expect(await storedDescription(apiContext, userToken, task.id)).toContain('Initial description')
			await page.reload()
			await expect(page.locator(description)).toContainText('Initial description')
			await expect(page.locator(description)).not.toContainText('This should be discarded')
		})

		test('opening a related task right after typing keeps the text', async ({authenticatedPage: page, apiContext, userToken}) => {
			await TaskFactory.create(1, {id: 1, title: 'First task', description: 'Initial description'})
			await TaskFactory.create(1, {id: 2, title: 'Second task', description: 'Other description'}, false)
			await TaskRelationFactory.create(1, {task_id: 1, other_task_id: 2, relation_kind: 'related'})
			await TaskRelationFactory.create(1, {id: 2, task_id: 2, other_task_id: 1, relation_kind: 'related'}, false)
			await page.goto('/tasks/1')
			await startEditing(page)
			await page.locator(editorLocator).fill('Typed just before leaving')
			await page.locator('.related-tasks a', {hasText: 'Second task'}).first().click()
			await expect(page).toHaveURL(/\/tasks\/2/)
			await expect.poll(() => storedDescription(apiContext, userToken, 1)).toContain('Typed just before leaving')
		})

		test('offers text left unsaved by a reload back, and only to the same account', async ({authenticatedPage: page, apiContext, userToken}) => {
			const [task] = await TaskFactory.create(1, {id: 1, description: 'Initial description'})
			await page.goto(`/tasks/${task.id}`)
			await startEditing(page)
			await page.locator(editorLocator).fill('Left on this device')
			// Leaving the tab (a phone switching apps) sends the text right away; here that request does not get
			// through, so the text stays only on this device.
			const taskWrite = (url: URL) => url.pathname.endsWith(`/api/v2/tasks/${task.id}`)
			let blockedWrites = 0
			await page.route(taskWrite, route => {
				if (route.request().method() === 'GET') return route.continue()
				blockedWrites++
				return route.abort()
			})
			await page.evaluate(() => {
				Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'})
				document.dispatchEvent(new Event('visibilitychange'))
			})
			await expect.poll(() => blockedWrites).toBeGreaterThan(0)
			await page.evaluate(() => delete (document as {visibilityState?: DocumentVisibilityState}).visibilityState)
			// The reload hides the tab again, but a request started while the page unloads never leaves the browser:
			// it is cross-origin and not keepalive.
			page.on('dialog', dialog => dialog.accept())
			await page.reload()
			await expect(page.locator(description)).toContainText('unsaved version of this description')
			expect(await storedDescription(apiContext, userToken, task.id)).toContain('Initial description')
			await page.unroute(taskWrite)
			await page.getByRole('button', {name: 'Restore and save'}).click()
			await expect.poll(() => storedDescription(apiContext, userToken, task.id)).toContain('Left on this device')
			await expect(page.locator(description)).not.toContainText('unsaved version of this description')
		})
	})
})
