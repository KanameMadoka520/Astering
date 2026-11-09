import {createServer} from 'node:https'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {
	test,
	expect,
} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'
const caPath = fileURLToPath(new URL('../../fixtures/arona-provider-ca.pem', import.meta.url))
const fixtureEnabled = resolve(process.env.SSL_CERT_FILE || '.') === resolve(caPath)
	&& process.env.ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS === 'true'
for (const width of [1440, 390]) {
	test(`note organization continues away from page and applies only after preview at ${width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		test.skip(!fixtureEnabled, 'Requires isolated loopback provider CA; never calls a real model or paid key.')
		test.setTimeout(90_000)
		await page.setViewportSize({
			width,
			height: 900,
		})
		await updateUserSettings(apiContext, userToken, {language: 'en'})
		let release!: () => void
		const held = new Promise<void>(done => { release = done })
		let requests = 0
		let toolsSupplied = false
		let streaming = true
		let largestSource = 0
		const result = '# Organized article\n\nKeep the precise idea. Review the experiment next Tuesday.'
			+ '\n\n## Next steps\n\n- Compare the two approaches.'
		const server = createServer({
			cert: readFileSync(new URL('../../fixtures/arona-provider-cert.pem', import.meta.url)),
			key: readFileSync(new URL('../../fixtures/arona-provider-key.pem', import.meta.url)),
		}, async (request, response) => {
			let input = ''
			for await (const part of request) input += part.toString()
			const body = JSON.parse(input)
			requests++
			toolsSupplied ||= Array.isArray(body.tools) && body.tools.length > 0
			streaming &&= body.stream === true
			largestSource = Math.max(largestSource, new TextEncoder().encode(body.messages?.at(-1)?.content ?? '').byteLength)
			response.writeHead(200, {'Content-Type': 'text/event-stream'})
			response.flushHeaders()
			if (requests === 1) await held
			if (response.destroyed) return
			response.write(`data: ${JSON.stringify({
				model: 'organization-fixture',
				choices: [{
					index: 0,
					delta: {
						role: 'assistant',
						content: result,
					},
					finish_reason: null,
				}],
			})}\n\n`)
			response.write(`data: ${JSON.stringify({
				model: 'organization-fixture',
				choices: [{
					index: 0,
					delta: {},
					finish_reason: 'stop',
				}],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 25,
				},
			})}\n\n`)
			response.end('data: [DONE]\n\n')
		})
		await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Loopback provider did not bind')
		const headers = {Authorization: `Bearer ${userToken}`}
		let noteID = 0
		try {
			const saved = await apiContext.post('/api/v2/ai/settings', {
				headers,
				data: {
					connections: [{
						id: 'organization-fixture',
						name: 'Organization fixture',
						kind: 'chat',
						protocol: 'openai-chat',
						base_url: `https://127.0.0.1:${address.port}/v1`,
						model: 'organization-fixture',
						api_key: 'public-test-fixture',
						context_window: 12000,
						max_output_tokens: 2048,
						input_types: ['text'],
					}],
					assistant: 'organization-fixture',
					transcription: '',
					cleanup: 'organization-fixture',
					persona: 'none',
				},
			})
			expect(saved.ok(), await saved.text()).toBe(true)
			const original = 'The precise idea and original source must stay unchanged.\n'.repeat(350)
			const creation = await apiContext.post('/api/v2/notes', {
				headers,
				data: {
					title: 'Long recording organization',
					content: original,
				},
			})
			expect(creation.ok()).toBe(true)
			const note = await creation.json()
			noteID = note.id
			await page.goto(`/notes/${noteID}`)
			const panel = page.locator('.note-organization')
			await panel.getByRole('button', {name: /Ask Arona to organize/}).click()
			await panel.getByLabel('Organization model').selectOption('organization-fixture')
			await panel.getByRole('button', {
				name: 'Organize into an article',
				exact: true,
			}).click()
			await expect.poll(() => requests).toBe(1)
			await expect(panel).toContainText('You can leave this page.')
			await page.goto('/notes')
			release()
			const readJob = async () => (await apiContext.get(`/api/v2/notes/${noteID}/organization`, {headers})).json()
			await expect.poll(async () => (await readJob()).job?.status, {timeout: 30_000}).toBe('completed')
			expect(requests).toBeGreaterThan(2)
			expect(toolsSupplied).toBe(false)
			expect(streaming).toBe(true)
			expect(largestSource).toBeLessThanOrEqual(5880)
			const unchanged = await (await apiContext.get(`/api/v2/notes/${noteID}`, {headers})).json()
			expect(unchanged.content).toBe(original)
			await page.goto(`/notes/${noteID}`)
			await panel.getByRole('button', {name: /Ask Arona to organize/}).click()
			await expect(panel.locator('.note-organization__preview')).toContainText('Keep the precise idea.')
			await panel.getByRole('button', {
				name: 'Append to article',
				exact: true,
			}).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog).toContainText('Existing article text and original transcripts will be retained.')
			await dialog.getByRole('button', {
				name: 'Apply this preview',
				exact: true,
			}).click()
			await expect(panel).toContainText('Applied to the article.')
			const adopted = await (await apiContext.get(`/api/v2/notes/${noteID}`, {headers})).json()
			expect(adopted.content).toBe(`${original}\n\n${result}`)
			expect(adopted.revision).toBe(note.revision + 1)
			const storage = await (await apiContext.get('/api/v2/user/storage', {headers})).json()
			// The server reports previews as logical database text, independently from files.
			expect(storage.note_organization_bytes).toBeGreaterThan(0)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({
				path: info.outputPath(`note-organization-preview-${width}.png`),
				fullPage: true,
				animations: 'disabled',
			})
			await panel.getByRole('button', {
				name: 'Discard preview and checkpoints',
				exact: true,
			}).click()
			await page.getByRole('dialog').getByRole('button', {
				name: 'Discard preview and checkpoints',
				exact: true,
			}).click()
			await expect(panel.locator('.note-organization__preview')).toHaveCount(0)
			const retained = await (await apiContext.get(`/api/v2/notes/${noteID}`, {headers})).json()
			expect(retained.content).toBe(adopted.content)
		} finally {
			release()
			if (noteID) await apiContext.delete(`/api/v2/notes/${noteID}`, {headers})
			server.closeAllConnections()
			await new Promise<void>(done => server.close(() => done()))
		}
	})
}
