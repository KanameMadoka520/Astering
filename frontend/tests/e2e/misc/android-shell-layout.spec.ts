import type {Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {BucketFactory} from '../../factories/bucket'
import {TaskFactory} from '../../factories/task'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {createProjects} from '../project/prepareProjects'

const origin = 'https://astering-layout.test'

test.use({
	isMobile: true,
	hasTouch: true,
})

function loopbackURL(value: string) {
	const url = new URL(value)
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
		throw new Error('Android layout fixtures may forward only to local isolated services')
	}
	return url
}

// This uses actual application assets/API under a trusted HTTPS origin. It exercises
// native-aware web layout, not Android WindowInsets or a physical soft keyboard.
async function nativeWebsite(page: Page, token: string, baseURL: string) {
	const frontend = loopbackURL(baseURL)
	const api = loopbackURL(apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456'))
	await page.route(`${origin}/**`, async route => {
		const request = route.request()
		const url = new URL(request.url())
		const response = await route.fetch({
			url: new URL(url.pathname + url.search, url.pathname.startsWith('/api/') ? api : frontend).href,
			maxRedirects: 0,
			headers: {
				...request.headers(),
				origin: frontend.origin,
				referer: new URL(url.pathname, frontend).href,
			},
		})
		await route.fulfill({response})
	})
	await page.routeWebSocket('wss://astering-layout.test/**', socket => socket.close())
	await page.addInitScript(({token, origin}) => {
		if (location.origin !== origin) return
		localStorage.setItem('API_URL', origin)
		localStorage.setItem('token', token)
		const bridge: {
			postMessage: (encoded: string) => void,
			onmessage?: (event: {data: string}) => void,
		} = {
			postMessage(encoded) {
				const request = JSON.parse(encoded)
				const result = request.action === 'clientInfo' ? {
					version_name: '2.7.1-aster.68',
					version_code: 68,
					capabilities: {clientSettings: true},
				} : request.action === 'refresh' ? {token} : {}
				queueMicrotask(() => bridge.onmessage?.({data: JSON.stringify({
					id: request.id,
					ok: true,
					result,
				})}))
			},
		}
		window.AsteringNative = bridge
	}, {
		token,
		origin,
	})
}

async function withinViewport(page: Page, target: Locator) {
	await expect(target).toBeVisible()
	await expect.poll(async () => target.evaluate(element => {
		const rect = element.getBoundingClientRect()
		return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width >= 40
	})).toBe(true)
	await expect.poll(() => page.evaluate(() => ({
		left: scrollX,
		overflow: document.documentElement.scrollWidth - innerWidth,
	}))).toEqual({
		left: 0,
		overflow: 0,
	})
}

async function shellStartsUnderHeader(page: Page, content: Locator) {
	await withinViewport(page, page.locator('.navbar'))
	await withinViewport(page, content)
	await expect.poll(async () => {
		const header = await page.locator('.navbar').boundingBox()
		const body = await content.boundingBox()
		return header && body ? Math.round(body.y - header.y - header.height) : -1000
	}).toBeGreaterThanOrEqual(0)
	await expect.poll(async () => {
		const header = await page.locator('.navbar').boundingBox()
		const body = await content.boundingBox()
		return header && body ? Math.round(body.y - header.y - header.height) : 1000
	}).toBeLessThanOrEqual(24)
	await expect(page.locator('.add-to-home-screen')).toHaveCount(0)
}

for (const viewport of [
	{width: 320, height: 740},
	{width: 390, height: 844},
	{width: 844, height: 390},
]) {
	test(`Android web subpages retain aligned content at ${viewport.width}x${viewport.height}`, async ({
		page,
		baseURL,
		userToken,
	}, info) => {
		await page.setViewportSize(viewport)
		await nativeWebsite(page, userToken, baseURL || 'http://127.0.0.1:4173')
		await page.goto(`${origin}/user/settings/general`)
		for (const section of ['general', 'email-update', 'sessions', 'ai', 'storage']) {
			if (section !== 'general') {
				const toggle = page.locator('.side-nav__toggle')
				if (await toggle.isVisible()) await toggle.click()
				await page.locator(`.side-nav__groups a[href="/user/settings/${section}"]`).click()
			}
			await expect(page).toHaveURL(`${origin}/user/settings/${section}`)
			await expect(page.locator('.side-nav-shell .view .page-header__title')).toBeVisible()
			await shellStartsUnderHeader(page, page.locator('.side-nav-shell'))
			await withinViewport(page, page.locator('.side-nav-shell .view'))
			await withinViewport(page, page.locator('.side-nav-shell .view .page-header'))
		}
		await page.goto(`${origin}/notes`)
		await shellStartsUnderHeader(page, page.locator('.notes-page'))
		await page.locator('.notes-page__header').getByRole('button', {name: 'New note', exact: true}).click()
		const article = page.getByRole('textbox', {name: 'Article in Markdown', exact: true})
		await expect(article).toBeVisible()
		await shellStartsUnderHeader(page, page.locator('.notes-page'))
		await withinViewport(page, article)
		await article.focus()
		await article.blur()
		await page.screenshot({path: info.outputPath(`android-note-${viewport.width}.png`)})
		await page.goto('about:blank')
	})

	test(`Android board task and short project forms keep their first content at ${viewport.width}x${viewport.height}`, async ({
		page,
		baseURL,
		userToken,
	}, info) => {
		await page.setViewportSize(viewport)
		await nativeWebsite(page, userToken, baseURL || 'http://127.0.0.1:4173')
		const [project] = await createProjects()
		const viewId = project.views[3].id
		const [bucket] = await BucketFactory.create(1, {project_view_id: viewId, title: 'In progress'})
		const [task] = await TaskFactory.create(1, {
			project_id: project.id,
			title: 'A real task opened from the Android board',
			description: '<p>The first line should stay beneath the task title.</p>',
		})
		await TaskBucketFactory.create(1, {
			task_id: task.id,
			bucket_id: bucket.id,
			project_view_id: viewId,
		})
		const boardURL = `${origin}/projects/${project.id}/${viewId}`
		await page.goto(boardURL)
		await shellStartsUnderHeader(page, page.locator('.project-view-shell'))
		await page.locator('.kanban-card__title-link').click()
		const taskDialog = page.getByRole('dialog', {name: 'Task detail', exact: true})
		await expect(taskDialog).toBeVisible()
		await withinViewport(page, taskDialog.locator('.task-view'))
		if (viewport.width <= 768) {
			await expect.poll(async () => (await taskDialog.locator('.task-view').boundingBox())?.y ?? 1000)
				.toBeLessThanOrEqual(20)
		}
		await page.goBack()
		await expect(page).toHaveURL(boardURL)
		await expect(taskDialog).toHaveCount(0)
		await shellStartsUnderHeader(page, page.locator('.project-view-shell'))
		await page.locator('.project-title-dropdown .project-title-button').click()
		await page.getByRole('link', {name: 'Duplicate', exact: true}).click()
		const duplicate = page.getByRole('dialog', {name: 'Duplicate this project', exact: true})
		await expect(duplicate).toBeVisible()
		await withinViewport(page, duplicate.locator('.modal-content > .card'))
		const header = duplicate.locator('.modal-content > .card > .card-header')
		const body = duplicate.locator('.modal-content > .card > .card-content')
		await expect.poll(async () => {
			const title = await header.boundingBox()
			const content = await body.boundingBox()
			return title && content ? Math.round(content.y - title.y - title.height) : 1000
		}).toBeLessThanOrEqual(2)
		await duplicate.getByRole('button', {name: 'Cancel', exact: true}).scrollIntoViewIfNeeded()
		await duplicate.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(page).toHaveURL(boardURL)
		await expect(duplicate).toHaveCount(0)
		await shellStartsUnderHeader(page, page.locator('.project-view-shell'))
		await page.screenshot({path: info.outputPath(`android-board-return-${viewport.width}.png`)})
		await page.goto('about:blank')
	})
}
