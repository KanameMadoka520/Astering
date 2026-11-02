import type {Settings} from '../../../../src/client/generated'
import {test, expect} from '../../../support/fixtures'
import {apiRootUrl} from '../../../support/apiUrl'
import {UserFactory} from '../../../factories/user'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`

test.use({currentUser: async ({apiContext}, use) => {
	// Initialize the fixture transport before the factory seeds this isolated user.
	void apiContext
	const [user] = await UserFactory.create(1, {language: 'zh-CN'})
	await use(user)
}})

test.beforeEach(async ({apiContext, userToken}) => {
	const response = await apiContext.post(`${api}/ai/settings`, {
		headers: {Authorization: `Bearer ${userToken}`},
		data: {
			connections: [],
			assistant: '',
			transcription: '',
			cleanup: '',
		},
	})
	expect(response.ok()).toBeTruthy()
})

function audioFixture() {
	const frames = 3200
	const buffer = Buffer.alloc(44 + frames * 2)
	buffer.write('RIFF', 0)
	buffer.writeUInt32LE(buffer.length - 8, 4)
	buffer.write('WAVEfmt ', 8)
	buffer.writeUInt32LE(16, 16)
	buffer.writeUInt16LE(1, 20)
	buffer.writeUInt16LE(1, 22)
	buffer.writeUInt32LE(16000, 24)
	buffer.writeUInt32LE(32000, 28)
	buffer.writeUInt16LE(2, 32)
	buffer.writeUInt16LE(16, 34)
	buffer.write('data', 36)
	buffer.writeUInt32LE(frames * 2, 40)
	return {
		name: 'speech-fixture.wav',
		mimeType: 'audio/wav',
		buffer,
	}
}

for (const width of [1440, 320]) {
	test(`Alibaba standard regional recognition needs no workspace and separates handshake from audio at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		await page.setViewportSize({width, height: 900})
		await page.goto('/user/settings/ai')
		await page.getByRole('button', {name: /^语音识别/}).click()
		const openProvider = page.getByRole('button', {name: '配置阿里云', exact: true})
		await openProvider.click()
		const dialog = page.getByRole('dialog', {name: '阿里云设置', exact: true})
		const region = dialog.getByRole('combobox', {name: '阿里云服务地域', exact: true})
		await expect(region).toHaveValue('beijing')
		const enhancements = dialog.locator('.speech-options__enhancements')
		await expect(enhancements).not.toHaveAttribute('open')
		await expect(dialog.getByLabel('工作空间 ID', {exact: true})).not.toBeVisible()
		await expect(dialog.getByLabel('工作空间 ID', {exact: true})).not.toHaveAttribute('required')
		await expect(dialog.getByLabel('词表 ID（可选）', {exact: true})).not.toHaveAttribute('required')
		await dialog.getByLabel('API 密钥', {exact: true}).fill('fixture-beijing-key-no-provider-call')
		const selected = dialog.locator('.speech-model').filter({hasText: 'qwen-audio-3.1-asr-flash-streaming'})
		const saved = page.waitForResponse(response => response.url().endsWith('/ai/settings') && response.request().method() === 'POST')
		await selected.getByRole('button', {name: '保存为默认识别模型', exact: true}).click()
		const savedResponse = await saved
		expect(savedResponse.ok()).toBeTruthy()
		const settings = await savedResponse.json() as Settings
		const connection = settings.connections!.find(item => item.id === settings.transcription)!
		expect(connection.base_url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference')
		expect(connection.speech?.workspace_id || '').toBe('')
		expect(connection.speech?.vocabulary_id || '').toBe('')
		expect(connection.api_key).toBeUndefined()

		// Intercept only the test route: these fixtures never contact a speech provider.
		let probes = 0
		let recordings = 0
		await page.route('**/api/v2/ai/test', async route => {
			const body = route.request().postDataJSON()
			expect(body.connection_id).toBe(connection.id)
			if (body.audio) {
				recordings++
				expect(Buffer.from(body.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF')
				await route.fulfill({json: {
					endpoint: connection.base_url,
					text: '这是一段实际文件测试的夹具转写。',
					elapsed_ms: 80,
					audio_duration_ms: 200,
				}})
				return
			}
			probes++
			expect(body.filename).toBe('')
			await route.fulfill({json: {
				endpoint: connection.base_url,
				text: '',
				warning: '此测试仅验证连接握手，不代表识别质量。',
				elapsed_ms: 25,
			}})
		})
		await dialog.getByRole('button', {name: '无音频测试连接', exact: true}).click()
		await expect(dialog.getByText('连接握手已通过', {exact: true})).toBeVisible()
		await expect(dialog.getByText('此测试仅验证连接握手，不代表识别质量。', {exact: true})).toBeVisible()
		await expect(dialog.getByRole('button', {name: '运行识别测试', exact: true})).toHaveAttribute('aria-disabled', 'true')
		expect(probes).toBe(1)
		expect(recordings).toBe(0)
		await dialog.locator('input[type="file"]').setInputFiles(audioFixture())
		await dialog.getByRole('button', {name: '运行识别测试', exact: true}).click()
		await expect(dialog.getByText('这是一段实际文件测试的夹具转写。', {exact: true})).toBeVisible()
		await expect(dialog.getByText('连接握手已通过', {exact: true})).toHaveCount(0)
		expect(recordings).toBe(1)

		await region.selectOption('singapore')
		await expect(dialog.getByText('服务地址、请求协议、工作空间或应用 ID 已更改，请重新输入此配置的 API 密钥。', {exact: true})).toBeVisible()
		const refused = page.waitForResponse(response => response.url().endsWith('/ai/settings') && response.request().method() === 'POST')
		await dialog.getByRole('button', {name: '保存此连接', exact: true}).click()
		expect((await refused).ok()).toBe(false)
		await expect(dialog.getByRole('alert')).toBeVisible()
		const headers = {Authorization: `Bearer ${userToken}`}
		const unchanged = await (await apiContext.get(`${api}/ai/settings`, {headers})).json() as Settings
		expect(unchanged.connections!.find(item => item.id === connection.id)!.base_url).toBe(connection.base_url)
		await dialog.getByLabel('API 密钥', {exact: true}).fill('fixture-singapore-key-no-provider-call')
		const regionalSave = page.waitForResponse(response => response.url().endsWith('/ai/settings') && response.request().method() === 'POST')
		await dialog.getByRole('button', {name: '保存此连接', exact: true}).click()
		expect((await regionalSave).ok()).toBeTruthy()

		// Choosing a second model at the same wire protocol must retain the chosen region.
		const secondModel = dialog.locator('.speech-model').filter({hasText: 'fun-asr-realtime'}).first()
		await secondModel.locator('.speech-model__choose').click()
		const modelSave = page.waitForResponse(response => response.url().endsWith('/ai/settings') && response.request().method() === 'POST')
		await dialog.getByRole('button', {name: '保存此连接', exact: true}).click()
		const modelResponse = await modelSave
		expect(modelResponse.ok()).toBeTruthy()
		const finalSettings = await modelResponse.json() as Settings
		expect(finalSettings.connections!.find(item => item.id === connection.id)).toMatchObject({
			model: 'fun-asr-realtime',
			base_url: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
		})
		await dialog.getByRole('button', {name: '关闭对话框', exact: true}).click()
		await page.reload()
		await page.getByRole('button', {name: /^语音识别/}).click()
		await openProvider.click()
		await expect(region).toHaveValue('singapore')
		await expect(dialog.getByLabel('API 密钥', {exact: true})).toHaveValue('')
		await expect(secondModel.getByRole('button', {name: '当前使用', exact: true})).toBeVisible()
		await expect(dialog.locator('code').filter({hasText: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference'})).toBeVisible()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: testInfo.outputPath(`aliyun-regional-${width}.png`), animations: 'disabled'})
	})
}
