import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {BucketFactory} from '../../factories/bucket'
import {TaskFactory} from '../../factories/task'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {Factory} from '../../support/factory'
import {updateUserSettings} from '../../support/updateUserSettings'
import {UserFactory} from '../../factories/user'
import {UserProjectFactory} from '../../factories/users_project'

class TaskPositionFactory extends Factory {
	static table = 'task_positions'
}

const longColumn = '第三阶段：整理全部研究资料、逐项核对并完成可以对外分享的最终成果'
const longTask = '核对项目交付资料：确保中文长标题与最后一部分的重要信息也能完整阅读，不能只显示开头'
const columns = [longColumn, 'Next', 'Review', 'Waiting', 'Later', 'Final']

async function seedBoard(owner = 1) {
	await ProjectFactory.create(1, {id: 1, title: 'Mobile collaboration board', owner_id: owner})
	await ProjectViewFactory.create(1, {
		id: 4,
		project_id: 1,
		title: 'Board',
		view_kind: 3,
		bucket_configuration_mode: 1,
	})
	await BucketFactory.create(columns.length, {
		id: (i: number) => i,
		project_view_id: 4,
		title: (i: number) => columns[i - 1],
		position: (i: number) => i * 100,
	})
	await TaskFactory.create(31, {
		id: (i: number) => i,
		project_id: 1,
		title: (i: number) => i === 1 ? longTask : `Task ${i}`,
	})
	await TaskBucketFactory.create(31, {
		task_id: (i: number) => i,
		bucket_id: 1,
		project_view_id: 4,
	})
	await TaskPositionFactory.create(31, {
		task_id: (i: number) => i,
		project_view_id: 4,
		position: (i: number) => i * 100,
	})
}

const lane = (page: Page, id: number) => page.locator(`.kanban .bucket[data-bucket-id="${id}"]`)

async function expectStoredMove(api: APIRequestContext, token: string, bucket: number) {
	const response = await api.get('/api/v2/projects/1/views/4/buckets/tasks', {
		headers: {Authorization: `Bearer ${token}`},
	})
	expect(response.ok()).toBe(true)
	const stored = await response.json()
	expect(stored.items.find((entry: {id: number}) => entry.id === bucket).tasks.some((task: {id: number}) => task.id === 1)).toBe(true)
}

