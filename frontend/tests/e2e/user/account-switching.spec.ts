import {
	test,
	expect,
} from '../../support/fixtures'
import {UserFactory} from '../../factories/user'
import {ProjectFactory} from '../../factories/project'
import {updateUserSettings} from '../../support/updateUserSettings'
import {setupApiUrl} from '../../support/authenticateUser'
import {TEST_PASSWORD} from '../../support/constants'

// Runs against the isolated Mage API, not production. The API public URL must
// equal BASE_URL so the same-origin device-credential checks remain enabled.
for (const viewport of [
	{
		width: 1440,
		height: 1000,
		language: 'en',
	},
	{
		width: 390,
		height: 844,
		language: 'zh-CN',
	},
]) {
	test(`device accounts switch real cookies and private views at ${viewport.width}px`, async ({
		page,
		apiContext,
		userToken,
		currentUser,
	}, info) => {
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		const [secondUser] = await UserFactory.create(1, {
			id: 2,
			username: 'second-device-account',
			language: viewport.language,
		}, false)
		await ProjectFactory.create(1, {
			id: 101,
			owner_id: 1,
			title: 'First account private project',
		})
		await ProjectFactory.create(1, {
			id: 102,
			owner_id: 2,
			title: 'Second account private project',
		}, false)
		const zh = viewport.language === 'zh-CN'
		const labels = zh ? {
			title: '切换账号',
			remember: '记住当前账号',
			add: '添加另一个账号',
			login: '登录',
			remove: '移除并退出',
			all: '退出本设备的所有账号',
			current: '当前账号',
		} : {
			title: 'Switch account',
			remember: 'Remember this account',
			add: 'Add another account',
			login: 'Login',
			remove: 'Remove and sign out',
			all: 'Sign out all device accounts',
			current: 'Current',
		}
		async function openChooser() {
			await page.locator('[data-tour="account-menu"]').click()
			await page.getByRole('button', {name: labels.title, exact: true}).click()
			return page.getByRole('dialog', {name: labels.title})
		}
		// Seed the initial token once. authenticatedPage deliberately installs an
		// init script that would overwrite a later account selection on navigation.
		await setupApiUrl(page)
		await page.goto('/login')
		await page.evaluate(token => localStorage.setItem('token', token), userToken)
		await page.goto('/projects')
		await expect(page.locator('.project-overview').getByText('First account private project', {exact: true})).toBeVisible()
		let dialog = await openChooser()
		const surface = dialog.locator('.account-switcher__body')
		await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
		await dialog.locator('.account-switcher__close').click()
		await expect(dialog).toHaveCount(0)
		dialog = await openChooser()
		await dialog.getByRole('button', {name: labels.remember, exact: true}).click()
		await expect(dialog.locator('.account-switcher__accounts li')).toHaveCount(1)
		await dialog.getByRole('button', {name: labels.add, exact: true}).click()
		await expect(page).toHaveURL(/\/login\?addAccount=1/)
		await page.locator('#username').fill(secondUser.username)
		await page.locator('#password').fill(TEST_PASSWORD)
		await page.locator('#loginform').getByRole('button', {name: labels.login, exact: true}).click()
		await expect(page.locator('[data-tour="account-menu"]')).toContainText(secondUser.username)
		await page.goto('/projects')
		await expect(page.locator('.project-overview').getByText('Second account private project', {exact: true})).toBeVisible()
		await expect(page.locator('.project-overview').getByText('First account private project', {exact: true})).toHaveCount(0)

		// A second tab shares the selected identity; it must switch with this tab.
		const otherTab = await page.context().newPage()
		await setupApiUrl(otherTab)
		await otherTab.goto('/projects')
		await expect(otherTab.locator('[data-tour="account-menu"]')).toContainText(secondUser.username)
		await expect(otherTab.locator('.project-overview').getByText('Second account private project', {exact: true})).toBeVisible()
		dialog = await openChooser()
		await expect(dialog.locator('.account-switcher__accounts li')).toHaveCount(2)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await dialog.screenshot({path: info.outputPath(`account-switcher-${viewport.width}.png`)})
		await dialog.locator('.account-switcher__select').filter({hasText: currentUser.username}).click()
		await expect(page.locator('[data-tour="account-menu"]')).toContainText(currentUser.username)
		await expect(otherTab.locator('[data-tour="account-menu"]')).toContainText(currentUser.username)
		for (const currentPage of [page, otherTab]) {
			await currentPage.goto('/projects')
			await expect(currentPage.locator('.project-overview').getByText('First account private project', {exact: true})).toBeVisible()
			await expect(currentPage.locator('.project-overview').getByText('Second account private project', {exact: true})).toHaveCount(0)
		}

		// The current refresh token and both legacy path cookies must match the
		// selected SID. JavaScript sees neither those cookies nor the device key.
		const refreshed = await page.evaluate(async () => {
			const api = `${window.API_URL.replace(/\/api\/v[12]$/, '').replace(/\/$/, '')}/api/v2`
			const result = await fetch(`${api}/user/token/refresh`, {method: 'POST', credentials: 'include'})
			return {status: result.status, body: await result.json(), jsCookies: document.cookie}
		})
		expect(refreshed.status).toBe(200)
		const claims = JSON.parse(Buffer.from(refreshed.body.token.split('.')[1], 'base64url').toString())
		expect(claims.id).toBe(currentUser.id)
		expect(refreshed.jsCookies).not.toContain('aster_device_accounts')
		expect(refreshed.jsCookies).not.toContain('vikunja_refresh_token')
		// Keep the short JWT in sync after this explicit transport check.
		await page.evaluate(token => localStorage.setItem('token', token), refreshed.body.token)
		dialog = await openChooser()
		const second = dialog.locator('.account-switcher__accounts li').filter({hasText: secondUser.username})
		await second.locator('.account-switcher__remove').click()
		await expect(second.getByText(zh ? /要让.*退出这台设备吗/ : /Sign .* out of this device/)).toBeVisible()
		await second.getByRole('button', {name: labels.remove, exact: true}).click()
		await expect(dialog.locator('.account-switcher__accounts li')).toHaveCount(1)
		await dialog.getByRole('button', {name: labels.all, exact: true}).click()
		await dialog.locator('.account-switcher__confirmation').getByRole('button', {name: labels.all, exact: true}).click()
		await expect(page).toHaveURL(/\/login/)
		await expect(otherTab).toHaveURL(/\/login/)
		await expect(page.locator('.account-switcher__accounts li')).toHaveCount(0)
		await otherTab.close()
		await page.goto('about:blank')
	})
}
