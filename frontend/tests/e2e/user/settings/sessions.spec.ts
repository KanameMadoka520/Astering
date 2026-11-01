import {test, expect} from '../../../support/fixtures'
import {SessionFactory, hashSessionToken} from '../../../factories/session'
import {gotoUserSettings} from '../../../support/userSettings'
import {serverPageSize} from '../../../support/pagination'

test.describe('Sessions', () => {
	test('lists the current session and other sessions', async ({
		authenticatedPage: page, currentUser,
	}) => {
		// The auth fixture already created one session row (the login).
		// Seed one additional session with truncate=false so we don't wipe it.
		await SessionFactory.create(1, {
			user_id: currentUser.id,
			device_info: 'Firefox on Linux',
			ip_address: '192.0.2.5',
		}, false)

		await gotoUserSettings(page, 'sessions')
		const rows = page.locator('table.table tbody tr')
		await expect(rows).toHaveCount(2)
		await expect(page.locator('.tag.is-primary')).toContainText('Current')
		await expect(page.locator('tr', {hasText: 'Firefox on Linux'})).toContainText('192.0.2.5')
	})

	test('revoking a session breaks its refresh token', async ({
		authenticatedPage: page, currentUser, apiContext,
	}) => {
		const rawToken = 'fixed-refresh-token-for-test-12345678901234567890'
		await SessionFactory.create(1, {
			user_id: currentUser.id,
			token_hash: hashSessionToken(rawToken),
			ip_address: '192.0.2.5',
			device_info: 'Firefox on Linux',
		}, false)

		await gotoUserSettings(page, 'sessions')
		await page.locator('tr', {hasText: /192\.0\.2\.5/})
			.getByRole('button', {name: 'Revoke'}).click()
		const deleted = page.waitForResponse(r =>
			/\/user\/sessions\/[^/]+/.test(r.url()) && r.request().method() === 'DELETE',
		)
		await page.locator('dialog[open] [data-cy="modalPrimary"]').click()
		await deleted
		await expect(page.locator('table.table tbody tr')).toHaveCount(1)

		// After revoke, the refresh request must fail. Refresh tokens live in the
		// vikunja_refresh_token cookie, not as a Bearer credential.
		const after = await apiContext.post('user/token/refresh', {
			headers: {Cookie: `vikunja_refresh_token=${rawToken}`},
		})
		expect(after.status()).toBe(401)
		await page.reload()
		await expect(page.locator('table.table tbody tr')).toHaveCount(1)
	})

	test('pages the session list and steps back after revoking the last row of a page', async ({
		authenticatedPage: page, currentUser, apiContext,
	}) => {
		const pageSize = await serverPageSize(apiContext)
		const oldest = `192.0.2.${pageSize}`
		await SessionFactory.create(pageSize, {
			user_id: currentUser.id,
			token_hash: (i: number) => hashSessionToken(`paging-${i}`),
			ip_address: (i: number) => `192.0.2.${i}`,
			last_active: (i: number) => new Date(Date.now() - i * 60_000).toISOString(),
		}, false)

		await gotoUserSettings(page, 'sessions')
		const rows = page.locator('table.table tbody tr')
		await expect(rows).toHaveCount(pageSize)
		await expect(page.locator('.tag.is-primary')).toContainText('Current')

		await page.getByRole('link', {name: 'Goto page 2'}).click()
		await expect(page).toHaveURL(/[?&]page=2/)
		await expect(rows).toHaveCount(1)
		await expect(rows).toContainText(oldest)

		await rows.getByRole('button', {name: 'Revoke'}).click()
		await page.locator('dialog[open] [data-cy="modalPrimary"]').click()
		await expect(page).not.toHaveURL(/[?&]page=2/)
		await expect(rows).toHaveCount(pageSize)
		await expect(page.getByRole('navigation', {name: 'pagination'})).toHaveCount(0)

		await page.reload()
		await expect(rows).toHaveCount(pageSize)
		await expect(page.locator('tr', {hasText: oldest})).toHaveCount(0)
	})

	test('current session cannot be deleted from the UI', async ({authenticatedPage: page}) => {
		await gotoUserSettings(page, 'sessions')
		const currentRow = page.locator('tr', {has: page.locator('.tag.is-primary')})
		await expect(currentRow.getByRole('button', {name: 'Revoke'})).toHaveCount(0)
	})

	test('names the device and keeps the dialog open when revoking fails', async ({
		authenticatedPage: page, currentUser,
	}) => {
		await SessionFactory.create(1, {
			user_id: currentUser.id,
			device_info: 'Firefox on Linux',
			ip_address: '192.0.2.5',
		}, false)
		await page.route(/\/user\/sessions\/[^/]+$/, route => route.request().method() === 'DELETE'
			? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Server error'})})
			: route.continue())

		await gotoUserSettings(page, 'sessions')
		await page.locator('tr', {hasText: '192.0.2.5'}).getByRole('button', {name: 'Revoke'}).click()
		const dialog = page.locator('dialog[open]')
		await expect(dialog).toContainText('Device: Firefox on Linux · IP address: 192.0.2.5')
		await expect(dialog.locator('[data-cy="modalPrimary"]')).toHaveText('Revoke session')
		await dialog.locator('[data-cy="modalPrimary"]').click()

		await expect(page.locator('.global-notification')).toBeVisible()
		await expect(dialog).toBeVisible()
		await expect(page.locator('table.table tbody tr')).toHaveCount(2)
	})
})
