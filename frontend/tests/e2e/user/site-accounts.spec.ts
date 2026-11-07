import {test, expect} from '../../support/fixtures'
import {UserFactory} from '../../factories/user'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {login} from '../../support/authenticateUser'
import {updateUserSettings} from '../../support/updateUserSettings'
import {apiRootUrl} from '../../support/apiUrl'
import {TEST_PASSWORD} from '../../support/constants'
import {Factory} from '../../support/factory'

class AccountAdminEventFactory extends Factory {
	static table = 'account_admin_events'
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(release => { resolve = release })
	return {
		promise,
		resolve,
	}
}

async function seedAudit() {
	await AccountAdminEventFactory.create(26, {
		id: (i: number) => i,
		actor_id: 1,
		actor_username: 'Super administrator',
		target_id: 2,
		target_username: 'managed-member',
		action: 'access_revoked',
		old_status: 0,
		new_status: 0,
		revoked_sessions: 0,
		revoked_api_tokens: 0,
		reason: (i: number) => `Audit review ${i}`,
		created: '2026-11-07T00:00:00Z',
	})
}

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
// Isolated Mage process receives ASTERING_SUPERADMIN_IDS=1. No license or production grant is used.
for (const viewport of [{width: 1440, height: 1000, language: 'en'}, {width: 390, height: 844, language: 'zh-CN'}]) {
	test(`account management persists and protects private content at ${viewport.width}px`, async ({authenticatedPage: page, apiContext, userToken}, info) => {
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		const [member] = await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
		await ProjectFactory.create(1, {id: 8, owner_id: 2, title: 'Unshared member project'}, false)
		await TaskFactory.create(1, {id: 9, project_id: 8, created_by_id: 2, title: 'Unshared task'}, false)
		const {token: oldToken} = await login(null, apiContext, member)
		await page.goto('/user/settings/accounts')
		await expect(page.locator('.usage-overview')).toBeVisible()
		const row = page.locator('.usage-account').filter({hasText: 'managed-member'})
		await expect(row).toBeVisible()
		await expect(row.locator('.usage-primary dd').first()).toHaveText('1')
		await expect(page.locator('.usage-account').filter({hasText: '#1'}).locator('.account-actions')).toHaveCount(0)
		await expect(page.getByText('Unshared member project', {exact: true})).toHaveCount(0)
		const labels = viewport.language === 'en'
			? {disable: 'Disable account', enable: 'Enable account', revoke: 'Revoke access', confirm: 'Confirm account username', audit: 'Management activity'}
			: {disable: '停用账户', enable: '启用账户', revoke: '撤销访问凭据', confirm: '确认账户用户名', audit: '管理操作记录'}
		await row.getByRole('button', {name: labels.disable, exact: true}).click()
		let dialog = page.getByRole('dialog')
		await expect(dialog.getByRole('button', {name: labels.disable, exact: true})).toBeDisabled()
		await dialog.getByRole('textbox', {name: labels.confirm}).fill('wrong-account')
		await expect(dialog.getByRole('button', {name: labels.disable, exact: true})).toBeDisabled()
		await dialog.getByRole('textbox', {name: labels.confirm}).fill('managed-member')
		await dialog.locator('textarea').fill('E2E access review')
		if (viewport.width === 390) {
			await page.setViewportSize({width: viewport.width, height: 480})
			const confirm = dialog.getByRole('button', {name: labels.disable, exact: true})
			const cancel = dialog.getByRole('button', {name: '取消', exact: true})
			for (const button of [confirm, cancel]) {
				await button.scrollIntoViewIfNeeded()
				await expect(button).toBeInViewport()
				await button.click({trial: true})
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.setViewportSize(viewport)
			await dialog.locator('h2').scrollIntoViewIfNeeded()
		}
		const surface = await dialog.locator('.account-confirm').evaluate(element => {
			const style = getComputedStyle(element)
			const canvas = document.createElement('canvas')
			canvas.width = canvas.height = 1
			const context = canvas.getContext('2d')!
			function color(value: string) {
				context.clearRect(0, 0, 1, 1)
				context.fillStyle = value
				context.fillRect(0, 0, 1, 1)
				return Array.from(context.getImageData(0, 0, 1, 1).data)
			}
			function luminance(rgb: number[]) {
				const linear = rgb.slice(0, 3).map(value => {
					const channel = value / 255
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
				})
				return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
			}
			const background = color(style.backgroundColor)
			const text = color(style.color)
			const levels = [luminance(background), luminance(text)].sort((a, b) => a - b)
			const bounds = element.getBoundingClientRect()
			return {
				backgroundAlpha: background[3],
				contrast: (levels[1] + 0.05) / (levels[0] + 0.05),
				left: bounds.left,
				right: bounds.right,
				width: bounds.width,
				viewportWidth: innerWidth,
				contentFits: element.scrollWidth <= element.clientWidth,
			}
		})
		expect(surface.backgroundAlpha).toBe(255)
		expect(surface.contrast).toBeGreaterThanOrEqual(4.5)
		expect(surface.left).toBeGreaterThanOrEqual(0)
		expect(surface.right).toBeLessThanOrEqual(surface.viewportWidth)
		expect(surface.width).toBeLessThanOrEqual(512)
		expect(surface.contentFits).toBe(true)
		await dialog.screenshot({path: info.outputPath(`site-account-disable-dialog-${viewport.width}.png`)})
		const disabled = page.waitForResponse(response => response.url().endsWith('/system/accounts/2/status') && response.request().method() === 'POST')
		await dialog.getByRole('button', {name: labels.disable, exact: true}).click()
		expect((await disabled).ok()).toBe(true)
		await expect(dialog).toHaveCount(0)
		await expect.poll(() => page.evaluate(() => {
			const active = document.activeElement
			return Boolean(active?.matches('.accounts-page .usage-search input, [data-managed-account="2"] button'))
		})).toBe(true)
		await page.reload()
		await expect(row.getByRole('button', {name: labels.enable, exact: true})).toBeVisible()
		const rejected = await apiContext.get(`${api}/user`, {headers: {Authorization: `Bearer ${oldToken}`}})
		expect(rejected.ok()).toBe(false)
		const deniedLogin = await apiContext.post(`${api}/login`, {data: {username: member.username, password: TEST_PASSWORD}})
		expect(deniedLogin.ok()).toBe(false)
		await row.getByRole('button', {name: labels.enable, exact: true}).click()
		dialog = page.getByRole('dialog')
		await dialog.getByRole('textbox', {name: labels.confirm}).fill('managed-member')
		await dialog.getByRole('button', {name: labels.enable, exact: true}).click()
		await expect(dialog).toHaveCount(0)
		const freshLogin = await apiContext.post(`${api}/login`, {data: {username: member.username, password: TEST_PASSWORD}})
		expect(freshLogin.ok()).toBe(true)
		const freshToken = (await freshLogin.json()).token
		const restoredProject = await apiContext.get(`${api}/projects/8`, {headers: {Authorization: `Bearer ${freshToken}`}})
		expect(restoredProject.ok()).toBe(true)
		expect((await restoredProject.json()).title).toBe('Unshared member project')
		const unshared = await apiContext.get(`${api}/projects/8`, {headers: {Authorization: `Bearer ${userToken}`}})
		expect(unshared.status()).toBe(403)
		await row.getByRole('button', {name: labels.revoke, exact: true}).click()
		dialog = page.getByRole('dialog')
		await dialog.getByRole('textbox', {name: labels.confirm}).fill('managed-member')
		await dialog.getByRole('button', {name: labels.revoke, exact: true}).click()
		await expect(dialog).toHaveCount(0)
		const stale = await apiContext.get(`${api}/user`, {headers: {Authorization: `Bearer ${freshToken}`}})
		expect(stale.ok()).toBe(false)
		await page.getByRole('button', {name: labels.audit, exact: true}).click()
		await expect(page.locator('.account-events li')).toHaveCount(3)
		await expect(page.locator('.account-events')).toContainText('E2E access review')
		const stored = await apiContext.get(`${api}/system/accounts`, {headers: {Authorization: `Bearer ${userToken}`}})
		expect(stored.ok()).toBe(true)
		expect(stored.headers()['cache-control']).toContain('no-store')
		const snapshot = await stored.json()
		const target = snapshot.items.find((account: {id: number}) => account.id === 2)
		expect(target).toMatchObject({status: 0, sessions: 0, projects_owned: 1})
		for (const field of ['email', 'password', 'mcp_servers', 'connections']) expect(target).not.toHaveProperty(field)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`site-accounts-${viewport.width}.png`), fullPage: true})
	})
}

