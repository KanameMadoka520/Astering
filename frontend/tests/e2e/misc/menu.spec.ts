import {test, expect} from '../../support/fixtures'

const iPhone8 = {width: 375, height: 667}

test.describe('The Menu', () => {
	test.beforeEach(async ({authenticatedPage: page}) => {
		await page.goto('/')
	})

	test('Is visible by default on desktop', async ({authenticatedPage: page}) => {
		await expect(page.locator('.menu-container')).toHaveClass(/is-active/)
	})

	test('Can be hidden on desktop', async ({authenticatedPage: page}) => {
		await page.locator('button.menu-show-button:visible').click()
		await expect(page.locator('.menu-container')).not.toHaveClass(/is-active/)
	})

	test('Can be toggled with keyboard shortcut on desktop', async ({authenticatedPage: page}) => {
		await expect(page.locator('.menu-container')).toHaveClass(/is-active/)
		await page.locator('body').click()

		await page.locator('body').press('ControlOrMeta+e')
		await expect(page.locator('.menu-container')).not.toHaveClass(/is-active/)

		await page.locator('body').press('ControlOrMeta+e')
		await expect(page.locator('.menu-container')).toHaveClass(/is-active/)
	})

	test('Is hidden by default on mobile', async ({authenticatedPage: page}) => {
		await page.setViewportSize(iPhone8)
		await expect(page.locator('.menu-container')).not.toHaveClass(/is-active/)
	})

	test('Is can be shown on mobile', async ({authenticatedPage: page}) => {
		await page.setViewportSize(iPhone8)
		await page.locator('button.menu-show-button:visible').click()
		await expect(page.locator('.menu-container')).toHaveClass(/is-active/)
	})

	test('Moves focus to the new page when a link in the mobile drawer is followed', async ({authenticatedPage: page}) => {
		await page.setViewportSize(iPhone8)
		await page.locator('button.menu-show-button:visible').click()
		await expect(page.locator('.menu-container')).toHaveClass(/is-active/)

		await page.locator('.menu-container .top-menu a[href="/tasks/by/upcoming"]').press('Enter')
		await expect(page).toHaveURL(/\/tasks\/by\/upcoming/)
		await expect(page.locator('.menu-container')).not.toHaveClass(/is-active/)
		await expect(page.locator('#main-content')).toBeFocused()
	})

	test('Says the projects could not be loaded instead of showing none', async ({authenticatedPage: page}) => {
		await page.route(/\/api\/v2\/projects(\?.*)?$/, route => route.request().method() === 'GET'
			? route.fulfill({status: 500, json: {message: 'Server error'}})
			: route.continue())
		await page.reload()

		await expect(page.locator('.menu-container .menu-load-error')).toContainText('Your projects couldn\'t be loaded.')
	})
})
