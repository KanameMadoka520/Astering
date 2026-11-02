import {test, expect} from '../../../support/fixtures'
import type {Page} from '@playwright/test'
import {createProjects} from '../../project/prepareProjects'
import {setupApiUrl} from '../../../support/authenticateUser'
import {TEST_PASSWORD} from '../../../support/constants'
import {apiRootUrl} from '../../../support/apiUrl'
import {TaskFactory} from '../../../factories/task'

test.beforeEach(async ({apiContext, userToken}) => {
	const response = await apiContext.post(`${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2/ai/settings`, {
		headers: {Authorization: `Bearer ${userToken}`},
		data: {connections: [], assistant: '', transcription: '', cleanup: ''},
	})
	expect(response.ok()).toBeTruthy()
})

async function fitsScreen(page: Page) {
	const sizes = await page.evaluate(() => ({body: document.documentElement.scrollWidth, viewport: innerWidth}))
	expect(sizes.body, `page ${page.url()} should fit its ${sizes.viewport}px viewport`).toBeLessThanOrEqual(sizes.viewport + 1)
}

for (const width of [360, 390]) {
	test(`mobile ${width}px: models, protocols and manual names remain usable`, async ({authenticatedPage: page}) => {
		await page.setViewportSize({width, height: 844})
		await page.goto('/user/settings/ai')
		await expect(page.getByRole('heading', {name: 'AI and voice'})).toBeVisible()
		await page.getByRole('button', {name: 'Add model connection'}).click()
		await page.getByLabel('Connection name').fill('Mobile model connection')
		await page.getByLabel('API base URL', {exact: true}).fill('https://provider.example.com/a-long-custom-proxy-path/v1')
		await page.getByRole('combobox', {name: 'Model ID', exact: true}).fill('manual-model')
		await page.getByLabel('API key', {exact: true}).fill('test-key')
		for (const [protocol, suffix] of [['openai-chat', '/chat/completions'], ['openai-responses', '/responses'], ['anthropic', '/messages'], ['gemini', '/models/manual-model:streamGenerateContent?alt=sse']]) {
			await page.getByLabel('Request protocol').selectOption(protocol)
			await expect(page.locator('.endpoint-info code').first()).toHaveText('https://provider.example.com/a-long-custom-proxy-path/v1' + suffix)
			await fitsScreen(page)
		}
		await page.route('**/api/v2/ai/models', async route => {
			expect(route.request().postDataJSON().protocol).toBe('gemini')
			expect(route.request().headers()['accept-language']).toBe('en')
			await route.fulfill({json: {models: ['upstream-model', 'another-model'], endpoint: 'https://provider.example.com/a-long-custom-proxy-path/v1/models', truncated: false}})
		})
		await page.getByRole('button', {name: 'Fetch model list'}).click()
		await page.getByRole('button', {name: 'Browse available models'}).click()
		await expect(page.getByRole('listbox', {name: 'Model ID', exact: true}).getByRole('option')).toHaveCount(2)
		await page.getByRole('option', {name: 'upstream-model', exact: true}).click()
		await expect(page.getByRole('combobox', {name: 'Model ID', exact: true})).toHaveValue('upstream-model')
		await page.getByRole('combobox', {name: 'Model ID', exact: true}).fill('my-manual-model')
		await page.getByRole('combobox', {name: 'Model ID', exact: true}).press('Escape')
		const savedConnection = page.waitForResponse(r => r.url().endsWith('/ai/settings') && r.request().method() === 'POST')
		await page.getByRole('button', {name: 'Save this connection'}).click()
		expect((await savedConnection).ok()).toBe(true)
		await expect(page.getByLabel('API key', {exact: true})).toHaveValue('')
		await page.getByRole('button', {name: 'Feature defaults', exact: true}).click()
		await page.getByLabel(/^Arona(?!’s)/).selectOption({label: 'Mobile model connection · my-manual-model'})
		const savedRoles = page.waitForResponse(r => r.url().endsWith('/ai/settings') && r.request().method() === 'POST')
		await page.getByRole('button', {name: 'Save feature defaults'}).click()
		expect((await savedRoles).ok()).toBe(true)
		await page.reload()
		await page.getByRole('button', {name: /^Text & vision/}).click()
		await expect(page.getByRole('combobox', {name: 'Model ID', exact: true})).toHaveValue('my-manual-model')
		await expect(page.getByLabel('Request protocol')).toHaveValue('gemini')
		await page.getByRole('button', {name: /^Speech recognition/}).click()
		await page.getByRole('button', {name: 'Add model connection'}).click()
		await expect(page.getByLabel('Request protocol').locator('option')).toHaveCount(3)
		await page.getByLabel('Request protocol').selectOption('openai-audio')
		await page.getByLabel('Connection name').fill('Mobile speech')
		await page.getByLabel('API base URL', {exact: true}).fill('https://provider.example.com/v1')
		await page.getByRole('combobox', {name: 'Model ID', exact: true}).fill('speech-model')
		await page.getByRole('combobox', {name: 'Model ID', exact: true}).press('Escape')
		await page.getByLabel('API key', {exact: true}).fill('test-speech-key')
		const savedSpeech = page.waitForResponse(r => r.url().endsWith('/ai/settings') && r.request().method() === 'POST')
		await page.getByRole('button', {name: 'Save this connection'}).click()
		const configuration = await (await savedSpeech).json()
		expect(configuration.connections.map((c: {model: string}) => c.model)).toEqual(['my-manual-model', 'speech-model'])
		expect(configuration.assistant).toBeTruthy()
		await fitsScreen(page)
		await page.getByRole('dialog', {name: 'Custom / compatible service settings', exact: true}).getByRole('button', {name: 'Close dialog', exact: true}).click()
		await page.goto('/ai')
		await expect(page.getByRole('heading', {name: 'Arona'})).toBeVisible()
		await expect(page.getByLabel('Your request')).toBeVisible()
		await fitsScreen(page)
		await page.goto('/user/settings/showcase')
		await expect(page.getByRole('heading', {name: 'Public page', exact: true})).toBeVisible()
		await page.getByLabel('Page address').fill(`mobile-public-${width}`)
		await page.getByLabel('Page title').fill('Mobile public schedule')
		await page.getByRole('button', {name: 'Preview public page'}).click()
		await expect(page.getByRole('heading', {name: 'What visitors will see'})).toBeVisible()
		await fitsScreen(page)
		await page.getByRole('button', {name: 'Publish this preview'}).click()
		await expect(page.getByRole('link', {name: 'View public page ↗'})).toBeVisible()
		await page.goto(`/p/mobile-public-${width}`)
		await expect(page.getByRole('heading', {name: 'Mobile public schedule'})).toBeVisible()
		await expect(page.getByRole('heading', {name: 'Available times'})).toBeVisible()
		await fitsScreen(page)
	})
}

