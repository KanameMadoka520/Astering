import {createServer} from 'node:https'
import type {ServerResponse} from 'node:http'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import type {APIRequestContext, Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'

// Only the provider is a fixture: settings, conversations, steering, persistence and SSE use the real API.
// The certificates and private key below are PUBLIC TEST DATA, valid only for the loopback fixture.
// Run through Mage with SSL_CERT_FILE=.../arona-provider-ca.pem and
// ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true on its isolated API process. Never disable TLS checks.
const caPath = fileURLToPath(new URL('../../fixtures/arona-provider-ca.pem', import.meta.url))
const fixtureEnabled = resolve(process.env.SSL_CERT_FILE || '.') === resolve(caPath)
	&& (process.env.ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS || process.env.VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS) === 'true'
const api = `${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2`
const MODEL_ID = 'local-steering-fixture'
const ORIGINAL = 'Prepare a read-only outline and wait for my clarification.'
const ADDITION = 'Keep the outline short and include a specific verification step.'
const FINAL = 'The revised outline includes the requested verification step.'

type Steering = {
	id: string
	request_id: string
	message: string
	created: string
	applied_at?: string
	status: 'pending' | 'applied'
}
type SavedTurn = {
	id: string
	prompt: string
	started: string
	finished?: string
	status: string
	steering?: Steering[]
	result?: {reply?: string}
}
type SavedConversation = {id: string, turns: SavedTurn[]}
type ProviderRequest = {stream?: boolean, messages?: {role?: string, content?: unknown}[]}

function latch() {
	let release!: () => void
	const promise = new Promise<void>(done => { release = done })
	return {promise, release}
}

async function localProvider() {
	const first = latch()
	const second = latch()
	const requests: ProviderRequest[] = []
	const failures: string[] = []
	let cancelled = 0
	const chunk = (response: ServerResponse, delta: object, finished = false) => {
		if (response.destroyed) return
		const payload = {
			model: MODEL_ID,
			choices: [{index: 0, delta, finish_reason: finished ? 'stop' : null}],
			...(finished ? {usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}} : {}),
		}
		response.write(`data: ${JSON.stringify(payload)}\n\n`)
	}
	const server = createServer({
		cert: readFileSync(new URL('../../fixtures/arona-provider-cert.pem', import.meta.url)),
		key: readFileSync(new URL('../../fixtures/arona-provider-key.pem', import.meta.url)),
	}, async (request, response) => {
		try {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				failures.push('unexpected-local-provider-route')
				response.writeHead(404).end()
				return
			}
			const buffers: Buffer[] = []
			for await (const part of request) buffers.push(Buffer.from(part))
			const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as ProviderRequest
			requests.push(body)
			if (body.stream !== true) failures.push('streaming-not-requested')
			response.on('close', () => { if (!response.writableEnded) cancelled++ })
			response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
			response.flushHeaders()
			const round = requests.length
			if (round > 2) failures.push('unexpected-extra-model-request')
			chunk(response, {role: 'assistant', content: round === 1 ? 'An initial outline is being prepared.' : FINAL})
			await (round === 1 ? first.promise : second.promise)
			if (response.destroyed) return
			chunk(response, {}, true)
			response.end('data: [DONE]\n\n')
		} catch {
			failures.push('local-provider-handler-failed')
			if (!response.destroyed) response.destroy()
		}
	})
	await new Promise<void>((done, fail) => {
		server.once('error', fail)
		server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
	})
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Local fixture did not bind a TCP port')
	return {
		url: `https://127.0.0.1:${address.port}/v1`, requests, failures, first, second,
		cancelled: () => cancelled,
		async close() {
			first.release()
			second.release()
			server.closeAllConnections()
			await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
		},
	}
}

