import type {Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {UserFactory} from '../../factories/user'
import {setupApiUrl} from '../../support/authenticateUser'
import {TEST_PASSWORD} from '../../support/constants'

const variants = [
	{
		language: 'en',
		subtitle: 'Aster’s AI-integrated industrial system',
	},
	{
		language: 'zh-CN',
		subtitle: 'Aster的AI集成工业系统',
	},
]

async function expectBrand(page: Page, brand: Locator, subtitle: string) {
	await expect(brand).toBeVisible()
	await expect(brand.locator('.logo')).toHaveAttribute('aria-label', 'vikunja-x')
	await expect(brand.locator('.brand-subtitle')).toHaveText(subtitle)
	const [bounds, text] = await Promise.all([
		brand.boundingBox(),
		brand.locator('.brand-subtitle').boundingBox(),
	])
	expect(bounds).not.toBeNull()
	expect(text).not.toBeNull()
	expect(text!.x).toBeGreaterThanOrEqual(bounds!.x - 1)
	expect(text!.x + text!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const variant of variants) {
	for (const width of [1440, 320]) {
		test.describe(`Brand identity ${variant.language} ${width}px`, () => {
			test.use({
				locale: variant.language,
				viewport: {
					width,
					height: 844,
				},
			})

			test('shows the shared brand subtitle on login and the main navigation', async ({page}) => {
				const [user] = await UserFactory.create(1, {language: variant.language})
				await setupApiUrl(page)
				await page.goto('/login')
				await expectBrand(page, page.locator('.noauth-logo'), variant.subtitle)
				await page.locator('#username').fill(user.username)
				await page.locator('#password').fill(TEST_PASSWORD)
				await page.locator('#loginform .login-submit').click()
				await expect(page).toHaveURL('/')
				if (width < 768) {
					await page.locator('button.menu-show-button:visible').click()
					await expectBrand(page, page.locator('.menu-header .brand-logo'), variant.subtitle)
				} else {
					const brand = page.locator('.navbar .brand-logo')
					await expectBrand(page, brand, variant.subtitle)
					const [header, bounds] = await Promise.all([
						page.locator('.navbar').boundingBox(),
						brand.boundingBox(),
					])
					expect(bounds!.y).toBeGreaterThanOrEqual(header!.y - 1)
					expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(header!.y + header!.height + 1)
				}
			})
		})
	}
}
