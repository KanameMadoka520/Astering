import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {apiRootUrl} from '../../support/apiUrl'
import type {Task, TaskRoutine} from '../../../src/client/generated'

const API = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`

for (const width of [1440, 390]) {
	test(`period-end reminder keeps its anchor without any task dates at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}) => {
		await ProjectFactory.create(1, {id: 1})
		await TaskFactory.create(1, {id: 1, project_id: 1, title: 'Weekly quota reminder'})
		const headers = {Authorization: `Bearer ${userToken}`}
		const readRoutine = await apiContext.get(`${API}/tasks/1/routine`, {headers})
		expect(readRoutine.ok()).toBe(true)
		const routine = await readRoutine.json() as TaskRoutine
		const configured = await apiContext.put(`${API}/tasks/1/routine`, {
			headers,
			data: {
				enabled: true,
				paused: false,
				timezone: 'UTC',
				period: 'weekly',
				week_start: 1,
				reset_hour: 4,
				target: 3,
				revision: routine.revision,
			},
		})
		expect(configured.ok()).toBe(true)
		const seeded = await apiContext.patch(`${API}/tasks/1`, {
			headers: {...headers, 'Content-Type': 'application/json-patch+json'},
			data: [{op: 'add', path: '/reminders', value: [{relative_to: 'routine_period_end', relative_period: -300}]}],
		})
		expect(seeded.ok()).toBe(true)
		await page.setViewportSize({width, height: 900})
		await page.goto('/tasks/1')
		const reminder = page.locator('.task-view .reminder-input').first()
		await expect(reminder).toContainText('5 minutes before the end of this routine period')
		await expect(reminder).toContainText('notifies you only if the target has not been reached')
		await reminder.locator('.reminder-trigger').click()
		const editor = page.locator('.reminder-options-popup.is-open')
		await expect(editor.getByRole('spinbutton', {name: 'Amount', exact: true})).toHaveValue('5')
		await expect(editor.getByRole('combobox', {name: 'Before or after', exact: true})).toHaveValue('-1')
		await editor.getByRole('spinbutton', {name: 'Amount', exact: true}).fill('10')
		await editor.getByRole('spinbutton', {name: 'Amount', exact: true}).blur()
		const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
			&& new URL(response.url()).pathname.endsWith('/api/v2/tasks/1'))
		await editor.getByRole('button', {name: 'Confirm', exact: true}).click()
		expect((await saved).ok()).toBe(true)
		const read = await apiContext.get(`${API}/tasks/1`, {headers})
		expect(read.ok()).toBe(true)
		const task = await read.json() as Task
		expect(task.reminders).toHaveLength(1)
		expect(task.reminders?.[0]).toMatchObject({relative_to: 'routine_period_end', relative_period: -600})
		for (const value of [task.due_date, task.start_date, task.end_date]) {
			expect(!value || new Date(value).getUTCFullYear() <= 1).toBe(true)
		}
		await page.reload()
		await expect(reminder).toContainText('10 minutes before the end of this routine period')
		await expect(reminder).toContainText('notifies you only if the target has not been reached')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	})
}
