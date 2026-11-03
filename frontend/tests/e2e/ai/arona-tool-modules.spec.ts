import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'
import {updateUserSettings} from '../../support/updateUserSettings'

// SQL fixtures reuse user IDs; encrypted account preferences live in the
// isolated API's file directory and therefore need their own explicit reset.
test.beforeEach(async ({apiContext, userToken}) => {
	const api = `${apiRootUrl(process.env.API_URL!)}/api/v2`
	const headers = {Authorization: `Bearer ${userToken}`}
	const response = await apiContext.get(`${api}/ai/preferences`, {headers})
	expect(response.ok()).toBe(true)
	const previous = await response.json()
	const saved = await apiContext.post(`${api}/ai/preferences`, {headers, data: {
		revision: previous.revision ?? 0, default_profile: 'ask', profiles: [],
	}})
	expect(saved.ok()).toBe(true)
})

for (const scenario of [
	{width: 1440, language: 'en', title: 'Tool capabilities', projects: 'Projects and tasks', compass: 'Compass', preferences: 'Scenarios & preferences', template: 'Save a personal template', save: 'Save as new template', makeDefault: 'Make my default', apply: 'Use for upcoming messages'},
	{width: 390, language: 'zh-CN', title: '工具能力范围', projects: '项目与任务', compass: '星图', preferences: '场景与偏好', template: '保存为个人模板', save: '保存为新模板', makeDefault: '设为我的默认', apply: '用于接下来的对话'},
]) {
	test(`tool module controls ${scenario.width}px ${scenario.language} isolate Compass and persist explicit capabilities`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		await page.setViewportSize({width: scenario.width, height: 850})
		await updateUserSettings(apiContext, userToken, {language: scenario.language})
		await page.goto('/ai')
		const open = page.getByRole('button', {name: scenario.title, exact: true})
		await open.click()
		const picker = page.locator('.tool-module-picker')
		const projects = picker.getByRole('combobox', {name: scenario.projects, exact: true})
		const compass = picker.getByRole('combobox', {name: scenario.compass, exact: true})
		await expect(projects).toHaveValue('read')
		await expect(compass).toHaveValue('off')
		await compass.selectOption('write')
		await expect(projects).toHaveValue('read')
		await expect(compass).toHaveValue('write')
		await projects.selectOption('off')
		await expect(projects).toHaveValue('off')
		await page.screenshot({path: testInfo.outputPath('tool-module-picker.png')})
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.keyboard.press('Escape')
		await expect(picker).not.toBeVisible()
		await expect(open).toBeFocused()

		await page.getByRole('button', {name: scenario.preferences, exact: true}).click()
		const panel = page.getByRole('dialog', {name: scenario.preferences})
		const capabilitySection = panel.getByRole('region', {name: scenario.title})
		await expect(capabilitySection.getByRole('combobox', {name: scenario.projects, exact: true})).toHaveValue('off')
		await expect(capabilitySection.getByRole('combobox', {name: scenario.compass, exact: true})).toHaveValue('write')
		await panel.getByLabel(scenario.template, {exact: true}).fill('Only Compass')
		await panel.getByRole('button', {name: scenario.save, exact: true}).click()
		await panel.getByRole('button', {name: scenario.makeDefault, exact: true}).click()
		await panel.getByRole('button', {name: scenario.apply, exact: true}).click()
		const api = `${apiRootUrl(process.env.API_URL!)}/api/v2`
		const response = await apiContext.get(`${api}/ai/preferences`, {headers: {Authorization: `Bearer ${userToken}`}})
		expect(response.ok()).toBe(true)
		const saved = await response.json()
		expect(saved.profiles.find((profile: {name: string}) => profile.name === 'Only Compass').options).toMatchObject({
			mode: 'write', tool_modules: {project_tasks: 'off', compass: 'write'},
		})
		// Read the account template from the server, without relying on the tab's saved draft options.
		await page.evaluate(() => sessionStorage.clear())
		await page.reload()
		await open.click()
		await expect(projects).toHaveValue('off')
		await expect(compass).toHaveValue('write')
		await page.keyboard.press('Escape')
	})
}