test('ordinary accounts cannot read management data or see its settings link', async ({page, apiContext}) => {
	const [ordinary] = await UserFactory.create(1, {id: 2, username: 'ordinary-member'})
	const {token} = await login(page, apiContext, ordinary)
	await page.goto('/user/settings/accounts')
	await expect(page.getByRole('alert')).toContainText('super administrator')
	await expect(page.locator('.usage-account')).toHaveCount(0)
	await expect(page.getByRole('link', {name: 'Account management', exact: true})).toHaveCount(0)
	const response = await apiContext.get(`${api}/system/accounts`, {headers: {Authorization: `Bearer ${token}`}})
	const mutation = await apiContext.post(`${api}/system/accounts/1/status`, {
		headers: {Authorization: `Bearer ${token}`},
		data: {status: 2, expected_status: 0, confirm_username: 'not-authorized'},
	})
	expect(response.status()).toBe(403)
	expect(mutation.status()).toBe(403)
})

test('management errors keep confirmation for retry and a failed refresh hides private rows', async ({authenticatedPage: page}) => {
	await UserFactory.create(1, {id: 2, username: 'retry-member'}, false)
	await page.goto('/user/settings/accounts')
	const row = page.locator('.usage-account').filter({hasText: 'retry-member'})
	await row.getByRole('button', {name: 'Disable account', exact: true}).click()
	let fail = true
	await page.route('**/api/v2/system/accounts/2/status', async route => {
		if (fail) return route.fulfill({status: 409, json: {status: 409, detail: 'account_status_changed'}})
		await route.continue()
	})
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('textbox', {name: 'Confirm account username'}).fill('retry-member')
	await dialog.getByRole('button', {name: 'Disable account', exact: true}).click()
	await expect(dialog.getByRole('alert')).toContainText('account changed')
	await expect(dialog.getByRole('textbox', {name: 'Confirm account username'})).toHaveValue('retry-member')
	fail = false
	await dialog.getByRole('button', {name: 'Disable account', exact: true}).click()
	await expect(dialog).toHaveCount(0)
	await page.route('**/api/v2/system/accounts?**', route => route.fulfill({status: 500, json: {status: 500, detail: 'Server unavailable'}}))
	await page.getByRole('button', {name: 'Refresh snapshot', exact: true}).click()
	await expect(page.getByRole('alert')).toContainText('has been hidden')
	await expect(page.locator('.usage-account')).toHaveCount(0)
})

