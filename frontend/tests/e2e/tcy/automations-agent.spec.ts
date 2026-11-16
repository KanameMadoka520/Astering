import {createServer} from 'node:https'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {test, expect} from '../../support/fixtures'
import {profileOptions} from '../../../src/helpers/assistantProfiles'

const caPath = fileURLToPath(new URL('../../fixtures/arona-provider-ca.pem', import.meta.url))
const fixtureEnabled = resolve(process.env.SSL_CERT_FILE || '.') === resolve(caPath)
	&& (process.env.ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS || process.env.VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS) === 'true'

test('a background automation uses real tool execution without asking for approval', async ({authenticatedPage: page, apiContext, userToken}) => {
	test.skip(!fixtureEnabled, 'Requires the isolated Mage API to trust the public local-provider fixture CA.')
	const headers = {Authorization: `Bearer ${userToken}`}
	const projectResponse = await apiContext.post('/api/v2/projects', {headers, data: {title: 'Automation integration'}})
	expect(projectResponse.ok(), await projectResponse.text()).toBe(true)
	const project = await projectResponse.json()
	let release!: () => void
	const held = new Promise<void>(done => { release = done })
	const requests: {messages?: {role?: string, content?: unknown}[]}[] = []
	const errors: string[] = []
	const server = createServer({
		cert: readFileSync(new URL('../../fixtures/arona-provider-cert.pem', import.meta.url)),
		key: readFileSync(new URL('../../fixtures/arona-provider-key.pem', import.meta.url)),
	}, async (request, response) => {
		try {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				errors.push('unexpected-provider-route')
				response.writeHead(404).end()
				return
			}
			const buffers: Buffer[] = []
			for await (const part of request) buffers.push(Buffer.from(part))
			requests.push(JSON.parse(Buffer.concat(buffers).toString('utf8')))
			if (requests.length === 1) await held
			const round = requests.length
			const names = ['find_tools', 'invoke_tool']
			const argumentsByRound = [
				{query: 'create_task', limit: 1},
				{name: 'create_task', arguments: {project_id: project.id, title: 'Created by an unattended automation'}},
			]
			if (round > 3) errors.push('unexpected-extra-model-request')
			const delta = round <= 2 ? {
				role: 'assistant',
				tool_calls: [{index: 0, id: `fixture-call-${round}`, type: 'function', function: {name: names[round - 1], arguments: JSON.stringify(argumentsByRound[round - 1])}}],
			} : {role: 'assistant', content: 'The task has been created successfully.'}
			response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
			response.write(`data: ${JSON.stringify({model: 'automation-fixture', choices: [{index: 0, delta, finish_reason: round <= 2 ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 200, completion_tokens: 30, total_tokens: 230}})}\n\n`)
			response.end('data: [DONE]\n\n')
		} catch {
			errors.push('fixture-handler-failed')
			response.destroy()
		}
	})
	await new Promise<void>((done, fail) => {
		server.once('error', fail)
		server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
	})
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port')
	let automation: {id: string, revision: number} | undefined
	try {
		const settings = await apiContext.post('/api/v2/ai/settings', {headers, data: {
			connections: [{id: 'automation-fixture', name: 'Local automation fixture', kind: 'chat', protocol: 'openai-chat',
				base_url: `https://127.0.0.1:${address.port}/v1`, model: 'automation-fixture', api_key: 'public-test-key',
				input_types: ['text'], context_window: 128000, max_output_tokens: 8192, disable_auto_compact: true}],
			assistant: 'automation-fixture', transcription: '', cleanup: '', persona: 'none',
		}})
		expect(settings.ok(), await settings.text()).toBe(true)
		const response = await apiContext.post('/api/v2/ai/automations', {headers, data: {
			title: 'Real background tool execution',
			prompt: `Create one task in project ${project.id}. Use the discovered tool and finish.`,
			kind: 'agent', enabled: false, timezone: 'Asia/Shanghai', schedule: {kind: 'daily', time: '09:00'},
			options: {...profileOptions('assist'), approval: 'unattended', connection_id: 'automation-fixture', project_id: project.id, write_project_ids: [project.id]},
			max_runtime_seconds: 60, notify_on_success: true, notify_on_failure: true,
		}})
		expect(response.ok(), await response.text()).toBe(true)
		automation = await response.json()
		await page.goto(`/automations/${automation!.id}`)
		const admission = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === `/api/v2/ai/automations/${automation!.id}/run`)
		await page.getByRole('button', {name: 'Run now', exact: true}).click()
		const admitted = await admission
		expect(admitted.ok(), await admitted.text()).toBe(true)
		await expect.poll(async () => {
			const response = await apiContext.get(`/api/v2/ai/automations/${automation!.id}/runs`, {headers})
			const latest = (await response.json()).items[0]
			if (latest?.status !== 'running') throw new Error(`Automation stopped: ${JSON.stringify(latest)}`)
			return requests.length
		}, {timeout: 15_000}).toBe(1)
		await page.goto('/notes')
		release()
		await expect.poll(async () => {
			const response = await apiContext.get(`/api/v2/ai/automations/${automation!.id}/runs`, {headers})
			return (await response.json()).items[0]?.status
		}, {timeout: 30_000}).toBe('succeeded')
		const runs = await (await apiContext.get(`/api/v2/ai/automations/${automation!.id}/runs`, {headers})).json()
		expect(runs.items).toHaveLength(1)
		const conversation = await (await apiContext.get(`/api/v2/ai/conversations/${runs.items[0].conversation_id}`, {headers})).json()
		expect(conversation.turns[0].status).toBe('completed')
		expect(conversation.turns[0].result.configuration.approval).toBe('unattended')
		const operations = conversation.turns[0].result.operations
		expect(operations.find((operation: {tool: string}) => operation.tool === 'create_task').status).toBe('succeeded')
		const tasksResponse = await apiContext.get(`/api/v2/projects/${project.id}/tasks`, {headers})
		expect(tasksResponse.ok(), await tasksResponse.text()).toBe(true)
		expect((await tasksResponse.json()).items.filter((task: {title: string}) => task.title === 'Created by an unattended automation')).toHaveLength(1)
		expect(requests).toHaveLength(3)
		expect(errors).toEqual([])
		await page.goto(`/automations/${automation!.id}`)
		await page.getByRole('link', {name: 'Open full conversation', exact: false}).click()
		await expect(page).toHaveURL(new RegExp(`chat=${runs.items[0].conversation_id}`))
		await expect(page.locator('.conversation')).toContainText('The task has been created successfully.')
	} catch (error) {
		if (automation) {
			const diagnostic = await apiContext.get(`/api/v2/ai/automations/${automation.id}/runs`, {headers})
			await test.info().attach('automation-receipts', {body: await diagnostic.text(), contentType: 'application/json'})
		}
		throw error
	} finally {
		release()
		server.closeAllConnections()
		await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
		if (automation) {
			const current = await apiContext.get(`/api/v2/ai/automations/${automation.id}`, {headers})
			if (current.ok()) await apiContext.delete(`/api/v2/ai/automations/${automation.id}`, {headers, data: {expected_revision: (await current.json()).revision}})
		}
	}
})
