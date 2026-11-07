import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {Factory} from '../../support/factory'
import {BucketFactory} from '../../factories/bucket'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {TaskFactory} from '../../factories/task'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {TaskRelationFactory} from '../../factories/task_relation'
import {UserFactory} from '../../factories/user'
import {UserProjectFactory} from '../../factories/users_project'

class TaskPositionFactory extends Factory {
	static table = 'task_positions'
}

type Card = {id: number, title: string, bucket: number, position: number, done?: boolean}

// A long production column whose phase card sorts last (page 2), a cross-column family, a shared child
// and a display cycle, like a big multi-phase personal project.
const steps: Card[] = Array.from({length: 27}, (_, i) => ({
	id: i + 1,
	title: `Step ${String(i + 1).padStart(2, '0')}`,
	bucket: 1,
	position: i + 1,
	done: i < 2,
}))
const cards: Card[] = [
	...steps,
	{id: 40, title: 'Phase A', bucket: 1, position: 100},
	{id: 30, title: 'Step 30', bucket: 2, position: 1},
	{id: 31, title: 'Step 31', bucket: 2, position: 2},
	{id: 32, title: 'Step 32', bucket: 2, position: 3},
	{id: 41, title: 'Phase B', bucket: 2, position: 50},
	{id: 50, title: 'Total goal', bucket: 2, position: 60},
	{id: 60, title: 'Side quest', bucket: 3, position: 1, done: true},
	{id: 35, title: 'Step 35', bucket: 3, position: 2, done: true},
	{id: 70, title: 'Loop X', bucket: 3, position: 3, done: true},
	{id: 71, title: 'Loop Y', bucket: 3, position: 4, done: true},
]
const subtasks: [parent: number, child: number][] = [
	...steps.map(step => [40, step.id] as [number, number]),
	[40, 30],
	[50, 40],
	[50, 41],
	[41, 31],
	[41, 32],
	[41, 35],
	[60, 31],
	[70, 71],
	[71, 70],
]

async function seedRelations(edges: [number, number][]) {
	// Both directions, as the API stores them.
	await TaskRelationFactory.create(edges.length * 2, {
		id: (i: number) => i,
		task_id: (i: number) => i % 2 ? edges[(i - 1) / 2][0] : edges[i / 2 - 1][1],
		other_task_id: (i: number) => i % 2 ? edges[(i - 1) / 2][1] : edges[i / 2 - 1][0],
		relation_kind: (i: number) => i % 2 ? 'subtask' : 'parenttask',
	})
}

async function seedProjectBoard(titles: Record<number, string> = {}) {
	await ProjectFactory.create(1, {id: 1, title: 'Video plan'})
	await ProjectViewFactory.create(1, {
		id: 4,
		project_id: 1,
		title: 'Board',
		view_kind: 3,
		bucket_configuration_mode: 1,
		done_bucket_id: 3,
	})
	await BucketFactory.create(4, {
		id: (i: number) => i,
		project_view_id: 4,
		title: (i: number) => ['Production', 'Review', 'Published', 'Later'][i - 1],
		position: (i: number) => i,
	})
	await TaskFactory.create(cards.length, {
		id: (i: number) => cards[i - 1].id,
		index: (i: number) => cards[i - 1].id,
		title: (i: number) => titles[cards[i - 1].id] ?? cards[i - 1].title,
		done: (i: number) => cards[i - 1].done ?? false,
		project_id: 1,
	})
	await TaskBucketFactory.create(cards.length, {
		task_id: (i: number) => cards[i - 1].id,
		bucket_id: (i: number) => cards[i - 1].bucket,
		project_view_id: 4,
	})
	await TaskPositionFactory.create(cards.length, {
		task_id: (i: number) => cards[i - 1].id,
		project_view_id: 4,
		position: (i: number) => cards[i - 1].position,
	})
	await seedRelations(subtasks)
}

const column = (page: Page, title: string) => page.locator('.kanban .bucket').filter({has: page.locator('.bucket-header', {hasText: title})})
const row = (page: Page, bucket: number, task: number) => page.locator(`.kanban-tree-row[data-tree-bucket="${bucket}"][data-tree-task="${task}"]`)

async function useGroups(page: Page) {
	const groups = page.getByRole('button', {name: 'Groups', exact: true})
	await groups.click()
	await expect(groups).toHaveAttribute('aria-pressed', 'true')
}

async function readTask(apiContext: APIRequestContext, token: string, id: number) {
	const response = await apiContext.get(`/api/v2/tasks/${id}`, {headers: {Authorization: `Bearer ${token}`}})
	expect(response.ok()).toBe(true)
	return response.json()
}