function realAPI(context: APIRequestContext, token: string) {
	const headers = {Authorization: `Bearer ${token}`}
	return {
		async setup(url: string) {
			const saved = await context.post(`${api}/ai/settings`, {headers, data: {
				connections: [{id: MODEL_ID, name: 'Local streaming fixture', kind: 'chat', protocol: 'openai-chat',
					base_url: url, model: MODEL_ID, api_key: 'public-e2e-fixture-key',
					input_types: ['text'], context_window: 128000, max_output_tokens: 8192, disable_auto_compact: true}],
				assistant: MODEL_ID, transcription: '', cleanup: '', persona: 'none',
			}})
			expect(saved.ok()).toBe(true)
			const created = await context.post(`${api}/ai/conversations`, {headers, data: {title: 'Steering integration fixture'}})
			expect(created.status()).toBe(201)
			return (await created.json() as SavedConversation).id
		},
		async read(id: string): Promise<SavedConversation> {
			const response = await context.get(`${api}/ai/conversations/${id}`, {headers})
			expect(response.ok()).toBe(true)
			return response.json()
		},
		async stop(id: string) {
			return context.post(`${api}/ai/conversations/${id}/stop`, {headers})
		},
	}
}

async function begin(page: Page, id: string, provider: Awaited<ReturnType<typeof localProvider>>) {
	await page.goto(`/ai?chat=${id}`)
	const composer = page.getByLabel('Your request', {exact: true})
	await composer.fill(ORIGINAL)
	await page.getByRole('button', {name: 'Send request', exact: true}).click()
	await expect.poll(() => provider.requests.length).toBe(1)
	await expect(page.getByRole('button', {name: 'Stop execution', exact: true})).toBeVisible()
	return composer
}

function additionButton(page: Page) {
	return page.getByRole('button', {name: 'Add instruction', exact: true})
}