test('mobile core pages keep navigation, projects, tasks and settings inside the viewport', async ({authenticatedPage: page, currentUser}) => {
	await page.setViewportSize({width: 360, height: 800})
	const projects = await createProjects()
	const [task] = await TaskFactory.create(1, {project_id: projects[0].id, created_by_id: currentUser.id, title: 'Mobile task with a useful title'})
	await page.goto('/')
	await expect(page.locator('button.menu-show-button:visible')).toBeVisible()
	await fitsScreen(page)
	await page.locator('button.menu-show-button:visible').click()
	const menu = page.locator('.menu-container')
	await expect(menu).toHaveClass(/is-active/)
	// Home has its own Arona workspace link, so go through the opened navigation drawer.
	await menu.getByRole('navigation', {name: 'Main navigation'}).getByRole('link', {name: 'Arona', exact: true}).click()
	await expect(page.getByRole('heading', {name: 'Arona'})).toBeVisible()
	for (const path of ['/projects', ...projects[0].views.map((view: {id: number}) => `/projects/${projects[0].id}/${view.id}`), `/tasks/${task.id}`, '/user/settings/general']) {
		await page.goto(path)
		await page.waitForLoadState('networkidle')
		await fitsScreen(page)
	}
	await page.goto(`/tasks/${task.id}`)
	await expect(page.locator('.task-view')).toContainText('Mobile task with a useful title')
})

test('update banner shows the waiting fork build and sends skipWaiting on refresh', async ({authenticatedPage: page}) => {
	await page.setViewportSize({width: 360, height: 800})
	await page.goto('/')
	// The app mounts after its async start; dispatch only once it listens for swUpdated.
	await expect(page.locator('main h1')).toBeVisible()
	await expect(page.locator('.update-notification')).toHaveCount(0)
	await page.evaluate(() => {
		const registration = {waiting: {postMessage(message: string, ports?: MessagePort[]) {
			if (message === 'getVersion') ports?.[0].postMessage({version: 'v2.7.1-tcymc.99-test'})
			if (message === 'skipWaiting') document.body.dataset.updateRequested = 'true'
		}}}
		document.dispatchEvent(new CustomEvent('swUpdated', {detail: registration}))
	})
	await expect(page.locator('.update-notification')).toContainText('v2.7.1-tcymc.99-test')
	await fitsScreen(page)
	await page.locator('.update-notification button').click()
	await expect(page.locator('body')).toHaveAttribute('data-update-requested', 'true')
	await expect(page.locator('.update-notification')).toHaveCount(0)
})


test('mobile login works at 360px without clipped fields', async ({page, currentUser}) => {
	await page.setViewportSize({width: 360, height: 800})
	await setupApiUrl(page)
	await page.goto('/login')
	await page.locator('#username').fill(currentUser.username)
	await page.locator('#password').fill(TEST_PASSWORD)
	await fitsScreen(page)
	await page.getByRole('button', {name: 'Login', exact: true}).click()
	await expect(page).toHaveURL('/')
	await expect(page.locator('main h1')).toContainText(currentUser.username)
	await fitsScreen(page)
})