test.describe('Kanban groups', () => {
	test('parent hints can be hidden reversibly without removing cards or relations', async ({authenticatedPage: page, apiContext, userToken}) => {
		await seedProjectBoard()
		await page.setViewportSize({width: 1440, height: 900})
		await page.goto('/projects/1/4')
		const child = page.locator('.kanban .task[data-task-id="1"]')
		const toggle = page.getByRole('button', {name: 'Show parent tasks', exact: true})
		await expect(child.locator('.parent-task-link')).toContainText('Phase A')
		const initialHeight = (await child.boundingBox())!.height
		await toggle.click()
		await expect(toggle).toHaveAttribute('aria-pressed', 'false')
		await expect(child.locator('.task-hierarchy-summary')).toHaveCount(0)
		await expect(child).toBeVisible()
		expect((await child.boundingBox())!.height).toBeLessThan(initialHeight)
		await page.reload()
		await expect(toggle).toHaveAttribute('aria-pressed', 'false')
		await expect(child.locator('.parent-task-link')).toHaveCount(0)
		const stored = await readTask(apiContext, userToken, 1)
		expect(stored.related_tasks.parenttask.some((task: {id: number}) => task.id === 40)).toBe(true)
		await toggle.click()
		await expect(child.locator('.parent-task-link')).toContainText('Phase A')
	})

	test('groups a long multi-column project honestly, across pages, completion, focus and moves', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		test.setTimeout(90_000)
		await seedProjectBoard()
		await page.setViewportSize({width: 1440, height: 900})
		await page.goto('/projects/1/4')

		// Cards stay the default; switching keeps the route and the board.
		await expect(page.getByRole('button', {name: 'Cards', exact: true})).toHaveAttribute('aria-pressed', 'true')
		await expect(page.locator('.kanban .task[data-task-id="1"]')).toBeVisible()
		await useGroups(page)
		await expect(page).toHaveURL(/\/projects\/1\/4$/)
		await expect(page.locator('.kanban .task')).toHaveCount(0)

		// Page 1 of Production holds 25 steps; their phase card is on page 2, so the header is only context.
		const production = column(page, 'Production')
		const phaseContext = production.locator('.kanban-tree-context')
		await expect(phaseContext).toContainText('Context')
		await expect(phaseContext).toContainText('Phase A')
		await expect(phaseContext).toContainText('Parent card is not among the loaded cards')
		await expect(phaseContext).toContainText('Progress unavailable')
		await expect(phaseContext).toContainText('25 cards here')
		await expect(production.locator('.kanban-tree-row')).toHaveCount(25)
		await expect(production).toContainText('25 of 28 loaded')

		// Collapse by keyboard; the collapse survives the phase card arriving with the next page.
		const contextToggle = phaseContext.getByRole('button', {name: 'Collapse subtasks of Phase A'})
		await contextToggle.focus()
		await page.keyboard.press('Enter')
		await expect(production.locator('.kanban-tree-children .kanban-tree-row')).toHaveCount(0)
		await production.getByRole('button', {name: 'Load more'}).click()
		const phaseA = row(page, 1, 40)
		await expect(phaseA).toBeVisible()
		await expect(phaseA).toContainText('2 of 28 direct subtasks done')
		await expect(phaseA).toContainText('27 cards here')
		await expect(phaseA.locator('.kanban-tree-trail')).toContainText('Total goal')
		await expect(phaseA.getByRole('button', {name: 'Expand subtasks of Phase A'})).toHaveAttribute('aria-expanded', 'false')
		await expect(production).not.toContainText('of 28 loaded')
		await phaseA.getByRole('button', {name: 'Expand subtasks of Phase A'}).press('Space')
		await expect(production.locator('.kanban-tree-row')).toHaveCount(28)

		// Review: a lone child of a phase in another column carries its trail instead of a header.
		const review = column(page, 'Review')
		await expect(row(page, 2, 30).locator('.kanban-tree-trail')).toContainText('Total goal › Phase A')
		await expect(row(page, 2, 50)).toContainText('0 of 2 direct subtasks done')
		await expect(row(page, 2, 41)).toContainText('1 of 3 direct subtasks done')
		await expect(row(page, 2, 31).locator('.kanban-tree-others')).toContainText('Also a subtask of Side quest')
		// Every card exactly once in its own column, the display cycle included.
		for (const card of cards) await expect(row(page, card.bucket, card.id)).toHaveCount(1)
		await expect(column(page, 'Later')).toContainText('Add a task')
		await page.screenshot({path: testInfo.outputPath('groups-desktop.png')})

		// Completing a child updates its parent's progress; the done column takes the card, as in Cards mode.
		await row(page, 2, 32).getByRole('checkbox', {name: 'Mark Step 32 as done'}).click()
		await expect(row(page, 2, 41)).toContainText('2 of 3 direct subtasks done')
		await expect(row(page, 3, 32)).toBeVisible()
		await expect(column(page, 'Published').locator('.kanban-tree-context')).toContainText('Parent card is in Review')
		expect((await readTask(apiContext, userToken, 32)).done).toBe(true)
		expect((await readTask(apiContext, userToken, 41)).done).toBe(false)

		// Focus a family across columns; nothing is silently hidden.
		const focusButton = row(page, 2, 41).getByRole('button', {name: 'Focus on Phase B'})
		await focusButton.click()
		const focusBar = page.locator('.kanban-focus-bar')
		await expect(focusBar).toContainText('Focused on')
		await expect(focusBar).toContainText('Phase B')
		await expect(focusBar).toContainText('2 of 3 direct subtasks done')
		await expect(focusBar).toContainText('4 of 37 loaded cards shown')
		await expect(focusBar.getByRole('heading')).toBeFocused()
		await expect(production).toContainText('No loaded card of this group is in this column.')
		await expect(production).toContainText('28 loaded cards are outside the focus')
		await expect(review.locator('.kanban-tree-row')).toHaveCount(2)
		await expect(column(page, 'Published').locator('.kanban-tree-row')).toHaveCount(2)
		await page.screenshot({path: testInfo.outputPath('groups-focus.png')})
		// A task opened from the focus bar opens over the board; closing it keeps the focus.
		await focusBar.getByRole('link', {name: 'Phase B'}).click()
		await expect(page.locator('.task-view')).toBeVisible()
		await expect(page).toHaveURL(/\/tasks\/41/)
		// Pressed twice at once: the second Escape reaches the dialog while it fades out and must neither step
		// back in history (reopening the task) nor end the focus.
		await page.keyboard.press('Escape')
		await page.keyboard.press('Escape')
		await expect(page.locator('dialog.task-detail-view-modal')).toHaveCount(0)
		await expect(page).toHaveURL(/\/projects\/1\/4$/)
		await expect(page.locator('.task-view')).toHaveCount(0)
		await expect(focusBar).toBeVisible()
		await focusBar.getByRole('heading').focus()
		await page.keyboard.press('Escape')
		await expect(focusBar).toHaveCount(0)
		await expect(focusButton).toBeFocused()
		await expect(production.locator('.kanban-tree-row')).toHaveCount(28)

		// Moving is an explicit, labelled action that keeps the stored order value.
		await row(page, 2, 30).getByRole('combobox', {name: 'Move Step 30 to another column'}).selectOption({label: 'Production'})
		await expect(page.locator('.global-notification .vue-notification.success')).toContainText('Moved Step 30 to Production.')
		await expect(row(page, 1, 30)).toBeVisible()
		await expect(row(page, 1, 30).locator('.kanban-tree-row__title')).toBeFocused()

		// The choice and the expanded group are remembered for this view after a reload.
		await page.reload()
		await expect(page.getByRole('button', {name: 'Groups', exact: true})).toHaveAttribute('aria-pressed', 'true')
		await expect(row(page, 1, 30)).toBeVisible()
		await expect(column(page, 'Production').locator('.kanban-tree-context button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true')
		await page.getByRole('button', {name: 'Cards', exact: true}).click()
		await expect(page.locator('.kanban .task[data-task-id="30"]')).toBeVisible()
		await expect(page.locator('.kanban-tree')).toHaveCount(0)
	})

	test('a search shows matching children even inside a group collapsed earlier', async ({authenticatedPage: page}) => {
		await seedProjectBoard()
		await page.goto('/projects/1/4')
		await useGroups(page)
		const production = column(page, 'Production')
		await production.getByRole('button', {name: 'Collapse subtasks of Phase A'}).click()
		await expect(production.locator('.kanban-tree-row')).toHaveCount(0)

		await page.goto('/projects/1/4?s=Step%200')
		await expect(production.locator('.kanban-tree-row')).toHaveCount(9)
		await expect(production.locator('.kanban-tree-context')).toContainText('Phase A')
		// The parent did not match: it is context, never pulled in as a card.
		await expect(row(page, 1, 40)).toHaveCount(0)

		await page.goto('/projects/1/4')
		await expect(production.getByRole('button', {name: 'Expand subtasks of Phase A'})).toHaveAttribute('aria-expanded', 'false')
	})

	test('a filter-configured board keeps a task in every column that returns it and offers no manual move', async ({authenticatedPage: page}) => {
		await ProjectFactory.create(1, {id: 1, title: 'Dynamic plan'})
		await ProjectViewFactory.create(1, {
			id: 4,
			project_id: 1,
			title: 'Dynamic',
			view_kind: 3,
			bucket_configuration_mode: 2,
			bucket_configuration: JSON.stringify([
				{title: 'Open', filter: {filter: 'done = false'}},
				{title: 'All', filter: {filter: 'done = false || done = true'}},
			]),
		})
		await TaskFactory.create(3, {
			id: (i: number) => i,
			title: (i: number) => ['Phase P', 'Step P1', 'Step P2'][i - 1],
			done: (i: number) => i === 3,
			project_id: 1,
		})
		await seedRelations([[1, 2], [1, 3]])
		await page.goto('/projects/1/4')
		await useGroups(page)

		await expect(page.locator('.kanban-tree-row[data-tree-task="2"]')).toHaveCount(2)
		await expect(page.locator('.kanban-tree-row[data-tree-task="3"]')).toHaveCount(1)
		await expect(column(page, 'All').locator('.kanban-tree-row[data-tree-task="1"]')).toContainText('1 of 2 direct subtasks done')
		await expect(page.locator('.kanban-tree-row select')).toHaveCount(0)
		await expect(page.locator('.kanban-tree-row').getByRole('checkbox').first()).toBeVisible()
	})

	test('a saved filter decides completion per source project', async ({authenticatedPage: page, apiContext, userToken}) => {
		const headers = {Authorization: `Bearer ${userToken}`}
		await UserFactory.create(1, {id: 2, username: 'owner2'}, false)
		await ProjectFactory.create(1, {id: 1, title: 'Mine'})
		await ProjectFactory.create(1, {id: 2, owner_id: 2, title: 'Shared read-only'}, false)
		await UserProjectFactory.create(1, {project_id: 2, user_id: 1, permission: 0})
		await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Own step'})
		await TaskFactory.create(1, {id: 2, project_id: 2, title: 'Shared step', created_by_id: 2}, false)
		const response = await apiContext.post('/api/v2/filters', {headers, data: {title: 'Open steps', filters: {filter: 'done = false'}}})
		expect(response.ok()).toBe(true)
		const projectId = -(await response.json()).id - 1
		await ProjectViewFactory.create(1, {id: 80, project_id: projectId, view_kind: 3, bucket_configuration_mode: 1})
		await BucketFactory.create(1, {id: 1, project_view_id: 80, title: 'Queue'})
		await TaskBucketFactory.create(2, {task_id: (i: number) => i, bucket_id: 1, project_view_id: 80})
		await page.goto(`/projects/${projectId}/80`)
		await useGroups(page)

		await expect(row(page, 1, 1).getByRole('checkbox', {name: 'Mark Own step as done'})).toBeVisible()
		await expect(row(page, 1, 2)).toBeVisible()
		await expect(row(page, 1, 2).getByRole('checkbox')).toHaveCount(0)
		await expect(row(page, 1, 2).locator('.kanban-tree-check')).toHaveAttribute('aria-label', 'Not completed')
	})
})

