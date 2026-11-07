import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {BucketFactory} from '../../factories/bucket'
import {createDefaultViews} from '../project/prepareProjects'

test('global quick add keeps its draft and requests a project when none is available', async ({authenticatedPage: page}, testInfo) => {
	await page.setViewportSize({width: 390, height: 844})
	let creates = 0
	page.on('request', request => {
		if (/\/api\/v2\/projects\/[^/]+\/tasks$/.test(new URL(request.url()).pathname) && request.method() === 'POST') creates++
	})
	await page.goto('/')
	await page.getByRole('button', {name: 'Open the search/quick action bar', exact: true}).click()
	const quickActions = page.locator('.quick-actions')
	await quickActions.getByRole('button', {name: /^New task\b/}).click()
	const input = quickActions.locator('.action-input input')
	await input.fill('Keep this idea until I choose a project')
	await input.press('Enter')
	await expect(quickActions.getByRole('alert')).toHaveText('Please specify a project or set a default project in the settings.')
	await expect(input).toHaveValue('Keep this idea until I choose a project')
	await expect(quickActions).toBeVisible()
	expect(creates).toBe(0)
	await page.screenshot({path: testInfo.outputPath('global-quick-add-no-project-390.png')})
})

for (const width of [390, 1440]) {
	test(`quick add at ${width}px stays busy during member lookup and preserves a saved task after an assignment failure`, async ({authenticatedPage: page, currentUser, apiContext, userToken}, testInfo) => {
		await page.setViewportSize({width, height: 844})
		await ProjectFactory.create(1, {id: 1, title: 'Quick add recovery'})
		await createDefaultViews(1)
		await BucketFactory.create(1, {id: 1, title: 'Inbox', project_view_id: 4})
		let releaseLookup!: () => void
		const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
		let lookupStarted = false
		await page.route('**/api/v2/projects/1/users/search?*', async route => {
			lookupStarted = true
			await lookupGate
			await route.continue()
		})
		await page.route('**/api/v2/tasks/*/assignees', route => route.request().method() === 'POST'
			? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Simulated assignment failure'})})
			: route.continue())
		let creates = 0
		page.on('request', request => {
			if (new URL(request.url()).pathname === '/api/v2/projects/1/tasks' && request.method() === 'POST') creates++
		})
		await page.goto('/projects/1/4')
		const lane = page.locator('.bucket[data-bucket-id="1"]')
		await lane.getByRole('button', {name: 'Add a task', exact: true}).click()
		const input = lane.getByRole('textbox', {name: 'Add a task', exact: true})
		await input.fill(`Saved exactly once @${currentUser.username}`)
		await input.press('Enter')
		try {
			await expect.poll(() => lookupStarted).toBe(true)
			await expect(input).toHaveAttribute('aria-disabled', 'true')
			// Keyboard submission can still reach a form whose button is busy.
			await input.press('Enter')
			expect(creates).toBe(0)
		} finally { releaseLookup() }
		await expect(lane.locator('.task')).toContainText('Saved exactly once')
		await expect(input).toHaveValue('')
		const notice = page.locator('.global-notification .vue-notification.error')
		await expect(notice).toHaveCount(1)
		await expect(notice).toContainText('Task created, but some assignees or labels were not saved')
		await expect(notice).toContainText(`@${currentUser.username}`)
		expect(creates).toBe(1)
		await page.screenshot({path: testInfo.outputPath(`quick-add-recovery-${width}.png`)})
		await page.reload()
		await expect(lane.locator('.task')).toHaveCount(1)
		await expect(lane.locator('.task')).toContainText('Saved exactly once')
		const response = await apiContext.get('/api/v2/projects/1/tasks', {headers: {Authorization: `Bearer ${userToken}`}})
		expect(response.ok()).toBe(true)
		const stored = (await response.json()).items
		expect(stored).toHaveLength(1)
		expect(stored[0].title).toBe('Saved exactly once')
		expect(stored[0].assignees ?? []).toHaveLength(0)
	})
}
