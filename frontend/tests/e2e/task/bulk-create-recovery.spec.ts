import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {createDefaultViews} from '../project/prepareProjects'

type StoredTask = {id: number, title: string, project_id: number, related_tasks?: {parenttask?: {id: number}[]}}

for (const width of [390, 1440]) {
	test(`bulk creation at ${width}px retries unfinished entries without duplicating saved names or losing their parents`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		await page.setViewportSize({width, height: 900})
		await page.emulateMedia({reducedMotion: 'reduce'})
		await ProjectFactory.create(1, {id: 1, title: 'One'})
		await ProjectFactory.create(1, {id: 2, title: 'Two'}, false)
		await createDefaultViews(1)
		await createDefaultViews(2, 5)
		const requests: number[] = []
		const created = new Map<number, StoredTask[]>()
		let childAttempts = 0
		let releaseRetry!: () => void
		const retryGate = new Promise<void>(resolve => { releaseRetry = resolve })
		await page.route('**/api/v2/projects/*/tasks/bulk', async route => {
			if (route.request().method() !== 'POST') return route.continue()
			const project = Number(new URL(route.request().url()).pathname.match(/projects\/(\d+)\//)?.[1])
			requests.push(project)
			if (project === 2) {
				childAttempts++
				if (childAttempts <= 2) return route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({message: 'Simulated temporary failure before creating children'}),
				})
				await retryGate
			}
			// All successful writes reach the isolated test server; their IDs and relations are verified below.
			const response = await route.fetch()
			expect(response.ok()).toBe(true)
			const body = await response.json()
			created.set(project, body.tasks)
			await route.fulfill({response})
		})
		try {
			await page.goto('/projects/1/1')
			const input = page.locator('.add-task-textarea')
			const recovery = page.locator('.bulk-recovery')
			const retry = page.locator('.bulk-recovery-retry')
			await input.fill('Same +One\n  Child +Two\nSame +One\n  Child +Two')
			await input.press('Enter')
			await expect(recovery).toBeVisible()
			await expect(recovery.getByRole('status')).toHaveText('2 tasks created · 2 not created · 2 relationships unfinished')
			await expect(recovery.locator('li')).toHaveCount(2)
			await expect(input).toHaveValue('')
			await input.fill('Independent next draft')
			await page.screenshot({path: testInfo.outputPath(`bulk-create-recovery-pending-${width}.png`)})
			await input.press('Enter')
			expect(requests).toEqual([1, 2])
			await retry.click()
			await expect.poll(() => childAttempts).toBe(2)
			await expect(retry).not.toHaveAttribute('aria-disabled', 'true')
			await expect(recovery).toBeVisible()
			await expect(input).toHaveValue('Independent next draft')
			await retry.focus()
			await retry.press('Enter')
			await expect.poll(() => childAttempts).toBe(3)
			await expect(retry).toHaveAttribute('aria-disabled', 'true')
			// Even keyboard activation of an aria-disabled button or Enter in the fresh draft must not resend.
			await retry.press('Enter')
			await input.press('Enter')
			expect(requests).toEqual([1, 2, 2, 2])
			await retry.focus()
			releaseRetry()
			await expect(recovery).toHaveCount(0)
			await expect(input).toHaveValue('Independent next draft')
			await expect(input).toBeFocused()
			expect(requests).toEqual([1, 2, 2, 2])
			const parents = created.get(1)!
			const children = created.get(2)!
			expect(parents).toHaveLength(2)
			expect(children).toHaveLength(2)
			const headers = {Authorization: `Bearer ${userToken}`}
			for (const project of [1, 2]) {
				const response = await apiContext.get(`/api/v2/projects/${project}/tasks`, {headers})
				expect(response.ok()).toBe(true)
				const stored: StoredTask[] = (await response.json()).items
				expect(stored.map(task => task.id).sort((a, b) => a - b))
					.toEqual(created.get(project)!.map(task => task.id).sort((a, b) => a - b))
			}
			for (const [index, child] of children.entries()) {
				const response = await apiContext.get(`/api/v2/tasks/${child.id}`, {headers})
				expect(response.ok()).toBe(true)
				const stored: StoredTask = await response.json()
				expect(stored.related_tasks?.parenttask?.map(task => task.id)).toEqual([parents[index].id])
			}
			await page.screenshot({path: testInfo.outputPath(`bulk-create-recovered-${width}.png`)})
			await page.reload()
			const topLevel = page.locator('.list-view .tasks > [data-task-id]')
			await expect(topLevel).toHaveCount(2)
			expect(await topLevel.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-task-id'))).sort((a, b) => a - b)))
				.toEqual(parents.map(task => task.id).sort((a, b) => a - b))
			for (const [index, parent] of parents.entries()) {
				const parentRow = page.locator(`.list-view .tasks > [data-task-id="${parent.id}"]`)
				await expect(parentRow).toHaveAttribute('data-project-id', '1')
				await expect(parentRow.locator(':scope > .single-task .task-link')).toHaveText('Same')
				const nested = parentRow.locator('.subtask-branch > [data-task-id]')
				await expect(nested).toHaveCount(1)
				await expect(nested).toHaveAttribute('data-task-id', String(children[index].id))
				await expect(nested).toHaveAttribute('data-project-id', '2')
				await expect(nested.locator('.task-link')).toHaveText('Child')
				await expect(nested.locator('.task-project')).toHaveText('Two')
			}
		} finally { releaseRetry() }
	})
}
