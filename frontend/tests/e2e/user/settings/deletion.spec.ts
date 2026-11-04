import {test, expect} from '../../../support/fixtures'
import {gotoUserSettings} from '../../../support/userSettings'
import {TEST_PASSWORD} from '../../../support/constants'
import {TokenFactory} from '../../../factories/token'

test.describe('Account deletion', () => {
	test('lists what deleting the account removes and what to save first', async ({authenticatedPage: page}) => {
		await gotoUserSettings(page, 'deletion')
		await expect(page.locator('.deletion-card')).toContainText('your private Compass spaces')
		await expect(page.locator('.deletion-card')).toContainText('Team Compass spaces stay with their team.')
		await expect(page.locator('.deletion-card')).toContainText('download Drive files from Drive')
	})

	test('blocks deletion request with no password', async ({authenticatedPage: page}) => {
		await gotoUserSettings(page, 'deletion')
		await page.locator('.card .button.is-danger').click()
		await expect(page.locator('.help.is-danger')).toContainText(/password/i)
	})

	test('schedules deletion with correct password', async ({authenticatedPage: page}) => {
		await gotoUserSettings(page, 'deletion')
		await page.locator('#currentPasswordAccountDelete').fill(TEST_PASSWORD)

		const resp = page.waitForResponse(r => r.url().includes('/user/deletion/request'))
		await page.locator('.card .button.is-danger').click()
		const r = await resp
		expect(r.ok()).toBe(true)
		await expect(page.locator('.global-notification .vue-notification.success')).toBeVisible()
	})

	test('cancels a scheduled deletion', async ({
		authenticatedPage: page, currentUser, userToken, apiContext,
	}) => {
		const deletionToken = 'fixed-account-deletion-token-1234567890123456'
		// kind=3 is TokenAccountDeletion (see pkg/user/token.go)
		await TokenFactory.create(1, {
			user_id: currentUser.id,
			kind: 3,
			token: deletionToken,
		}, false)

		await page.goto(`/user/settings/deletion?accountDeletionConfirm=${deletionToken}`)
		// Scheduled-state copy: "We will delete your Astering account on <date> (in …)."
		// The date itself is absolute, with a year; only the parentheses say how far away it is.
		const scheduled = /we will delete your Astering account on [^()]*\b\d{4}\b[^()]* \(in [^)]+\)/i
		await expect(page.locator('.card')).toContainText(scheduled)
		await expect(page.locator('.card')).not.toContainText(/account on in /i)
		await expect(page).not.toHaveURL(/accountDeletionConfirm/)

		// The home page shows the same notice.
		await page.goto('/')
		await expect(page.locator('.workspace-notice')).toContainText(scheduled)
		await expect(page.locator('.workspace-notice')).not.toContainText(/account on in /i)
		await page.goto('/user/settings/deletion')

		await page.locator('#currentPasswordAccountDelete').fill(TEST_PASSWORD)
		const cancel = page.waitForResponse(r => r.url().includes('/user/deletion/cancel'))
		await page.getByRole('button', {name: /cancel the deletion/i}).click()
		await cancel

		await expect(page.locator('.global-notification .vue-notification.success').filter({hasText: 'We will not delete'})).toBeVisible()
		// And the non-scheduled branch (the "Delete account" form) reappears.
		await expect(page.locator('.card .button.is-danger')).toBeVisible()
		await page.reload()
		await expect(page.locator('.card .button.is-danger')).toBeVisible()
		const account = await apiContext.get('user', {headers: {Authorization: `Bearer ${userToken}`}})
		expect((await account.json()).deletion_scheduled_at).toMatch(/^0001-/)
	})
})
