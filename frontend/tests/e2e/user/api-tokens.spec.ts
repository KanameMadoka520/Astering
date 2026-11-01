import {test, expect} from '../../support/fixtures'
import {serverPageSize} from '../../support/pagination'

test.describe('API Tokens', () => {
	test('Pre-populates title from query parameter', async ({authenticatedPage: page}) => {
		await page.goto('/user/settings/api-tokens?title=My%20Test%20Token')
		await page.waitForLoadState('networkidle')

		// Form should be visible automatically
		const titleInput = page.locator('#apiTokenTitle')
		await expect(titleInput).toBeVisible({timeout: 5000})

		// Title should be pre-populated
		await expect(titleInput).toHaveValue('My Test Token')
	})

	test('Pre-selects scopes from query parameter', async ({authenticatedPage: page}) => {
		// Use actual scope names: tasks:create
		await page.goto('/user/settings/api-tokens?scopes=tasks:create')
		await page.waitForLoadState('networkidle')

		// Form should be visible automatically when scopes are provided
		const permissionsLabel = page.locator('label.label:has-text("Permissions")')
		await expect(permissionsLabel).toBeVisible({timeout: 5000})

		// The title input should be visible (form is shown)
		const titleInput = page.locator('#apiTokenTitle')
		await expect(titleInput).toBeVisible()

		// Checkboxes are named by their visible label. The exact group name only matches "tasks",
		// not "tasks attachments" and the other tasks_* groups.
		const tasksGroupCheckbox = page.getByRole('checkbox', {name: 'tasks', exact: true})
		await expect(tasksGroupCheckbox).toHaveCount(1)
		const tasksGroupDiv = page.locator('.mbe-2').filter({has: tasksGroupCheckbox})
		await expect(tasksGroupDiv).toBeVisible()

		// Within that group, find the specific "create" permission checkbox and verify it's checked
		const createCheckbox = tasksGroupDiv.getByRole('checkbox', {name: 'create', exact: true})
		await expect(createCheckbox).toBeChecked()
	})

	test('Pre-populates both title and scopes from query parameters', async ({authenticatedPage: page}) => {
		await page.goto('/user/settings/api-tokens?title=Integration%20Token&scopes=labels:create')
		await page.waitForLoadState('networkidle')

		// Form should be visible automatically
		const titleInput = page.locator('#apiTokenTitle')
		await expect(titleInput).toBeVisible({timeout: 5000})
		await expect(titleInput).toHaveValue('Integration Token')

		// Permissions section should be visible
		const permissionsLabel = page.locator('label.label:has-text("Permissions")')
		await expect(permissionsLabel).toBeVisible()
	})

	test('Shows create form without query parameters', async ({authenticatedPage: page}) => {
		await page.goto('/user/settings/api-tokens')
		await page.waitForLoadState('networkidle')

		// Form should NOT be visible initially
		const titleInput = page.locator('#apiTokenTitle')
		await expect(titleInput).not.toBeVisible({timeout: 2000})

		// Click the create button to show the form
		const createButton = page.locator('button:has-text("Create a token")')
		await expect(createButton).toBeVisible()
		await createButton.click()

		// Now the form should be visible
		await expect(titleInput).toBeVisible()
	})
})

