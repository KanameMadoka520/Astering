import type {APIRequestContext, Page} from '@playwright/test'
import {test, expect} from '../../../support/fixtures'
import {apiRootUrl} from '../../../support/apiUrl'
import {Factory} from '../../../support/factory'
import {UserFactory} from '../../../factories/user'
import type {McpSettings, McpConnectionWritable} from '../../../../src/client/generated'

const api = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`
const settingsURL = `${api}/user/settings/tcy-ai/mcp`
const CHAT = '1dc4bad3-8c49-4a79-9272-ed99457443bb'

async function store(apiContext: APIRequestContext, token: string, connections: McpConnectionWritable[]) {
	const headers = {Authorization: `Bearer ${token}`}
	const oldResponse = await apiContext.get(settingsURL, {headers})
	expect(oldResponse.ok()).toBeTruthy()
	const old: McpSettings = await oldResponse.json()
	const result = await apiContext.put(settingsURL, {headers, data: {revision: old.revision, connections}})
	expect(result.ok(), await result.text()).toBeTruthy()
	return await result.json() as McpSettings
}
async function read(apiContext: APIRequestContext, token: string) {
	const response = await apiContext.get(settingsURL, {headers: {Authorization: `Bearer ${token}`}})
	expect(response.ok()).toBeTruthy()
	return await response.json() as McpSettings
}
const connection = (id: string): McpConnectionWritable => ({
	id,
	name: `Fixture ${id}`,
	url: `https://${id}.example/mcp`,
	transport: 'streamable_http',
	preset: 'custom',
	enabled: true,
	api_key: 'fixture-independent-mcp-key',
})

async function assistant(page: Page) {
	const requests: Record<string, unknown>[] = []
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'model',
			name: 'Fixture model',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://model.invalid/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'model',
	}}))
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {system_prompt: 'Fixture', tool_schema: '[]'}}))
	let conversation: Record<string, unknown> = {id: CHAT, title: 'MCP fixture', turns: [], compactions: []}
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const path = new URL(request.url()).pathname
		if (request.method() === 'POST' && path.endsWith('/messages')) {
			const body = request.postDataJSON()
			requests.push(body)
			conversation = {
				...conversation,
				turns: [{
					id: body.request_id,
					request_id: body.request_id,
					prompt: body.message,
					status: 'completed',
					started: '2026-11-02T10:00:00Z',
					finished: '2026-11-02T10:00:01Z',
					result: {reply: 'Fixture reply', configuration: body, actions: []},
				}],
			}
			return route.fulfill({json: conversation})
		}
		if (request.method() !== 'GET') return route.fulfill({status: 400, json: {message: 'Unexpected fixture write'}})
		if (path.endsWith('/ai/conversations')) return route.fulfill({json: {
			items: [{id: CHAT, title: 'MCP fixture', turn_count: (conversation.turns as unknown[]).length}],
			total: 1,
			total_pages: 1,
		}})
		if (path.endsWith('/events')) return route.fulfill({contentType: 'text/event-stream', body: 'event: activity\ndata: {}\n\n'})
		return route.fulfill({json: conversation})
	})
	return requests
}

