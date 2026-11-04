import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {updateUserSettings} from '../../support/updateUserSettings'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
// The Mage test process receives ASTERING_USAGE_ADMIN_IDS=1. No production grant is used here.
for (const viewport of [{width: 1440, height: 1000, language: 'en'}, {width: 390, height: 844, language: 'zh-CN'}]) {
	test(`site usage real read-only snapshot at ${viewport.width}px`, async ({authenticatedPage: page, apiContext, userToken}, info) => {
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		await ProjectFactory.create(3, {owner_id: 1})
		await TaskFactory.create(2, {project_id: 1, created_by_id: 1})
		await page.goto('/user/settings/usage')
		await expect(page.locator('.usage-overview')).toBeVisible()
		await expect(page.locator('.usage-account')).toHaveCount(1)
		const row = page.locator('.usage-account')
		await expect(row.locator('.usage-primary dd').first()).toHaveText('3')
		await expect(row.locator('.usage-primary dd').nth(1)).toHaveText('2')
		await row.locator('summary').click()
		await expect(row.locator('.usage-details dl')).toBeVisible()
		const label = viewport.language === 'en' ? 'Find an account' : '查找账户'
		const search = page.getByRole('searchbox', {name: label})
		await search.fill('no-matching-fixture-account')
		await expect(page.locator('.usage-empty')).toBeVisible()
		await expect(search).toBeFocused()
		await search.fill('')
		await expect(row).toBeVisible()
		const response = await apiContext.get(`${api}/system/usage/users`, {headers: {Authorization: `Bearer ${userToken}`}})
		expect(response.ok()).toBe(true)
		expect(response.headers()['cache-control']).toContain('no-store')
		const body = await response.json()
		expect(body.items[0].projects_owned).toBe(3)
		for (const field of ['email', 'password', 'mcp_servers', 'connections']) expect(body.items[0]).not.toHaveProperty(field)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`site-usage-${viewport.width}.png`), fullPage: true})
	})
}

test('revoked usage access hides the private snapshot and link', async ({authenticatedPage: page}) => {
	await page.goto('/user/settings/usage')
	await expect(page.locator('.usage-overview')).toBeVisible()
	await page.route('**/api/v2/system/usage/access', route => route.fulfill({json: {can_view_usage: false}}))
	await page.getByRole('button', {name: 'Refresh snapshot', exact: true}).click()
	await expect(page.getByRole('alert')).toContainText('You do not have permission')
	await expect(page.locator('.usage-account')).toHaveCount(0)
	await expect(page.getByRole('link', {name: 'Site usage', exact: true})).toHaveCount(0)
})

test('failed usage refresh hides prior private rows and can recover', async ({authenticatedPage: page}) => {
	await page.goto('/user/settings/usage')
	await expect(page.locator('.usage-overview')).toBeVisible()
	let fail = true
	await page.route('**/api/v2/system/usage/users?**', async route => {
		if (fail) return route.fulfill({status: 403, json: {detail: 'Forbidden', status: 403}})
		await route.continue()
	})
	await page.getByRole('button', {name: 'Refresh snapshot', exact: true}).click()
	await expect(page.getByRole('alert')).toContainText('has been hidden')
	await expect(page.locator('.usage-account')).toHaveCount(0)
	fail = false
	await page.getByRole('button', {name: 'Refresh snapshot', exact: true}).click()
	await expect(page.locator('.usage-overview')).toBeVisible()
})
