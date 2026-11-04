import {createServer} from 'node:https'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {test, expect} from '../../support/fixtures'

// Only the model is a public loopback fixture. Settings, durable jobs, SSE and read acknowledgements use the real API.
const caPath = fileURLToPath(new URL('../../fixtures/arona-provider-ca.pem', import.meta.url))
const fixtureEnabled = resolve(process.env.SSL_CERT_FILE || '.') === resolve(caPath)
	&& process.env.ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS === 'true'

for (const width of [1440, 390]) {
	test(`Arona keeps a background reply unread until it is viewed at ${width}px`, async ({authenticatedPage: page, apiContext}) => {
		test.skip(!fixtureEnabled, 'Requires the loopback fixture CA and isolated outgoing request opt-in; never calls an external model.')
		test.setTimeout(90_000)
		let finish!: () => void
		const held = new Promise<void>(done => { finish = done })
		let requests = 0
		const server = createServer({
			cert: readFileSync(new URL('../../fixtures/arona-provider-cert.pem', import.meta.url)),
			key: readFileSync(new URL('../../fixtures/arona-provider-key.pem', import.meta.url)),
		}, async (request, response) => {
			for await (const _part of request) { /* Consume only synthetic provider input. */ }
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404).end()
				return
			}
			requests++
			response.writeHead(200, {'Content-Type': 'text/event-stream'})
			response.flushHeaders()
			await held
			if (response.destroyed) return
			response.write(`data: ${JSON.stringify({model: 'unread-fixture', choices: [{index: 0, delta: {role: 'assistant', content: 'A new background reply has been saved.'}, finish_reason: null}]})}\n\n`)
			response.write(`data: ${JSON.stringify({model: 'unread-fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}\n\n`)
			response.end('data: [DONE]\n\n')
		})
		await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind')
		await page.setViewportSize({width, height: 900})
		await page.goto('/ai')
		const token = await page.evaluate(() => localStorage.getItem('token'))
		const headers = {Authorization: `Bearer ${token}`}
		let id = ''
		try {
			const saved = await apiContext.post('/api/v2/ai/settings', {headers, data: {
				connections: [{
					id: 'unread-fixture', name: 'Unread test model', kind: 'chat', protocol: 'openai-chat',
					base_url: `https://127.0.0.1:${address.port}/v1`, model: 'unread-fixture',
					api_key: 'public-test-fixture', input_types: ['text'], disable_auto_compact: true,
				}],
				assistant: 'unread-fixture', transcription: '', cleanup: '', persona: 'none',
			}})
			expect(saved.ok()).toBe(true)
			const created = await apiContext.post('/api/v2/ai/conversations', {headers, data: {title: 'Background unread fixture'}})
			id = (await created.json()).id
			const other = await apiContext.post('/api/v2/ai/conversations', {headers, data: {title: 'Another conversation'}})
			const otherID = (await other.json()).id
			await page.goto(`/ai?chat=${id}`)
			await page.getByLabel('Your request', {exact: true}).fill('Reply after I leave this conversation.')
			await page.getByRole('button', {name: 'Send request', exact: true}).click()
			await expect.poll(() => requests).toBe(1)
			await page.goto(`/ai?chat=${otherID}`)
			finish()
			const read = async () => (await apiContext.get(`/api/v2/ai/conversations/${id}`, {headers})).json()
			await expect.poll(async () => (await read()).unread).toBe(true)
			if (width < 768) await page.locator('.heading-start').getByRole('button', {name: 'Conversations', exact: true}).click()
			const history = page.locator(`.history-panel [data-chat-id="${id}"]`)
			await expect(history.locator('.history-badge.is-unread')).toHaveText('Unread')
			// Repeated background reads and an open list do not acknowledge the reply.
			expect((await read()).unread).toBe(true)
			await history.locator('.history-link').click()
			await expect(page.locator('.assistant-message')).toContainText('A new background reply has been saved.')
			await expect.poll(async () => (await read()).unread).toBe(false)
			await page.reload()
			expect((await read()).unread).toBe(false)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		} finally {
			finish()
			if (id) await apiContext.post(`/api/v2/ai/conversations/${id}/stop`, {headers})
			server.closeAllConnections()
			await new Promise<void>(done => server.close(() => done()))
		}
	})
}