for (const language of ['en', 'zh-CN']) {
	for (const width of [1440, 320]) {
		test.describe(`external MCP ${language} ${width}px`, () => {
			test.use({currentUser: async ({apiContext}, use) => {
				Factory.setRequestContext(apiContext)
				const [user] = await UserFactory.create(1, {language})
				await use(user)
			}})

			test('saves cards independently, tests only on request and keeps keys private after reload', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
				const chinese = language === 'zh-CN'
				await store(apiContext, userToken, [connection('existing')])
				let tests = 0
				await page.route('**/api/v2/user/settings/tcy-ai/mcp/test', route => {
					tests++
					return route.fulfill({json: {
						endpoint: 'https://wallos.tcymc.space/api/agent/mcp.php',
						server_name: 'Fixture MCP',
						server_version: '1.0',
						tools: [{name: 'list_fixture', description: 'Fixture tool description', read_only: false, destructive: true}],
						matched: 1,
						more_available: false,
					}})
				})
				await page.setViewportSize({width, height: 900})
				await page.goto('/user/settings/ai?tab=mcp')
				const cards = page.locator('form.mcp-connection-card')
				const original = cards.first()
				await original.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true}).fill('Unfinished original')
				await page.getByRole('button', {name: chinese ? '添加 Wallos 模板' : 'Add Wallos template', exact: true}).click()
				const wallos = cards.nth(1)
				await expect(wallos.getByLabel(chinese ? 'MCP 端点地址' : 'MCP endpoint', {exact: true})).toHaveValue('https://wallos.tcymc.space/api/agent/mcp.php')
				await expect(wallos.getByRole('link')).toHaveAttribute('href', 'https://wallos.tcymc.space/agent.php')
				const testConnection = wallos.getByRole('button', {name: chinese ? '测试连接并查看工具' : 'Test connection and list tools', exact: true})
				await testConnection.click()
				await expect(wallos.getByRole('alert')).toBeVisible()
				expect(tests).toBe(0)
				const save = wallos.getByRole('button', {name: chinese ? '保存此连接' : 'Save connection', exact: true})
				await save.click()
				await expect(wallos.getByRole('status').filter({hasText: chinese ? '连接已保存' : 'Connection saved.'})).toBeVisible()
				const withoutKey = await read(apiContext, userToken)
				expect(withoutKey.connections?.find(item => item.id === 'existing')?.name).toBe('Fixture existing')
				expect(withoutKey.connections?.find(item => item.preset === 'wallos')?.has_key).toBe(false)
				await expect(original.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true})).toHaveValue('Unfinished original')
				await wallos.getByLabel(chinese ? 'MCP 服务密钥' : 'MCP service key', {exact: true}).fill('fixture-wallos-key-never-real')
				await wallos.getByLabel(chinese ? '启用此连接' : 'Enable this connection', {exact: true}).check()
				await testConnection.click()
				await wallos.locator('summary').click()
				await expect(wallos.locator('.mcp-tool-list li')).toHaveCount(1)
				await expect(wallos.getByRole('checkbox', {name: /list_fixture/})).toHaveCount(0)
				await expect(wallos.locator('textarea')).toHaveCount(0)
				await save.click()
				await expect(wallos.getByRole('status').filter({hasText: chinese ? '连接已保存' : 'Connection saved.'})).toBeVisible()
				const stored = await read(apiContext, userToken)
				const saved = stored.connections?.find(item => item.preset === 'wallos')
				expect(saved).toMatchObject({enabled: true, has_key: true, read_tools: []})
				for (const item of stored.connections ?? []) expect(item).not.toHaveProperty('api_key')
				await original.getByLabel(chinese ? '连接名称' : 'Connection name', {exact: true}).fill('Fixture existing')
				await original.getByRole('button', {name: chinese ? '测试连接并查看工具' : 'Test connection and list tools', exact: true}).click()
				await original.locator('summary').click()
				const trust = original.getByRole('checkbox', {name: chinese ? '信任 list_fixture 为只读工具' : 'Trust list_fixture as read-only', exact: true})
				await expect(trust).not.toBeChecked()
				await trust.check()
				await expect(original.locator('.mcp-tool-list li')).toHaveCount(1)
				await original.getByRole('button', {name: chinese ? '保存此连接' : 'Save connection', exact: true}).click()
				await expect(original.getByRole('status').filter({hasText: chinese ? '连接已保存' : 'Connection saved.'})).toBeVisible()
				const trusted = await read(apiContext, userToken)
				expect(trusted.connections?.find(item => item.id === 'existing')?.read_tools).toEqual(['list_fixture'])
				await page.reload()
				await expect(cards).toHaveCount(2)
				await expect(cards.nth(1).getByLabel(chinese ? 'MCP 服务密钥' : 'MCP service key', {exact: true})).toHaveValue('')
				expect(tests).toBe(2)
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
				await page.screenshot({path: testInfo.outputPath(`mcp-settings-${language}-${width}.png`), animations: 'disabled'})
			})

			test('selects external servers per conversation, preserves scenarios and removes disabled choices', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
				const chinese = language === 'zh-CN'
				await store(apiContext, userToken, [connection('selected'), {...connection('disabled'), enabled: false}])
				const requests = await assistant(page)
				await page.setViewportSize({width, height: 900})
				await page.goto(`/ai?chat=${CHAT}`)
				const picker = page.getByRole('button', {name: chinese ? 'MCP 连接：已选 0 个' : 'MCP connections: 0 selected', exact: true})
				await picker.click()
				const selected = page.getByRole('checkbox', {name: 'Fixture selected', exact: true})
				await expect(selected).not.toBeChecked()
				await expect(page.getByRole('checkbox', {name: 'Fixture disabled', exact: true})).toHaveAttribute('aria-disabled', 'true')
				await selected.check()
				await selected.press('Escape')
				await page.locator('.profile-switch select').selectOption('plan')
				await expect(page.getByRole('button', {name: chinese ? 'MCP 连接：已选 1 个' : 'MCP connections: 1 selected', exact: true})).toBeVisible()
				await page.reload()
				const restored = page.getByRole('button', {name: chinese ? 'MCP 连接：已选 1 个' : 'MCP connections: 1 selected', exact: true})
				await expect(restored).toBeVisible()
				await page.locator('[data-tour="ai-prompt"]').fill('Only use the selected fixture service')
				await page.locator('[data-tour="ai-prompt"]').press('Enter')
				await expect.poll(() => requests.length).toBe(1)
				expect(requests[0].mcp_server_ids).toEqual(['selected'])
				await expect(page.getByText('Fixture reply', {exact: true})).toBeVisible()
				await store(apiContext, userToken, [{...connection('selected'), enabled: false}, {...connection('disabled'), enabled: false}])
				await page.reload()
				await expect(page.getByRole('button', {name: chinese ? 'MCP 连接：已选 0 个' : 'MCP connections: 0 selected', exact: true})).toBeVisible()
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
				await page.screenshot({path: testInfo.outputPath(`mcp-conversation-${language}-${width}.png`), animations: 'disabled'})
			})
		})
	}
}