for (const scenario of [
	{
		width: 1440,
		height: 1000,
		language: 'en',
		theme: 'dark',
		disable: 'Disable account',
		enable: 'Enable account',
		confirm: 'Confirm account username',
	},
	{
		width: 390,
		height: 844,
		language: 'zh-CN',
		theme: 'starlight',
		disable: '停用账户',
		enable: '启用账户',
		confirm: '确认账户用户名',
	},
]) {
	test(`a confirmed account change stays usable during a stalled refresh at ${scenario.width}px`, async ({authenticatedPage: page, apiContext, userToken}, info) => {
		await page.setViewportSize({width: scenario.width, height: scenario.height})
		await updateUserSettings(apiContext, userToken, {
			language: scenario.language,
			frontend_settings: {color_schema: scenario.theme},
		})
		await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
		await page.goto('/user/settings/accounts')
		const row = page.locator('.usage-account').filter({hasText: 'managed-member'})
		await row.getByRole('button', {name: scenario.disable, exact: true}).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('textbox', {name: scenario.confirm}).fill('managed-member')
		await dialog.screenshot({path: info.outputPath(`account-confirm-${scenario.theme}-${scenario.width}.png`)})
		const stalled = deferred()
		const release = deferred()
		await page.route('**/api/v2/system/accounts?**', async route => {
			stalled.resolve()
			await release.promise
			await route.continue()
		})
		try {
			const saved = page.waitForResponse(response => response.url().endsWith('/system/accounts/2/status')
				&& response.request().method() === 'POST')
			await dialog.getByRole('button', {name: scenario.disable, exact: true}).click()
			expect((await saved).status()).toBe(200)
			await stalled.promise
			await expect(dialog).toHaveCount(0)
			await expect(page.locator('.message.success')).toContainText(scenario.language === 'en' ? 'completed' : '已为')
			await expect(page.locator('.usage-account')).toHaveCount(0)
			await expect(page.locator('.usage-search input')).toBeFocused()
			const stored = await apiContext.get(`${api}/system/accounts`, {headers: {Authorization: `Bearer ${userToken}`}})
			expect(stored.status()).toBe(200)
			expect((await stored.json()).items.find((account: {id: number}) => account.id === 2).status).toBe(2)
			await page.screenshot({path: info.outputPath(`account-confirmed-refresh-pending-${scenario.width}.png`)})
		} finally {
			release.resolve()
		}
		await expect(row.getByRole('button', {name: scenario.enable, exact: true})).toBeVisible()
		await page.reload()
		await expect(row.getByRole('button', {name: scenario.enable, exact: true})).toBeVisible()
	})
}