test.describe('Kanban groups on a phone', () => {
	test.use({viewport: {width: 390, height: 844}, hasTouch: true})

	// Real sibling titles share a long prefix and differ near the end; they must never be cut to the prefix.
	const longTitles: Record<number, string> = {
		3: '【第三阶段·角色剧情】视频制作：第十二集 结局分支 A（夜之章）',
		4: '【第三阶段·角色剧情】视频制作：第十二集 结局分支 B（晨之章）',
		40: '【第三阶段·角色剧情】全部视频与配乐整理',
	}

	test('groups fit a 390px touch screen with full titles and 44px targets', async ({authenticatedPage: page}, testInfo) => {
		await seedProjectBoard(longTitles)
		await page.emulateMedia({reducedMotion: 'reduce'})
		await page.goto('/projects/1/4')
		await useGroups(page)
		const production = column(page, 'Production')
		await expect(production.locator('.kanban-tree-context')).toContainText(longTitles[40])
		await production.locator('.tasks').evaluate(element => {
			element.scrollTop = element.scrollHeight
		})
		await row(page, 1, 40).scrollIntoViewIfNeeded()
		await expect(row(page, 1, 40)).toBeVisible()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

		for (const id of [3, 4]) {
			const title = row(page, 1, id).locator('.kanban-tree-row__title')
			await expect(title).toHaveText(longTitles[id])
			const clipped = await title.evaluate(element => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
			expect(clipped).toBe(false)
			const rowBox = await row(page, 1, id).boundingBox()
			const titleBox = await title.boundingBox()
			expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
		}
		for (const control of [
			row(page, 1, 3).getByRole('checkbox'),
			row(page, 1, 3).locator('.kanban-move'),
			row(page, 1, 40).getByRole('button', {name: /Collapse subtasks of/}),
		]) {
			const box = await control.boundingBox()
			expect(box!.width).toBeGreaterThanOrEqual(43.5)
			expect(box!.height).toBeGreaterThanOrEqual(43.5)
		}
		await page.screenshot({path: testInfo.outputPath('groups-mobile.png')})

		await row(page, 1, 40).getByRole('button', {name: /^Focus on/}).click()
		await expect(page.locator('.kanban-focus-bar')).toBeVisible()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath('groups-mobile-focus.png')})
	})
})
