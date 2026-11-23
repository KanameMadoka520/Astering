import {test, expect} from '../../support/fixtures'
import {profileOptions} from '../../../src/helpers/assistantProfiles'

test('editing a selected scenario keeps its template target and applies the saved options on reload', async ({
	authenticatedPage: page, apiContext, userToken,
}) => {
	const headers = {Authorization: `Bearer ${userToken}`}
	const path = '/api/v2/ai/preferences'
	const templateID = 'custom-weekly-review'
	const modelID = 'preferences-fixture'
	const settings = await apiContext.post('/api/v2/ai/settings', {
		headers,
		data: {
			connections: [{
				id: modelID,
				name: 'Preferences fixture',
				kind: 'chat',
				protocol: 'openai-chat',
				base_url: 'https://example.com/v1',
				model: modelID,
				api_key: 'public-test-key',
			}],
			assistant: modelID,
			transcription: '',
			cleanup: '',
			persona: 'none',
		},
	})
	expect(settings.ok(), await settings.text()).toBe(true)
	const prior = await apiContext.get(path, {headers})
	expect(prior.ok()).toBe(true)
	const seeded = await apiContext.post(path, {
		headers,
		data: {
			revision: (await prior.json()).revision ?? 0,
			default_profile: 'ask',
			profiles: [{
				id: templateID,
				name: 'Weekly review',
				options: profileOptions('plan'),
			}],
		},
	})
	expect(seeded.ok(), await seeded.text()).toBe(true)

	const openPreferences = async () => {
		await page.getByRole('button', {name: /Open chat configuration/}).click()
		await page.getByRole('button', {name: 'Permissions and execution', exact: true}).click()
		return page.getByRole('dialog', {name: 'Scenarios & preferences'})
	}

	await page.goto('/ai')
	const dialog = await openPreferences()
	const template = dialog.getByLabel('My templates')
	await template.selectOption(templateID)
	const model = dialog.getByLabel('Model connection', {exact: true})
	await model.selectOption(modelID)
	await expect(template).toHaveValue(templateID)
	await dialog.getByText('Advanced execution budget', {exact: true}).click()
	const rounds = dialog.getByRole('spinbutton', {name: /Model requests/})
	await rounds.fill('24')
	await expect(template).toHaveValue(templateID)
	await dialog.getByRole('button', {name: 'Update this template', exact: true}).click()
	await expect(dialog.getByText('Saved to your account.', {exact: true})).toBeVisible()
	await expect(template).toHaveValue(templateID)
	const response = await apiContext.get(path, {headers})
	expect(response.ok()).toBe(true)
	expect((await response.json()).profiles).toMatchObject([{
		id: templateID,
		options: {
			connection_id: modelID,
			max_rounds: 24,
		},
	}])

	await dialog.getByRole('button', {name: 'Use for upcoming messages', exact: true}).click()
	await expect(dialog).toBeHidden()
	await page.reload()
	await openPreferences()
	await expect(template).toHaveValue(templateID)
	await expect(model).toHaveValue(modelID)
	await dialog.getByText('Advanced execution budget', {exact: true}).click()
	await expect(rounds).toHaveValue('24')
})