for (const scenario of [
	{language: 'en', width: 390, jump: 'Jump to column', previous: 'Previous column', next: 'Next column'},
	{language: 'zh-CN', width: 320, jump: '跳转到栏目', previous: '上一栏目', next: '下一栏目'},
]) {
	test.describe(`Mobile board ${scenario.language} ${scenario.width}px`, () => {
		test.use({viewport: {width: scenario.width, height: 844}, hasTouch: true})

		test('reads full titles, reaches every card, moves to distant columns and submits with a visible button', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
			test.setTimeout(90_000)
			await seedBoard()
			await updateUserSettings(apiContext, userToken, {language: scenario.language})
			await page.emulateMedia({reducedMotion: 'reduce'})
			await page.goto('/projects/1/4')
			const navigation = page.locator('.kanban-column-navigation')
			const jump = navigation.getByRole('combobox', {name: scenario.jump})
			await expect(jump).toHaveValue('1')
			await expect(navigation.getByRole('button', {name: scenario.previous})).toHaveAttribute('aria-disabled', 'true')
			const heading = lane(page, 1).locator('.bucket-header h2')
			const title = lane(page, 1).locator('.task[data-task-id="1"] h3')
			await expect(heading).toHaveText(longColumn)
			await expect(title).toHaveText(longTask)
			for (const element of [heading, title]) {
				expect(await element.evaluate(el => {
					const style = getComputedStyle(el)
					return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1
						&& parseFloat(style.lineHeight) >= parseFloat(style.fontSize)
				})).toBe(true)
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			const move = lane(page, 1).locator('.task[data-task-id="1"] .kanban-move select')
			const handle = lane(page, 1).locator('.task[data-task-id="1"] .kanban-task-drag-handle')
			for (const control of [move, handle, jump]) {
				expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
			}
			const optionsLabel = scenario.language === 'en' ? 'Bucket options' : '分组选项'
			const options = lane(page, 1).getByRole('button', {name: optionsLabel, exact: true})
			const optionsBounds = (await options.boundingBox())!
			expect(optionsBounds.width).toBeGreaterThanOrEqual(43.5)
			expect(optionsBounds.height).toBeGreaterThanOrEqual(43.5)
			// A transparent drag overlay must not intercept the actual native picker.
			expect(await move.evaluate(el => {
				const rect = el.getBoundingClientRect()
				return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
			})).toBe(true)
			await page.screenshot({path: testInfo.outputPath('board-mobile-titles.png')})
			await lane(page, 1).getByRole('link', {name: longTask, exact: true}).tap()
			await expect(page).toHaveURL(/\/tasks\/1$/)
			await page.keyboard.press('Escape')
			await expect(page).toHaveURL(/\/projects\/1\/4$/)
			await expect(lane(page, 1).locator('.task')).toHaveCount(25)
			await lane(page, 1).locator('.tasks').evaluate(el => { el.scrollTop = el.scrollHeight })
			await expect(lane(page, 1).locator('.task')).toHaveCount(31)
			await lane(page, 1).locator('.task[data-task-id="31"]').scrollIntoViewIfNeeded()
			await expect(lane(page, 1).locator('.task[data-task-id="31"]')).toBeInViewport()
			await lane(page, 1).locator('.tasks').evaluate(el => { el.scrollTop = 0 })
			const collapseLabel = scenario.language === 'en' ? 'Collapse this bucket' : '折叠此分组'
			const collapseLastColumn = async () => {
				await jump.selectOption('6')
				await lane(page, 6).getByRole('button', {name: optionsLabel, exact: true}).click()
				await lane(page, 6).getByRole('button', {name: collapseLabel, exact: true}).click()
				await expect(lane(page, 6)).toHaveClass(/is-collapsed/)
				await jump.selectOption('1')
			}
			await collapseLastColumn()
			await jump.selectOption('6')
			await expect(lane(page, 6)).not.toHaveClass(/is-collapsed/)
			await expect(lane(page, 6)).toBeInViewport()
			await collapseLastColumn()
			await move.selectOption('6')
			await expect(lane(page, 6)).not.toHaveClass(/is-collapsed/)
			await expect(lane(page, 6).locator('.task[data-task-id="1"]')).toBeInViewport()
			await expect(jump).toHaveValue('6')
			await expect(page).toHaveURL(/\/projects\/1\/4$/)
			await expect(navigation.getByRole('button', {name: scenario.next})).toHaveAttribute('aria-disabled', 'true')
			await expectStoredMove(apiContext, userToken, 6)
			await jump.selectOption('3')
			await expect(lane(page, 3)).toBeInViewport()
			await navigation.getByRole('button', {name: scenario.previous}).click()
			await expect(jump).toHaveValue('2')
			const addLabel = scenario.language === 'en' ? 'Add a task' : '添加任务'
			await lane(page, 2).getByRole('button', {name: addLabel, exact: true}).click()
			await lane(page, 2).getByRole('textbox', {name: addLabel, exact: true}).fill('Created with the mobile submit button')
			await lane(page, 2).locator('form button[type="submit"]').click()
			await expect(lane(page, 2).locator('.task')).toContainText('Created with the mobile submit button')
			const addColumn = scenario.language === 'en' ? 'Create a bucket' : '新建分组'
			await navigation.getByRole('button', {name: addColumn, exact: true}).click()
			const columnDraft = page.locator('.new-bucket input')
			await columnDraft.fill('Created on a phone')
			await jump.selectOption('1')
			await navigation.getByRole('button', {name: addColumn, exact: true}).click()
			await expect(columnDraft).toHaveValue('Created on a phone')
			await page.locator('.new-bucket form button[type="submit"]').click()
			await expect(page.locator('.bucket-header h2', {hasText: 'Created on a phone'})).toBeVisible()
			await page.reload()
			await jump.selectOption('2')
			await expect(lane(page, 2).locator('.task')).toContainText('Created with the mobile submit button')
			await jump.selectOption('6')
			await expect(lane(page, 6)).not.toHaveClass(/is-collapsed/)
			await expect(lane(page, 6).locator('.task[data-task-id="1"]')).toBeInViewport()
			await expect(lane(page, 1).locator('.task[data-task-id="1"]')).toHaveCount(0)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({path: testInfo.outputPath('board-mobile-moved.png')})
		})
	})
}

test('desktop cards can be moved with a labelled picker while retaining normal task links', async ({authenticatedPage: page, apiContext, userToken}) => {
	await seedBoard()
	await page.setViewportSize({width: 1440, height: 900})
	await page.goto('/projects/1/4')
	await expect(page.locator('.kanban-column-navigation')).toHaveCount(0)
	const card = lane(page, 1).locator('.task[data-task-id="1"]')
	const picker = card.getByRole('combobox', {name: `Move ${longTask} to another column`})
	await picker.focus()
	await expect(picker).toBeFocused()
	await picker.selectOption('2')
	const moved = lane(page, 2).locator('.task[data-task-id="1"]')
	await expect(moved.locator('.kanban-card__title-link')).toBeFocused()
	await moved.locator('.kanban-card__title-link').click()
	await expect(page).toHaveURL(/\/tasks\/1$/)
	await expectStoredMove(apiContext, userToken, 2)
})

test.describe('Read-only mobile project', () => {
	test.use({viewport: {width: 390, height: 844}, hasTouch: true})

	test('keeps full titles and column navigation without exposing write controls', async ({authenticatedPage: page}, testInfo) => {
		await UserFactory.create(1, {id: 2, username: 'board-owner'}, false)
		await seedBoard(2)
		await UserProjectFactory.create(1, {project_id: 1, user_id: 1, permission: 0})
		await page.emulateMedia({reducedMotion: 'reduce'})
		await page.goto('/projects/1/4')
		await expect(lane(page, 1).locator('h2')).toHaveText(longColumn)
		await expect(lane(page, 1).locator('h2')).not.toHaveAttribute('contenteditable')
		await expect(page.locator('.kanban .kanban-move')).toHaveCount(0)
		await expect(page.locator('.kanban-task-drag-handle, .bucket-footer, .new-bucket')).toHaveCount(0)
		await expect(page.locator('.kanban-column-navigation button')).toHaveCount(2)
		await page.getByRole('combobox', {name: 'Jump to column'}).selectOption('6')
		await expect(lane(page, 6)).toBeInViewport()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath('board-mobile-readonly.png')})
	})
})