test('keyboard confirmation retains focus after a delayed rejection and a background permission recheck', async ({authenticatedPage: page}) => {
	await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
	await page.goto('/user/settings/accounts')
	await page.locator('[data-managed-account="2"]').getByRole('button', {name: 'Disable account', exact: true}).click()
	const dialog = page.getByRole('dialog')
	const confirmation = dialog.getByRole('textbox', {name: 'Confirm account username'})
	await confirmation.fill('managed-member')
	const started = deferred()
	const reject = deferred()
	let posts = 0
	await page.route('**/api/v2/system/accounts/2/status', async route => {
		posts++
		started.resolve()
		await reject.promise
		await route.fulfill({status: 409, json: {status: 409, detail: 'account_status_changed'}})
	})
	try {
		await confirmation.press('Enter')
		await started.promise
		await expect(confirmation).toBeFocused()
		await expect(confirmation).toHaveAttribute('readonly', '')
		await expect(dialog.getByRole('button', {name: 'Disable account', exact: true})).toBeDisabled()
		await confirmation.press('Enter')
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(1)
		expect(posts).toBe(1)
	} finally {
		reject.resolve()
	}
	await expect(dialog.getByRole('alert')).toContainText('account changed')
	await expect(confirmation).toBeFocused()
	const reason = dialog.locator('textarea')
	await reason.fill('Keep this reason and caret')
	await reason.evaluate(element => element.setSelectionRange(2, 6))
	const accessStarted = deferred()
	const accessRelease = deferred()
	await page.route('**/api/v2/system/accounts/access', async route => {
		accessStarted.resolve()
		await accessRelease.promise
		await route.continue()
	})
	try {
		await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
		await accessStarted.promise
		await expect(dialog).toHaveCount(1)
		await expect(reason).toBeFocused()
		expect(await reason.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([2, 6])
		await expect(dialog.getByRole('button', {name: 'Disable account', exact: true})).toBeDisabled()
	} finally {
		accessRelease.resolve()
	}
	await expect(dialog.getByRole('button', {name: 'Disable account', exact: true})).toBeEnabled()
	await expect(reason).toBeFocused()
	await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
})

test('audit pagination keeps keyboard focus while its next page loads and at the last page', async ({authenticatedPage: page}) => {
	await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
	await seedAudit()
	await page.goto('/user/settings/accounts')
	await page.getByRole('button', {name: 'Management activity', exact: true}).click()
	await expect(page.locator('.account-events li')).toHaveCount(25)
	const next = page.locator('.account-event-pages').getByRole('button', {name: 'Next', exact: true})
	const started = deferred()
	const release = deferred()
	await page.route('**/api/v2/system/accounts/events?**', async route => {
		if (new URL(route.request().url()).searchParams.get('page') !== '2') return route.continue()
		started.resolve()
		await release.promise
		await route.continue()
	})
	try {
		await next.focus()
		await next.press('Enter')
		await started.promise
		await expect(next).toBeFocused()
		await expect(next).toBeDisabled()
		await expect(page.locator('.account-events')).toHaveCount(0)
	} finally {
		release.resolve()
	}
	await expect(page.locator('.account-events li')).toHaveCount(1)
	await expect(page.locator('.account-events')).toContainText('Audit review 1')
	await expect(next).toBeFocused()
	await expect(next).toHaveAttribute('aria-disabled', 'true')
	await expect(next).not.toHaveAttribute('disabled')
	await page.locator('.account-event-pages').getByRole('button', {name: 'Previous', exact: true}).press('Enter')
	await expect(page.locator('.account-events li')).toHaveCount(25)
})

test('a list denial clears the open confirmation and previously loaded audit', async ({authenticatedPage: page}) => {
	await page.clock.install()
	await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
	await seedAudit()
	await page.goto('/user/settings/accounts')
	await page.getByRole('button', {name: 'Management activity', exact: true}).click()
	await expect(page.locator('.account-events li')).toHaveCount(25)
	await page.locator('[data-managed-account="2"]').getByRole('button', {name: 'Disable account', exact: true}).click()
	await expect(page.getByRole('dialog')).toHaveCount(1)
	await page.route('**/api/v2/system/accounts?**', route => route.fulfill({status: 403, json: {status: 403, detail: 'Forbidden'}}))
	await page.clock.fastForward(60_001)
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(page.locator('.usage-account, .account-audit, .message.success')).toHaveCount(0)
	await expect(page.getByRole('alert')).toContainText('super administrator')
})

test('an audit denial clears prior success and account data without reviving it from cache', async ({authenticatedPage: page}) => {
	await UserFactory.create(1, {id: 2, username: 'managed-member'}, false)
	await seedAudit()
	await page.goto('/user/settings/accounts')
	await page.locator('[data-managed-account="2"]').getByRole('button', {name: 'Revoke access', exact: true}).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('textbox', {name: 'Confirm account username'}).fill('managed-member')
	await dialog.getByRole('button', {name: 'Revoke access', exact: true}).click()
	await expect(dialog).toHaveCount(0)
	await expect(page.locator('.message.success')).toContainText('completed')
	await page.getByRole('button', {name: 'Management activity', exact: true}).click()
	await expect(page.locator('.account-events li')).toHaveCount(25)
	await page.route('**/api/v2/system/accounts/events?**', route => route.fulfill({status: 403, json: {status: 403, detail: 'Forbidden'}}))
	await page.locator('.account-event-pages').getByRole('button', {name: 'Next', exact: true}).click()
	await expect(page.locator('.usage-account, .account-audit, .message.success')).toHaveCount(0)
	await expect(page.getByRole('alert')).toContainText('super administrator')
})