async function expectGMT8(time: Locator, iso: string) {
	await expect(time).toBeVisible()
	const renderedInstant = await time.getAttribute('datetime')
	// Keep the exact server instant (including fractional seconds); the visible clock uses GMT+8.
	expect(Date.parse(renderedInstant || '')).toBe(Date.parse(iso))
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Shanghai', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
	}).formatToParts(new Date(iso)).map(part => [part.type, part.value]))
	await expect(time).toContainText(`${parts.hour}:${parts.minute} GMT+8`)
	const full = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} GMT+8`
	const accessibleDetail = [await time.getAttribute('title'), await time.getAttribute('aria-label')].join(' ')
	expect(accessibleDetail).toContain(full)
}

test.describe('Arona real in-flight steering', () => {
	test.skip(!fixtureEnabled, 'Requires the public loopback TLS fixture CA and the isolated API outgoingrequests opt-in; never calls an external model.')
	test.use({timezoneId: 'America/Los_Angeles'})

	for (const width of [1440, 390]) {
		test(`composer additions persist across reload and reach the actual model context at ${width}px`, async ({
			authenticatedPage: page, apiContext, userToken,
		}) => {
			test.setTimeout(60000)
			const provider = await localProvider()
			const apiClient = realAPI(apiContext, userToken)
			let id = ''
			try {
				id = await apiClient.setup(provider.url)
				await page.setViewportSize({width, height: width < 768 ? 844 : 1000})
				const composer = await begin(page, id, provider)
				await composer.fill(ADDITION)
				// IME confirmation does not submit while work is in flight.
				await composer.dispatchEvent('keydown', {key: 'Enter', isComposing: true})
				expect((await apiClient.read(id)).turns[0].steering || []).toHaveLength(0)
				await page.screenshot({path: test.info().outputPath('steering-composer.png'), fullPage: false})
				const accepted = page.waitForResponse(response => response.url().endsWith(`/ai/conversations/${id}/steer`)
					&& response.request().method() === 'POST')
				await additionButton(page).click()
				const acceptedResponse = await accepted
				expect(acceptedResponse.ok()).toBe(true)
				expect(acceptedResponse.headers()['cache-control']).toBe('no-store')
				const pending = (await apiClient.read(id)).turns[0]
				expect(pending.status).toBe('running')
				expect(pending.prompt).toBe(ORIGINAL)
				expect(pending.steering).toEqual([expect.objectContaining({message: ADDITION, status: 'pending'})])
				expect(pending.steering![0].applied_at).toBeUndefined()
				await expect(composer).toHaveValue('')
				const receipt = page.locator(`[data-steering-id="${pending.steering![0].id}"]`)
				await expect(receipt).toContainText(ADDITION)
				await expect(receipt).toHaveAttribute('data-steering-status', 'pending')
				await page.reload()
				await expect(receipt).toContainText(ADDITION)
				await expect(receipt).toHaveAttribute('data-steering-status', 'pending')
				expect((await apiClient.read(id)).turns[0].steering).toEqual(pending.steering)
				expect(provider.requests).toHaveLength(1)
				await page.screenshot({path: test.info().outputPath('steering-pending.png'), fullPage: false})

				provider.first.release()
				await expect.poll(() => provider.requests.length).toBe(2)
				await expect.poll(async () => (await apiClient.read(id)).turns[0].steering?.[0].status).toBe('applied')
				await expect(receipt).toHaveAttribute('data-steering-status', 'applied')
				const userContext = provider.requests[1].messages?.filter(message => message.role === 'user')
					.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n') || ''
				expect(userContext).toContain(ADDITION)
				expect(userContext.split(ADDITION)).toHaveLength(2)
				provider.second.release()
				await expect.poll(async () => (await apiClient.read(id)).turns[0].status).toBe('completed')
				const completed = (await apiClient.read(id)).turns[0]
				expect(completed.steering?.[0].applied_at).toBeTruthy()
				expect(completed.steering?.[0].id).toBe(pending.steering![0].id)
				expect(completed.finished).toBeTruthy()
				await expect(page.locator('.chat-markdown').filter({hasText: FINAL})).toBeVisible()
				await page.reload()
				await expect(receipt).toContainText(ADDITION)
				await expect(receipt).toHaveAttribute('data-steering-status', 'applied')
				const card = page.locator(`.chat-turn[data-turn-id="${completed.id}"]`)
				await expectGMT8(card.locator('.user-meta time'), completed.started)
				await expectGMT8(card.locator('.assistant-identity time'), completed.finished!)
				await expect(card.getByText(/GMT\+8/).first()).toBeVisible()
				expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/Los_Angeles')
				expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
				expect(provider.requests).toHaveLength(2)
				expect(provider.failures).toEqual([])
				await page.screenshot({path: test.info().outputPath('steering-completed.png'), fullPage: false})
			} finally {
				try {
					if (id) await apiClient.stop(id)
				} finally {
					await provider.close()
				}
			}
		})
	}

	test('two failed additions survive reload and retry once each without losing the newer draft', async ({
		authenticatedPage: page, apiContext, userToken,
	}) => {
		test.setTimeout(60000)
		const provider = await localProvider()
		const apiClient = realAPI(apiContext, userToken)
		const abortFirst = latch()
		const abortSecond = latch()
		const firstAddition = 'Verify the outline against the existing project dates.'
		const secondAddition = 'Also include a short checklist for the next review.'
		const newerDraft = 'Keep this third instruction as an unsent draft.'
		const attempts: {turn_id: string, request_id: string, message: string}[] = []
		let id = ''
		const matchesSteer = (url: URL) => url.pathname === `/api/v2/ai/conversations/${id}/steer`
		try {
			id = await apiClient.setup(provider.url)
			await page.setViewportSize({width: 390, height: 844})
			await page.route(matchesSteer, async route => {
				if (route.request().method() !== 'POST') return route.continue()
				// Only this isolated conversation's first two additions fail before reaching the real API.
				attempts.push(route.request().postDataJSON())
				const attempt = attempts.length
				if (attempt > 2) return route.continue()
				await (attempt === 1 ? abortFirst.promise : abortSecond.promise)
				await route.abort('failed')
			})
			const composer = await begin(page, id, provider)
			const firstFailure = page.locator('.steer-failure').filter({hasText: firstAddition})
			const secondFailure = page.locator('.steer-failure').filter({hasText: secondAddition})

			await composer.fill(firstAddition)
			await additionButton(page).click()
			await expect.poll(() => attempts.length).toBe(1)
			await composer.fill(secondAddition)
			abortFirst.release()
			await expect(firstFailure).toBeVisible()
			await expect(composer).toHaveValue(secondAddition)

			await additionButton(page).click()
			await expect.poll(() => attempts.length).toBe(2)
			await composer.fill(newerDraft)
			abortSecond.release()
			await expect(firstFailure).toBeVisible()
			await expect(secondFailure).toBeVisible()
			await expect(composer).toHaveValue(newerDraft)
			expect((await apiClient.read(id)).turns[0].steering || []).toHaveLength(0)

			await page.reload()
			await expect(composer).toHaveValue(newerDraft)
			await expect(firstFailure).toBeVisible()
			await expect(secondFailure).toBeVisible()
			expect(provider.requests).toHaveLength(1)
			const originalTurn = (await apiClient.read(id)).turns[0]
			expect(originalTurn.prompt).toBe(ORIGINAL)
			expect(originalTurn.status).toBe('running')

			await firstFailure.getByRole('button', {name: 'Retry', exact: true}).click()
			await expect.poll(async () => (await apiClient.read(id)).turns[0].steering?.length).toBe(1)
			await expect(firstFailure).toHaveCount(0)
			await expect(secondFailure).toBeVisible()
			await expect(composer).toHaveValue(newerDraft)
			await secondFailure.getByRole('button', {name: 'Retry', exact: true}).click()
			await expect.poll(async () => (await apiClient.read(id)).turns[0].steering?.length).toBe(2)
			await expect(secondFailure).toHaveCount(0)
			await expect(composer).toHaveValue(newerDraft)
			expect(attempts).toHaveLength(4)
			expect(attempts[2]).toEqual(attempts[0])
			expect(attempts[3]).toEqual(attempts[1])
			expect(attempts[0].request_id).not.toBe(attempts[1].request_id)
			expect(attempts.map(attempt => attempt.message)).toEqual([
				firstAddition, secondAddition, firstAddition, secondAddition,
			])
			const pending = (await apiClient.read(id)).turns[0]
			expect(pending.steering).toEqual([
				expect.objectContaining({request_id: attempts[0].request_id, message: firstAddition, status: 'pending'}),
				expect.objectContaining({request_id: attempts[1].request_id, message: secondAddition, status: 'pending'}),
			])
			expect(provider.requests).toHaveLength(1)

			provider.first.release()
			await expect.poll(() => provider.requests.length).toBe(2)
			const userContext = provider.requests[1].messages?.filter(message => message.role === 'user')
				.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n') || ''
			for (const message of [ORIGINAL, firstAddition, secondAddition]) {
				expect(userContext).toContain(message)
				expect(userContext.split(message)).toHaveLength(2)
			}
			provider.second.release()
			await expect.poll(async () => (await apiClient.read(id)).turns[0].status).toBe('completed')
			const completed = (await apiClient.read(id)).turns[0]
			expect(completed.steering).toHaveLength(2)
			expect(completed.steering?.every(entry => entry.status === 'applied' && entry.applied_at)).toBe(true)
			await expect(composer).toHaveValue(newerDraft)
			expect(provider.requests).toHaveLength(2)
			expect(provider.failures).toEqual([])
		} finally {
			abortFirst.release()
			abortSecond.release()
			try {
				await page.unroute(matchesSteer)
			} finally {
				try {
					if (id) await apiClient.stop(id)
				} finally {
					await provider.close()
				}
			}
		}
	})

	test('Stop remains available with an addition and a later unsent draft on mobile', async ({
		authenticatedPage: page, apiContext, userToken,
	}) => {
		test.setTimeout(60000)
		const provider = await localProvider()
		const apiClient = realAPI(apiContext, userToken)
		let id = ''
		try {
			id = await apiClient.setup(provider.url)
			await page.setViewportSize({width: 390, height: 844})
			const composer = await begin(page, id, provider)
			await composer.fill(ADDITION)
			const accepted = page.waitForResponse(response => response.url().endsWith(`/ai/conversations/${id}/steer`)
				&& response.request().method() === 'POST')
			await additionButton(page).click()
			expect((await accepted).ok()).toBe(true)
			await composer.fill('Keep this unsent follow-up after stopping.')
			const stop = page.getByRole('button', {name: 'Stop execution', exact: true})
			await expect(stop).toBeEnabled()
			await stop.click()
			await expect.poll(async () => (await apiClient.read(id)).turns[0].status).toBe('stopped')
			await expect.poll(provider.cancelled).toBe(1)
			await expect(composer).toHaveValue('Keep this unsent follow-up after stopping.')
			const stopped = (await apiClient.read(id)).turns[0]
			expect(stopped.steering).toHaveLength(1)
			expect(stopped.steering![0].id).toBeTruthy()
			expect(provider.requests).toHaveLength(1)
			expect(provider.failures).toEqual([])
		} finally {
			try {
				if (id) await apiClient.stop(id)
			} finally {
				await provider.close()
			}
		}
	})
})