test('creates and revokes a scoped token with stored state surviving reload', async ({authenticatedPage: page, apiContext}) => {
	await page.goto('/user/settings/api-tokens?title=Stored%20token&scopes=tasks:read_all')
	const tasksGroupCheckbox = page.getByRole('checkbox', {name: 'tasks', exact: true})
	await expect(tasksGroupCheckbox).toHaveCount(1)
	const tasksGroup = page.locator('.mbe-2').filter({has: tasksGroupCheckbox})
	await expect(page.locator('#apiTokenTitle')).toHaveValue('Stored token')
	await expect(tasksGroup.getByRole('checkbox', {name: 'read all', exact: true})).toBeChecked()
	const created = page.waitForResponse(r => r.url().endsWith('/api/v2/tokens') && r.request().method() === 'POST')
	await page.getByRole('button', {name: 'Create token', exact: true}).click()
	const response = await created
	expect(response.ok()).toBe(true)
	const token = await response.json()
	await expect(page.locator('.message')).toContainText(token.token)
	await expect(page.locator('tbody')).toContainText('Stored token')
	await page.reload()
	await expect(page.locator('tbody')).toContainText('Stored token')
	await expect(page.locator('body')).not.toContainText(token.token)
	const usable = await apiContext.get('/api/v2/tasks', {headers: {Authorization: `Bearer ${token.token}`}})
	expect(usable.ok()).toBe(true)
	await page.getByRole('button', {name: 'Delete', exact: true}).click()
	await page.locator('[data-cy="modalPrimary"]').click()
	await expect(page.locator('tbody tr')).toHaveCount(0)
	await page.reload()
	await expect(page.locator('tbody tr')).toHaveCount(0)
	const revoked = await apiContext.get('/api/v2/tasks', {headers: {Authorization: `Bearer ${token.token}`}})
	expect(revoked.status()).toBe(401)
})

test('pages through more tokens than fit on one page', async ({authenticatedPage: page, apiContext, userToken}) => {
	const pageSize = await serverPageSize(apiContext)
	for (let i = 1; i <= pageSize + 1; i++) {
		const response = await apiContext.post('/api/v2/tokens', {
			headers: {Authorization: `Bearer ${userToken}`},
			data: {
				title: `Paged token ${i}`,
				permissions: {tasks: ['read_all']},
				expires_at: '2099-01-01T00:00:00Z',
			},
		})
		expect(response.ok()).toBe(true)
	}
	await page.goto('/user/settings/api-tokens')
	await expect(page.locator('tbody tr')).toHaveCount(pageSize)
	await page.locator('nav.pagination').getByText('2', {exact: true}).click()
	await expect(page).toHaveURL(/[?&]page=2/)
	await expect(page.locator('tbody tr')).toHaveCount(1)
	await page.reload()
	await expect(page.locator('tbody tr')).toHaveCount(1)
	await page.getByRole('button', {name: 'Delete', exact: true}).click()
	await page.locator('[data-cy="modalPrimary"]').click()
	await expect(page.locator('tbody tr')).toHaveCount(pageSize)
	await expect(page.locator('nav.pagination')).toHaveCount(0)
})

test('keeps the delete dialog open when revoking a token fails', async ({authenticatedPage: page, apiContext, userToken}) => {
	const response = await apiContext.post('/api/v2/tokens', {
		headers: {Authorization: `Bearer ${userToken}`},
		data: {title: 'Kept token', permissions: {tasks: ['read_all']}, expires_at: '2099-01-01T00:00:00Z'},
	})
	expect(response.ok()).toBe(true)
	await page.route(/\/api\/v2\/tokens\/\d+$/, route => route.request().method() === 'DELETE'
		? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Server error'})})
		: route.continue())
	await page.goto('/user/settings/api-tokens')
	await page.getByRole('button', {name: 'Delete', exact: true}).click()
	const dialog = page.locator('dialog[open]')
	await expect(dialog).toContainText('Are you sure you want to delete the token "Kept token"?')
	await expect(dialog.locator('[data-cy="modalPrimary"]')).toHaveText('Delete token')
	await dialog.locator('[data-cy="modalPrimary"]').click()
	await expect(page.locator('.global-notification')).toBeVisible()
	await expect(dialog).toBeVisible()
	await expect(page.locator('tbody tr')).toHaveCount(1)
})

test('says the token list could not be loaded instead of showing it empty', async ({authenticatedPage: page}) => {
	await page.route(/\/api\/v2\/tokens(\?.*)?$/, route => route.request().method() === 'GET'
		? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Server error'})})
		: route.continue())
	await page.goto('/user/settings/api-tokens')
	await expect(page.locator('.load-error')).toContainText('This list couldn\'t be loaded, so it may not be empty.')
	await expect(page.getByText('You have no API tokens yet.')).toHaveCount(0)
})
