import {readFile} from 'node:fs/promises'
import type {APIRequestContext, Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {updateUserSettings} from '../../support/updateUserSettings'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {createDefaultViews} from '../project/prepareProjects'
import {createCompassSpace} from '../compass/compassApi'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
const cacheKey = 'vikunja-color-scheme'

async function storedScheme(request: APIRequestContext, token: string) {
	const response = await request.get(`${api}/user`, {headers: {Authorization: `Bearer ${token}`}})
	expect(response.ok()).toBe(true)
	return (await response.json()).settings.frontend_settings.color_schema
}

async function saveScheme(page: Page, value: string, label: string) {
	await page.getByRole('combobox', {name: label, exact: true}).selectOption(value)
	const written = page.waitForResponse(response => response.request().method() === 'PATCH'
		&& new URL(response.url()).pathname === '/api/v2/user/settings/general')
	await page.locator('[data-cy="saveGeneralSettings"]').click()
	expect((await written).ok()).toBe(true)
}

async function expectSolidReadable(surface: Locator) {
	await expect(surface).toBeVisible()
	await expect(surface).toHaveCSS('opacity', '1')
	const paint = await surface.evaluate(element => {
		const style = getComputedStyle(element)
		const canvas = document.createElement('canvas')
		canvas.width = canvas.height = 1
		const context = canvas.getContext('2d')!
		const rgba = (color: string) => {
			context.clearRect(0, 0, 1, 1)
			context.fillStyle = color
			context.fillRect(0, 0, 1, 1)
			return Array.from(context.getImageData(0, 0, 1, 1).data)
		}
		const background = rgba(style.backgroundColor)
		const foreground = rgba(style.color)
		const luminance = (color: number[]) => {
			const [red, green, blue] = color.map(value => {
				const channel = value / 255
				return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
			})
			return .2126 * red + .7152 * green + .0722 * blue
		}
		const levels = [luminance(background), luminance(foreground)].sort((a, b) => a - b)
		return {
			alpha: background[3],
			contrast: (levels[1] + .05) / (levels[0] + .05),
		}
	})
	expect(paint.alpha, 'Reading surfaces remain opaque').toBe(255)
	expect(paint.contrast, 'Normal text remains readable').toBeGreaterThanOrEqual(4.5)
}

for (const viewport of [
	{width: 1440, height: 1000, language: 'en', label: 'Color Scheme'},
	{width: 390, height: 844, language: 'zh-CN', label: '配色方案'},
]) {
	test(`Starlight saves, reloads and stays readable across the app at ${viewport.width}px`, async ({
		authenticatedPage: page, apiContext, userToken,
	}, testInfo) => {
		test.setTimeout(120_000)
		await page.setViewportSize({width: viewport.width, height: viewport.height})
		await page.emulateMedia({colorScheme: 'light', reducedMotion: 'reduce'})
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		await ProjectFactory.create(1, {id: 1, title: 'Night work'})
		await createDefaultViews(1)
		await BucketFactory.create(1, {id: 1, title: 'Active', project_view_id: 4})
		await TaskFactory.create(1, {id: 1, title: 'Starlight review', project_id: 1})
		await TaskBucketFactory.create(1, {task_id: 1, bucket_id: 1, project_view_id: 4})
		await page.goto('/user/settings/general')
		const scheme = page.getByRole('combobox', {name: viewport.label, exact: true})
		await expect(scheme).toBeVisible()
		await scheme.selectOption('starlight')
		await expect(page.locator('html')).not.toHaveClass(/theme-starlight/)
		await expect(scheme).toHaveAccessibleDescription(viewport.language === 'en'
			? 'A dark sky with quiet, static stars. Your project and Compass backgrounds stay in front.'
			: '深色夜空与静谧的星点，没有动态效果。项目和星图自定义背景仍优先显示。')
		await saveScheme(page, 'starlight', viewport.label)
		expect(await storedScheme(apiContext, userToken)).toBe('starlight')
		await page.reload()
		await expect(scheme).toHaveValue('starlight')
		await expect(page.locator('html')).toHaveClass(/dark.*theme-starlight|theme-starlight.*dark/)
		await expect(page.locator('body')).toHaveCSS('background-image', /url\(/)
		await expectSolidReadable(page.locator('.general-settings').first())
		await page.screenshot({path: testInfo.outputPath('starlight-settings.png'), fullPage: true})

		await page.goto('/')
		await expect(page.locator('.workspace')).toBeVisible()
		await page.screenshot({path: testInfo.outputPath('starlight-workspace.png'), fullPage: true})
		await page.goto('/projects/1/4')
		const card = page.locator('.kanban-card').filter({hasText: 'Starlight review'})
		await expect(card).toBeVisible()
		await expectSolidReadable(card)
		await page.screenshot({path: testInfo.outputPath('starlight-board.png'), fullPage: true})
		await page.goto('/projects/1/3')
		await expect(page.getByRole('table')).toContainText('Starlight review')
		await expectSolidReadable(page.locator('.project-table-card'))
		await page.goto('/calendar')
		await expect(page.locator('.calendar-command-bar')).toBeVisible()
		await page.screenshot({path: testInfo.outputPath('starlight-calendar.png'), fullPage: true})
		// The narrow layout has a separate persistent creation button outside the collapsed controls.
		await page.getByRole('button', {
			name: viewport.language === 'en' ? 'New schedule' : '新建安排',
			exact: true,
		}).filter({visible: true}).first().click()
		await expectSolidReadable(page.locator('.calendar-create'))
		await page.keyboard.press('Escape')
		await page.goto('/ai')
		const chatMain = page.locator('.tcy-assistant:not(.is-embedded) .chat-main')
		await expect(chatMain).toBeVisible()
		await expect(chatMain).toHaveCSS('background-image', /linear-gradient.*url\(/)
		await expectSolidReadable(page.locator('.tcy-assistant:not(.is-embedded) .composer'))
		await page.screenshot({path: testInfo.outputPath('starlight-arona.png'), fullPage: true})

		await page.goto('/user/settings/general')
		for (const value of ['light', 'dark', 'auto']) {
			await saveScheme(page, value, viewport.label)
			expect(await storedScheme(apiContext, userToken)).toBe(value)
			await expect(page.locator('html')).not.toHaveClass(/theme-starlight/)
			await expect(page.locator('body')).toHaveCSS('background-image', 'none')
			await expect(page.locator('html')).toHaveClass(value === 'dark' ? /dark/ : /(?:^|\s)light(?:\s|$)/)
		}
		await page.emulateMedia({colorScheme: 'dark'})
		await expect(page.locator('html')).toHaveClass(/dark/)
		await page.emulateMedia({colorScheme: 'light'})
		await expect(page.locator('html')).toHaveClass(/(?:^|\s)light(?:\s|$)/)
	})
}

test('Starlight keeps custom project and Compass photos above the sky and leaves print and Quick Add clean', async ({
	authenticatedPage: page, apiContext, userToken,
}, testInfo) => {
	await updateUserSettings(apiContext, userToken, {frontend_settings: {color_schema: 'starlight'}})
	await ProjectFactory.create(1, {id: 1, title: 'My own background'})
	await createDefaultViews(1)
	const headers = {Authorization: `Bearer ${userToken}`}
	const bytes = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const projectPhoto = await apiContext.put(`${api}/projects/1/backgrounds/upload`, {
		headers,
		multipart: {background: {name: 'my-project.png', mimeType: 'image/png', buffer: bytes}},
	})
	expect(projectPhoto.ok(), await projectPhoto.text()).toBe(true)
	await page.goto('/projects/1/1')
	await expect(page.locator('html')).toHaveClass(/theme-starlight/)
	const background = page.locator('.app-container-background')
	await expect(background).toHaveClass(/is-visible/)
	await expect(background).toHaveCSS('background-image', /url\(/)
	await expect(background).toHaveCSS('opacity', '1')
	await expect(background).toHaveCSS('z-index', '0')
	await page.screenshot({path: testInfo.outputPath('starlight-custom-project.png')})

	const upload = await apiContext.post(`${api}/drive/files`, {
		headers,
		multipart: {file: {name: 'my-sky.png', mimeType: 'image/png', buffer: bytes}},
	})
	expect(upload.ok()).toBe(true)
	const {file_id: fileId} = await upload.json()
	const space = await createCompassSpace(apiContext, userToken, {title: 'My sky', theme: 'nebula'})
	const saved = await apiContext.put(`${api}/compass/spaces/${space.id}`, {
		headers,
		data: {...space, background_file_id: fileId, background_focus_x: 50, background_focus_y: 50},
	})
	expect(saved.ok(), await saved.text()).toBe(true)
	await page.goto(`/compass/spaces/${space.id}`)
	const photo = page.locator('.compass-backdrop__image').first()
	await expect(photo).toBeVisible()
	await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
	await expect(photo).toHaveCSS('opacity', '1')
	await expect(page.locator('.compass-space')).toHaveAttribute('data-compass-theme', 'nebula')
	await page.screenshot({path: testInfo.outputPath('starlight-custom-compass.png')})

	await page.emulateMedia({media: 'print'})
	await expect(page.locator('body')).toHaveCSS('background-image', 'none')
	await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
	await expect(photo).toBeHidden()
	await page.emulateMedia({media: 'screen'})
	await page.goto('/?mode=quick-add')
	await expect(page.locator('.quick-add-overlay')).toBeVisible()
	await expect(page.locator('html')).toHaveClass(/theme-starlight/)
	for (const selector of ['html', 'body']) {
		await expect(page.locator(selector)).toHaveCSS('background-image', 'none')
		await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
	}
})

test('Starlight startup hint survives pending authentication, then the server preference wins', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	await updateUserSettings(apiContext, userToken, {frontend_settings: {color_schema: 'light'}})
	await page.addInitScript(key => localStorage.setItem(key, 'starlight'), cacheKey)
	let release!: () => void
	const pending = new Promise<void>(resolve => { release = resolve })
	await page.route('**/api/v2/user', async route => {
		if (route.request().method() === 'GET') await pending
		await route.continue()
	})
	try {
		await page.goto('/user/settings/general')
		await expect(page.locator('html')).toHaveClass(/theme-starlight/)
		await expect(page.locator('html')).not.toHaveClass(/(?:^|\s)light(?:\s|$)/)
	} finally {
		release()
	}
	await expect(page.getByRole('combobox', {name: 'Color Scheme', exact: true})).toHaveValue('light')
	await expect(page.locator('html')).toHaveClass(/(?:^|\s)light(?:\s|$)/)
	await expect(page.locator('html')).not.toHaveClass(/theme-starlight/)
})

test('Starlight works when its optional startup storage is unavailable', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	await updateUserSettings(apiContext, userToken, {frontend_settings: {color_schema: 'starlight'}})
	await page.addInitScript(key => {
		const getItem = Storage.prototype.getItem
		const setItem = Storage.prototype.setItem
		Storage.prototype.getItem = function (name) {
			if (name === key) throw new DOMException('Storage unavailable', 'SecurityError')
			return getItem.call(this, name)
		}
		Storage.prototype.setItem = function (name, value) {
			if (name === key) throw new DOMException('Storage unavailable', 'SecurityError')
			return setItem.call(this, name, value)
		}
	}, cacheKey)
	await page.goto('/user/settings/general')
	await expect(page.getByRole('combobox', {name: 'Color Scheme', exact: true})).toHaveValue('starlight')
	await expect(page.locator('html')).toHaveClass(/theme-starlight/)
	await expect(page.locator('body')).toHaveCSS('background-image', /url\(/)
})
