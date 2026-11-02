import {test, expect} from '../../../support/fixtures'
import {apiRootUrl} from '../../../support/apiUrl'
import {Factory} from '../../../support/factory'
import {UserFactory} from '../../../factories/user'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`

for (const language of ['zh-CN', 'en']) {
	for (const width of [1440, 390]) {
		test.describe(`duplicate chat connection ${language} ${width}px`, () => {
			test.use({currentUser: async ({apiContext}, use) => {
				Factory.setRequestContext(apiContext)
				const [user] = await UserFactory.create(1, {language})
				await use(user)
			}})
			test('copies a server key, isolates drafts and keeps the default', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
				const chinese = language === 'zh-CN'
				const headers = {Authorization: `Bearer ${userToken}`}
				const saved = await apiContext.post(`${api}/ai/settings`, {
					headers,
					data: {
						connections: [{
							id: 'official-fixture',
							name: 'Official fixture',
							kind: 'chat',
							protocol: 'openai-responses',
							base_url: 'https://api.openai.com/v1',
							model: 'gpt-6.1-sol',
							api_key: 'fixture-key-only-no-real-api',
							input_types: ['text', 'image'],
						},
						],
						assistant: 'official-fixture',
						transcription: '',
						cleanup: '',
					},
				})
				expect(saved.ok()).toBeTruthy()
				await page.setViewportSize({width, height: 900})
				await page.goto('/user/settings/ai')
				const source = page.locator('form.connection').first()
				await source.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true}).fill('Unfinished original')
				await source.getByRole('button', {name: chinese ? '复制连接' : 'Duplicate', exact: true}).click()
				const copy = page.locator('form.connection').nth(1)
				await expect(copy.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true})).toBeFocused()
				await expect(copy.getByText(chinese ? '保存时复制密钥' : 'Key will be copied on save', {exact: true})).toBeVisible()
				await expect(copy.getByLabel(chinese ? 'API 密钥' : 'API key', {exact: true})).toHaveValue('')
				await copy.getByLabel(chinese ? 'API 基础地址' : 'API base URL', {exact: true}).fill('https://different.example/v1')
				await copy.getByRole('button', {name: chinese ? '保存此连接' : 'Save this connection', exact: true}).click()
				await expect(copy.getByRole('alert')).toContainText(chinese ? '原连接或密钥发送地址已变化' : 'source connection or key destination changed')
				await copy.getByLabel(chinese ? 'API 基础地址' : 'API base URL', {exact: true}).fill('https://api.openai.com/v1')
				await copy.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true}).fill('GPT-6 Luna fixture')
				await copy.getByRole('combobox', {name: chinese ? '模型 ID' : 'Model ID', exact: true}).fill('gpt-6-luna')
				await page.keyboard.press('Escape')
				const written = page.waitForResponse(response => response.url().endsWith('/ai/settings') && response.request().method() === 'POST')
				await copy.getByRole('button', {name: chinese ? '保存此连接' : 'Save this connection', exact: true}).click()
				const response = await written
				expect(response.ok()).toBeTruthy()
				const result = await response.json()
				expect(result.assistant).toBe('official-fixture')
				expect(result.connections).toHaveLength(2)
				expect(result.connections[0].name).toBe('Official fixture')
				expect(result.connections[1]).toMatchObject({model: 'gpt-6-luna', has_key: true})
				for (const connection of result.connections) {
					expect(connection.api_key).toBeUndefined()
					expect(connection.copy_key_from).toBeUndefined()
				}
				await expect(source.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true})).toHaveValue('Unfinished original')
				await expect(copy.getByText(chinese ? '密钥已存储' : 'Key stored', {exact: true})).toBeVisible()
				await page.screenshot({path: testInfo.outputPath(`connection-copy-${language}-${width}.png`), animations: 'disabled'})
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
				expect(overflow).toBe(false)
				await source.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true}).fill('Official fixture')
				await page.reload()
				await expect(page.locator('form.connection')).toHaveCount(2)
				const reloaded = page.locator('form.connection').nth(1)
				await reloaded.getByRole('button', {name: chinese ? '编辑' : 'Edit', exact: true}).click()
				await expect(reloaded.getByRole('combobox', {name: chinese ? '模型 ID' : 'Model ID', exact: true})).toHaveValue('gpt-6-luna')
				await expect(reloaded.getByLabel(chinese ? 'API 密钥' : 'API key', {exact: true})).toHaveValue('')
			})
		})
	}
}
