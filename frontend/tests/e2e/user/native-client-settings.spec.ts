import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {updateUserSettings} from '../../support/updateUserSettings'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {createDefaultViews} from '../project/prepareProjects'

const ORIGIN = 'https://astering.test'
type ClientMode = 'supported' | 'legacy' | 'browser'
type CommandRecord = {
	id: string,
	action: string,
	keys: string[],
}
type TestWindow = Window & {
	__clientCommands: CommandRecord[],
}

function localURL(value: string) {
	const url = new URL(value)
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
		throw new Error('Client settings E2E forwards only to isolated loopback services')
	}
	return url
}

async function installFacade(page: Page, token: string, baseURL: string, mode: ClientMode) {
	const frontend = localURL(baseURL)
	const api = localURL(apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456'))
	// Serve actual Mage-built assets/API through an intercepted HTTPS origin;
	// production HTTPS and same-origin native gates remain unchanged.
	await page.route(`${ORIGIN}/**`, async route => {
		const request = route.request()
		const url = new URL(request.url())
		const destination = new URL(url.pathname + url.search, url.pathname.startsWith('/api/') ? api : frontend)
		const response = await route.fetch({
			url: destination.href,
			maxRedirects: 0,
			headers: {
				...request.headers(),
				origin: frontend.origin,
				referer: new URL(url.pathname, frontend).href,
			},
		})
		await route.fulfill({response})
	})
	await page.routeWebSocket('wss://astering.test/**', route => route.close())
	await page.addInitScript(({token, mode, origin}) => {
		if (window.location.origin !== origin) return
		// Match the canonical URL produced by startup hydration before seeding an
		// authenticated session; changing API strings mid-query correctly fences it.
		localStorage.setItem('API_URL', origin)
		localStorage.setItem('token', token)
		const target = window as TestWindow
		target.__clientCommands = []
		if (mode === 'browser') return
		const bridge: {
			postMessage: (encoded: string) => void,
			onmessage?: (event: {data: string}) => void,
		} = {
			postMessage(encoded) {
				const command = JSON.parse(encoded) as Record<string, unknown>
				target.__clientCommands.push({
					id: String(command.id),
					action: String(command.action),
					keys: Object.keys(command).sort(),
				})
				const unsupported = command.action === 'clientInfo' && mode === 'legacy'
				const result = command.action === 'clientInfo' ? {
					version_name: '2.7.1-aster.73',
					version_code: 73,
					capabilities: {
						clientSettings: true,
						deviceNotifications: true,
					},
				} : command.action === 'refresh' ? {token} : {}
				queueMicrotask(() => bridge.onmessage?.({data: JSON.stringify({
					id: command.id,
					ok: !unsupported,
					result,
					error: unsupported ? 'unsupported' : undefined,
				})}))
			},
		}
		window.AsteringNative = bridge
	}, {
		token,
		mode,
		origin: ORIGIN,
	})
}

async function commands(page: Page) {
	return page.evaluate(() => (window as TestWindow).__clientCommands)
}

async function notificationEvent(page: Page, event: Record<string, unknown>) {
	await page.evaluate(event => {
		window.AsteringNative?.onmessage?.({data: JSON.stringify(event)})
	}, event)
}

for (const scenario of [
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
	test(`native client settings fit the existing account menu at ${scenario.width}px`, async ({
		page,
		baseURL,
		apiContext,
		userToken,
	}, info) => {
		await page.setViewportSize(scenario)
		await updateUserSettings(apiContext, userToken, {language: scenario.language})
		await installFacade(page, userToken, baseURL || 'http://127.0.0.1:4173', 'supported')
		await page.goto(`${ORIGIN}/ai`)
		await expect(page).toHaveURL(`${ORIGIN}/ai`)
		const composer = page.locator('.composer textarea')
		const draft = 'Keep this unsent draft while opening native client settings.'
		await composer.fill(draft)
		const url = page.url()
		const input = await composer.elementHandle()
		if (scenario.width < 768) {
			await expect(page.locator('.navbar.is-mobile-assistant')).not.toBeVisible()
			await page.locator('[data-mobile-history-toggle]').click()
			await page.locator('[data-mobile-site-menu]').click()
			await expect(page.locator('#mobile-assistant-site-actions')).toBeVisible()
		}
		const account = page.locator('[data-tour="account-menu"]')
		await account.click()
		const entry = page.getByTestId('nativeClientSettings')
		await expect(entry).toBeVisible()
		await expect(entry).toHaveText(scenario.language === 'zh-CN' ? '客户端设置' : 'Client settings')
		await page.screenshot({path: info.outputPath(`client-settings-${scenario.width}.png`)})
		await entry.click()
		await expect.poll(async () => (await commands(page)).filter(command => command.action === 'openClientSettings'))
			.toEqual([{
				id: expect.any(String),
				action: 'openClientSettings',
				keys: ['action', 'id'],
			}])
		expect(page.url()).toBe(url)
		if (scenario.width < 768) await page.locator('.menu-hide-button').click()
		await expect(composer).toHaveValue(draft)
		expect(await input?.evaluate(node => node.isConnected && node === document.querySelector('.composer textarea')))
			.toBe(true)
		await expect.poll(async () => (await commands(page)).filter(command => command.action === 'clientInfo').length)
			.toBe(1)
		await page.goto('about:blank')
	})
}

for (const mode of ['browser', 'legacy'] as const) {
	test(`does not show a dead native settings entry in ${mode} mode`, async ({page, baseURL, userToken}) => {
		await installFacade(page, userToken, baseURL || 'http://127.0.0.1:4173', mode)
		await page.goto(`${ORIGIN}/projects`)
		await page.locator('[data-tour="account-menu"]').click()
		if (mode === 'legacy') {
			await expect.poll(async () => (await commands(page)).filter(command => command.action === 'clientInfo').length)
				.toBe(1)
		}
		await expect(page.getByTestId('nativeClientSettings')).toHaveCount(0)
		await page.keyboard.press('Escape')
		await page.locator('[data-tour="account-menu"]').click()
		await expect(page.getByTestId('nativeClientSettings')).toHaveCount(0)
		expect((await commands(page)).filter(command => command.action === 'clientInfo'))
			.toHaveLength(mode === 'legacy' ? 1 : 0)
		expect((await commands(page)).some(command => command.action === 'openClientSettings')).toBe(false)
		await page.goto('about:blank')
	})
}

test('native notification taps keep the mobile SPA and reject a different account, session or server', async ({
	page,
	baseURL,
	apiContext,
	currentUser,
	userToken,
}, info) => {
	await page.setViewportSize({
		width: 390,
		height: 844,
	})
	await updateUserSettings(apiContext, userToken, {language: 'en'})
	await ProjectFactory.create(1, {
		id: 41,
		owner_id: currentUser.id,
		title: 'Native notification project',
	})
	await createDefaultViews(41, 81)
	await TaskFactory.create(1, {
		id: 43,
		project_id: 41,
		created_by_id: currentUser.id,
		title: 'Open this actual task from a notification',
	})
	await installFacade(page, userToken, baseURL || 'http://127.0.0.1:4173', 'supported')
	const documents: string[] = []
	page.on('request', request => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url())
	})
	await page.goto(`${ORIGIN}/projects`)
	await expect(page.getByRole('link', {name: 'Native notification project', exact: true}).first()).toBeVisible()
	await expect.poll(() => page.evaluate(() => typeof window.AsteringNative?.onmessage)).toBe('function')
	const initialDocument = await page.evaluate(() => performance.timeOrigin)
	const claims = JSON.parse(Buffer.from(userToken.split('.')[1], 'base64url').toString()) as {sid: string}
	expect(claims.sid).toBeTruthy()
	const event = {
		event: 'openNotification',
		user_id: currentUser.id,
		sid: claims.sid,
		server_origin: ORIGIN,
		target: {
			kind: 'task',
			id: '43',
		},
	}
	for (const invalid of [
		{user_id: currentUser.id + 1},
		{sid: '00000000-0000-4000-8000-000000000000'},
		{server_origin: 'https://another.example'},
	]) await notificationEvent(page, {...event, ...invalid})
	// A quiet real network barrier lets an incorrectly accepted SPA navigation settle.
	await page.waitForLoadState('networkidle')
	await expect(page).toHaveURL(`${ORIGIN}/projects`)
	await expect(page.locator('.task-view')).toHaveCount(0)
	await expect(page.locator('.notifications-list')).toHaveCount(0)
	const loadedTask = page.waitForResponse(response => response.request().method() === 'GET'
		&& new URL(response.url()).pathname === '/api/v2/tasks/43')
	await notificationEvent(page, event)
	const taskResponse = await loadedTask
	expect(taskResponse.ok()).toBe(true)
	expect((await taskResponse.json()).title).toBe('Open this actual task from a notification')
	await expect(page).toHaveURL(`${ORIGIN}/tasks/43`)
	const task = page.locator('.task-view')
	await expect(task).toBeVisible()
	await expect(task).toContainText('Open this actual task from a notification')
	const taskElement = await task.elementHandle()
	await notificationEvent(page, {
		...event,
		target: {
			kind: 'notifications',
			id: '',
		},
	})
	await expect(page.locator('.notifications-list[role="dialog"]')).toBeVisible()
	await expect(page.locator('.notifications-list')).toContainText('Notifications')
	await expect(page).toHaveURL(`${ORIGIN}/tasks/43`)
	expect(await taskElement?.evaluate(node => node.isConnected && node === document.querySelector('.task-view')))
		.toBe(true)
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(initialDocument)
	expect(documents).toEqual([`${ORIGIN}/projects`])
	await page.screenshot({path: info.outputPath('native-notification-inbox-390.png')})
	await page.goto('about:blank')
})
