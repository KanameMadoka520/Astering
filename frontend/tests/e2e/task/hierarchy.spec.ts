import {test, expect} from '../../support/fixtures'
import {createProjects} from '../project/prepareProjects'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {UserFactory} from '../../factories/user'
import {ProjectFactory} from '../../factories/project'
import {TaskRelationFactory} from '../../factories/task_relation'

for (const width of [1440, 390]) {
	test(`task hierarchy is visible and expandable across list board and table at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		test.setTimeout(60_000)
		page.setDefaultTimeout(10_000)
		await createProjects(1)
		await TaskFactory.create(5, {title: i => ['Launch plan', 'Design work', 'Review draft', 'Ordinary relation', 'Second parent'][i - 1]})
		await BucketFactory.create(1, {id: 1, project_view_id: 4})
		await TaskBucketFactory.create(5, {task_id: i => i, bucket_id: 1, project_view_id: 4})
		for (const [parent, child, kind] of [[1, 2, 'subtask'], [2, 3, 'subtask'], [5, 2, 'subtask'], [1, 4, 'related']] as const) {
			const response = await apiContext.post(`/api/v2/tasks/${parent}/relations`, {headers: {Authorization: `Bearer ${userToken}`}, data: {other_task_id: child, relation_kind: kind}})
			expect(response.ok()).toBe(true)
		}
		await page.setViewportSize({width, height: 900})
		await page.goto('/projects/1/1')
		await expect(page.locator('.tasks .task-link', {hasText: 'Design work'})).toHaveCount(1)
		await expect(page.locator('.subtask-nested .task-link', {hasText: 'Review draft'})).toBeVisible()
		await expect(page.locator('.tasks > [data-task-id="4"]')).toBeVisible()
		const parent = page.locator('.single-task').filter({has: page.locator('.task-link', {hasText: 'Launch plan'})})
		await parent.getByRole('button', {name: 'Collapse subtasks of Launch plan', exact: true}).click()
		await expect(page.locator('.tasks .task-link', {hasText: 'Design work'})).toHaveCount(0)
		await parent.getByRole('button', {name: 'Expand subtasks of Launch plan', exact: true}).click()
		await expect(page.locator('.tasks .task-link', {hasText: 'Review draft'})).toBeVisible()
		const child = page.locator('.single-task').filter({has: page.locator('.task-link', {hasText: 'Design work'})})
		await expect(child).toContainText('Parent: Launch plan')
		await expect(child).toContainText('Parent: Second parent')
		await page.locator('.single-task').filter({has: page.locator('.task-link', {hasText: 'Review draft'})}).locator('.fancy-checkbox').click()
		await expect(child).toContainText('Subtasks 1/1 done')
		await expect(child.locator('input[type="checkbox"]')).not.toBeChecked()
		await page.screenshot({path: testInfo.outputPath('hierarchy-list.png'), fullPage: true})
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.goto('/projects/1/4')
		const card = page.locator('.kanban .task[data-task-id="2"]')
		await expect(card).toContainText('Parent: Launch plan')
		await card.locator('.subtasks-preview summary').click()
		await expect(card.locator('.subtasks-preview')).toContainText('Review draft')
		await expect(page).toHaveURL(/\/projects\/1\/4$/)
		await page.screenshot({path: testInfo.outputPath('hierarchy-board.png')})
		await page.goto('/projects/1/3')
		const tableRow = page.locator('tbody tr').filter({has: page.getByRole('link', {name: 'Design work', exact: true})})
		await expect(tableRow).toContainText('Parent: Launch plan')
		await tableRow.locator('.subtasks-preview summary').click()
		await expect(tableRow).toContainText('Review draft')
		await page.reload()
		await expect(tableRow).toContainText('Subtasks 1/1 done')
	})
}

test('removing a relation updates the board behind the detail dialog', async ({authenticatedPage: page, apiContext, userToken}) => {
	await createProjects(1)
	await TaskFactory.create(2, {title: i => i === 1 ? 'Parent work' : 'Child work'})
	await BucketFactory.create(1, {id: 1, project_view_id: 4})
	await TaskBucketFactory.create(2, {task_id: i => i, bucket_id: 1, project_view_id: 4})
	await apiContext.post('/api/v2/tasks/1/relations', {headers: {Authorization: `Bearer ${userToken}`}, data: {other_task_id: 2, relation_kind: 'subtask'}})
	await page.goto('/projects/1/4')
	await page.locator('.kanban-card__title-link', {hasText: 'Parent work'}).click()
	await expect(page.locator('.task-view')).toBeVisible()
	await page.locator('.task-relations .remove').click()
	const confirmation = page.getByRole('dialog', {name: 'Delete Task Relation', exact: true})
	await expect(confirmation).toContainText('Child work')
	await confirmation.locator('[data-cy="modalPrimary"]').click()
	await expect(confirmation).not.toBeVisible()
	// Close the task modal using Escape without reloading the board cache.
	await page.keyboard.press('Escape')
	await expect(page.locator('.kanban-card__title-link', {hasText: 'Parent work'})).toBeVisible()
	await expect(page.locator('.kanban .task-hierarchy-summary')).toHaveCount(0)
	await page.reload()
	await expect(page.locator('.kanban .task-hierarchy-summary')).toHaveCount(0)
})

test('parent hints never reveal an inaccessible project task', async ({authenticatedPage: page}) => {
	await createProjects(1)
	await UserFactory.create(1, {id: 2}, false)
	await ProjectFactory.create(1, {id: 2, owner_id: 2, title: 'Private project'}, false)
	await TaskFactory.create(1, {id: 1, title: 'Visible child'})
	await TaskFactory.create(1, {id: 2, title: 'Secret parent title', project_id: 2, created_by_id: 2}, false)
	await TaskRelationFactory.create(1, {task_id: 1, other_task_id: 2, relation_kind: 'parenttask'})
	await TaskRelationFactory.create(1, {id: 2, task_id: 2, other_task_id: 1, relation_kind: 'subtask'}, false)
	await page.goto('/projects/1/1')
	await expect(page.locator('.task-link', {hasText: 'Visible child'})).toBeVisible()
	await expect(page.locator('.task-hierarchy-summary')).toHaveCount(0)
	await expect(page.locator('body')).not.toContainText('Secret parent title')
})
