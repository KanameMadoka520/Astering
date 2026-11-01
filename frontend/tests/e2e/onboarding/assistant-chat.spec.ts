import {test, expect} from '../../support/fixtures'
import type {Page} from '@playwright/test'
import {createProjects} from '../project/prepareProjects'
import {TaskFactory} from '../../factories/task'
import {BucketFactory} from '../../factories/bucket'
import {TaskBucketFactory} from '../../factories/task_buckets'
import {apiRootUrl} from '../../support/apiUrl'

async function chatServer(page: Page, withReview = false, live = false) {
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {revision: 0, default_profile: 'ask', profiles: []}}))
	const reviews: any[] = []
	const conversations = new Map<string, any>()
	let sends = 0
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{id: 'model', name: 'Fixture', kind: 'chat', protocol: 'anthropic', base_url: 'https://fixture.example/v1', model: 'requested', has_key: true}],
		assistant: 'model', transcription: '', cleanup: '',
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {system_prompt: 'Actual built-in fixture prompt', tool_schema: '[list_projects]'}}))
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const pathname = new URL(request.url()).pathname
		const [, id, action] = pathname.split('/ai/conversations')[1].split('/')
		const body = request.postDataJSON()
		if (!id) {
			if (request.method() === 'GET') {
    const query = new URL(request.url()).searchParams
    const scope = query.get('scope'), q = (query.get('q') ?? '').toLowerCase()
    const items = [...conversations.values()].filter(c => (scope !== 'active' || !c.archived) && (scope !== 'archived' || c.archived) && (!q || `${c.title} ${c.turns.map((t: any) => `${t.prompt} ${t.result?.reply}`).join(' ')}`.toLowerCase().includes(q))).sort((a,b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map(c => ({...c, running: c.turns.some((t: any) => t.status === 'running'), turn_count: c.turns.length}))
    return route.fulfill({json: {items, total_pages: 1, total: items.length}})
   }
			const c = {id: crypto.randomUUID(), title: '', turns: [], compactions: []}
			conversations.set(c.id, c)
			return route.fulfill({status: 201, json: c})
		}
		const c = conversations.get(id)!
		if (action === 'events') return route.fulfill({
			status: 200,
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({
				turn: c.turns.at(-1),
				storage: c.storage,
				compacting: c.compacting ?? false,
				compactions: c.compactions,
				compact_progress: c.compact_progress,
				compact_error: c.compact_error,
				compact_text: c.compact_text,
			})}\n\n`,
		})
		if (action === 'messages') {
			sends++
			c.title ||= body.message
			c.turns.push({id: crypto.randomUUID(), request_id: body.request_id, prompt: body.message, status: 'completed', result: {
				configuration: {connection_id: body.connection_id, project_id: body.project_id, mode: body.mode, approval: body.approval, allow_delete: body.allow_delete, write_project_ids: body.write_project_ids, max_rounds: body.max_rounds, max_operations: body.max_operations, timeout_seconds: body.timeout_seconds, token_budget: body.token_budget}, reply: '**Saved answer**', model: 'actual-fixture', requested_model: 'requested', protocol: 'anthropic', endpoint: 'https://fixture.example/v1/messages', system_prompt: 'Actual request prompt', duration_ms: 2000, first_token_ms: 125, first_text_ms: 500,
				usage: {input: 30, output: 20, reported: true, cached: 5, cache_reported: true},
				steps: [{round: 1, loaded_tools: ['list_projects', 'find_tools'], tool_schema_bytes: 1200, catalog_schema_bytes: 8000, catalog_tool_count: 20, model: 'actual-fixture', reasoning: 'Provider thinking fixture', text: '**Saved answer**', streaming: true, first_token_ms: 125, usage: {input: 30, output: 20, reported: true, cached: 5, cache_reported: true}, duration_ms: 2000}],
				actions: [{round: 1, tool: 'list_projects', arguments: '{}', result: '{"items":[]}', success: true, duration_ms: 10}],
			}})
		}
		if (withReview && action === 'messages') {
			const turn = c.turns.at(-1)
			turn.status = 'awaiting_approval'; turn.result.reply = ''
			turn.result.trace_id = 'fixture-trace-123'; turn.result.pause = 'review'
			turn.result.budget = {rounds: 1, round_limit: 16, operations: 0, operation_limit: 40}
			turn.result.pending = {id: crypto.randomUUID(), tool: 'update_task', units: 1, arguments: '{"id":1,"title":"Private proposed title"}', before: '[{"id":1,"title":"Private old title"}]'}
		}
		if (action === 'review') {
			reviews.push(body)
			const turn = c.turns.at(-1)
			if (body.decision === 'edit') {
				turn.result.pending.id = crypto.randomUUID(); turn.result.pending.arguments = body.arguments
			} else {
				turn.status = 'completed'; turn.result.pause = ''; turn.result.reply = 'Saved after review'
				turn.result.actions = [{tool: 'update_task', round: 1, success: true, arguments: turn.result.pending.arguments, result: '{"description":"Private tool result","api_key":"never-share-this-credential"}', duration_ms: 12}]
				turn.result.pending = null
			}
		}
		if (live && action === 'messages') {
			const turn=c.turns.at(-1);turn.status='running';turn.started=new Date().toISOString();turn.result.reply='';turn.result.stage='model'
			turn.result.steps=[{round:1,started:new Date().toISOString(),model:'actual-fixture',streaming:true,reasoning:'Checking accessible projects as data arrives',text:'',output_characters:48,usage:{input:30,output:5,reported:true},tool_calls:[{id:'draft-1',function:{name:'list_projects',arguments:'{'}}]}];turn.result.actions=[]
			setTimeout(()=>{turn.status='completed';turn.result.reply='Saved after background execution';turn.result.stage='completed'},2500)
		}
		if (action === 'organization') {
   if (body.pinned !== undefined) { c.pinned = body.pinned; if (body.pinned) c.archived = false }
   if (body.archived !== undefined) { c.archived = body.archived; if (body.archived) c.pinned = false }
  }
  if (action === 'title') c.title = body.title
		if (action === 'compact') {
			c.compact_error = ''
			c.compact_progress = undefined
			c.compact_text = ''
			c.compacting = true
			setTimeout(() => {
				c.compactions.push({
					through: c.turns.length,
					summary: 'Kept compact summary',
					model: 'actual-fixture',
					usage: {
						input: 100,
						output: 20,
						reported: true,
					},
				})
				c.compacting = false
			}, 200)
		}
		if (action === 'fork') {
			const branch = structuredClone(c)
			branch.id = crypto.randomUUID()
			branch.parent_id = id
			branch.turns = branch.turns.slice(0, branch.turns.findIndex((t: any) => t.id === body.turn_id) + 1)
			branch.compactions = []
			conversations.set(branch.id, branch)
			return route.fulfill({status: 201, json: branch})
		}
		if (request.method() === 'DELETE') { conversations.delete(id); return route.fulfill({status: 204}) }
		return route.fulfill({status: request.method() === 'GET' ? 200 : 201, json: c})
	})
	return {conversations, reviews, sends: () => sends}
}

test('chat persists, exposes real run details, compacts and branches without replay', async ({authenticatedPage: page}) => {
	const server = await chatServer(page)
	await page.goto('/ai')
	await page.setViewportSize({width: 1440, height: 900})
	await expect(page.locator('.profile-switch select')).toHaveValue('ask')
	await page.getByLabel('Your request').fill('First message')
	await expect(page.getByRole('button', {name: 'Send request', exact: true})).toBeEnabled()
		await page.getByLabel('Your request').press('Enter')
	await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	// The round's text is the answer: it is shown once, not again as an interim reply.
	await expect(page.locator('.step-reply')).toHaveCount(0)
	await page.evaluate(() => scrollTo(0, 0))
	expect((await page.locator('.composer').boundingBox())!.y + (await page.locator('.composer').boundingBox())!.height).toBeLessThanOrEqual(900)
	await page.locator('.run-summary > summary').click()
	const turnTotal = page.locator('.run-summary [data-scope="turn"]')
	await expect(turnTotal).toContainText('0.13 s')
	await expect(turnTotal).toContainText('0.50 s')
	await expect(turnTotal).toContainText('Input 30')
	await expect(turnTotal).toContainText('Output 20')
	await page.locator('.reasoning > summary').click()
	await expect(page.locator('.reasoning')).toContainText('Provider thinking fixture')
	await page.locator('.tool-row > summary').click()
	await expect(page.locator('.tool-row')).toContainText('Actual tool result')
	await page.locator('.request-details > summary').click()
	await expect(page.locator('.request-details')).toContainText('Actual request prompt')
	await expect(page.locator('.request-details')).toContainText('https://fixture.example/v1/messages')
	await page.reload()
	await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	await page.locator('.conversation-toolbar .chat-menu-trigger').click()
	await page.getByRole('menuitem', {name: 'Rename conversation', exact: true}).click()
	await page.getByRole('textbox', {name: 'Chat title'}).fill('Reusable session')
	await page.getByRole('button', {name: 'Save', exact: true}).click()
	await expect(page.locator('.conversation-title')).toHaveText('Reusable session')
	await expect(page.getByRole('dialog', {name: 'Rename conversation'})).not.toBeVisible()
	for (let n = 0; n < 4; n++) {
		await page.getByLabel('Your request').fill(`Message ${n + 2}`)
		await expect(page.getByRole('button', {name: 'Send request', exact: true})).toBeEnabled()
		await page.getByLabel('Your request').press('Enter')
		await expect(page.locator('.chat-turn')).toHaveCount(n + 2)
	}
	page.on('dialog', dialog => dialog.accept())
	await page.locator('.conversation-toolbar .chat-menu-trigger').click()
	await page.getByRole('menuitem', {name: 'Compact context', exact: true}).click()
	await expect(page.locator('.summary-banner')).toContainText('turn 5')
	await expect(page.locator('.chat-turn')).toHaveCount(5)
	await page.getByRole('button', {name: 'Branch from here'}).first().click()
	await expect(page.locator('.chat-turn')).toHaveCount(1)
	expect(server.sends()).toBe(5)
	expect(server.conversations.size).toBe(2)
	if (!await page.locator('.chat-sidebar').isVisible()) await page.getByRole('button', {name: 'Conversations', exact: true}).click()
	await page.locator('.system-prompt > summary').click()
	await expect(page.locator('.system-prompt')).toContainText('Actual built-in fixture prompt')
})

test('send keeps the clicked permissions and preserves a new draft while creation is pending', async ({authenticatedPage: page}) => {
	await chatServer(page)
	let release!: () => void
	const gate = new Promise<void>(resolve => { release = resolve })
	await page.route('**/api/v2/ai/conversations', async route => {
		if (route.request().method() === 'POST') await gate
		await route.fallback()
	})
	await page.goto('/ai')
	await page.getByLabel('Your request').fill('Original read-only instruction')
	const creating = page.waitForRequest(r => r.url().endsWith('/ai/conversations') && r.method() === 'POST')
	await page.getByRole('button', {name: 'Send request', exact: true}).click()
	await creating
	await page.getByRole('button', {name: 'Scenarios & preferences', exact: true}).click()
	await page.getByLabel('Working mode').selectOption('write')
	await page.getByLabel('Allow task deletion for this request').check()
	await page.getByRole('button', {name: 'Use for upcoming messages'}).click()
	await page.getByLabel('Your request').fill('New draft for later')
	const sent = page.waitForRequest(r => r.url().endsWith('/messages'))
	release()
	const request = (await sent).postDataJSON()
	expect(request.message).toBe('Original read-only instruction')
	expect(request.mode).toBe('read')
	expect(request.allow_delete).toBe(false)
	await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	await expect(page.getByLabel('Your request')).toHaveValue('New draft for later')
})

for (const width of [320, 390]) {
	test(`mobile chat ${width}px keeps composer, saved history and multiline input usable`, async ({authenticatedPage: page}) => {
		await chatServer(page)
		await page.setViewportSize({width, height: 844})
		await page.goto('/ai')
		await page.getByLabel('Your request').fill('First line')
		await page.getByLabel('Your request').press('Shift+Enter')
		await page.getByLabel('Your request').press('a')
		await expect(page.getByLabel('Your request')).toHaveValue('First line\na')
		await page.getByRole('button', {name: 'Send request', exact: true}).click()
		await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
		if (!await page.locator('.chat-sidebar').isVisible()) await page.getByRole('button', {name: 'Conversations', exact: true}).click()
		await expect(page.locator('.chat-sidebar')).toBeVisible()
		await page.locator('.history-link').filter({hasText: 'First line'}).click()
		await expect(page.locator('.chat-sidebar')).not.toBeVisible()
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	})
}

test('review can be edited and resumed; diagnostic export defaults to metadata on mobile', async ({authenticatedPage: page}) => {
	const server = await chatServer(page, true)
	await page.setViewportSize({width: 390, height: 844})
	await page.goto('/ai')
	await page.getByLabel('Your request').fill('Review me')
	await page.getByRole('button', {name: 'Send request', exact: true}).click()
	await expect(page.getByRole('heading', {name: 'Review this operation'})).toBeVisible()
	await expect(page.locator('.change-table')).toContainText('Private old title')
	await page.getByRole('button', {name: 'Edit this operation', exact: true}).click()
	await page.getByLabel('Edit arguments (JSON)').fill('{"id":1,"title":"Private edited title"}')
	await page.getByRole('button', {name: 'Update preview', exact: true}).click()
	await expect(page.locator('.change-table')).toContainText('Private edited title')
	expect(server.reviews.map(r => r.decision)).toEqual(['edit'])
	await page.getByRole('button', {name: 'Approve and continue', exact: true}).click()
	await expect(page.locator('.chat-markdown')).toHaveText('Saved after review')
	expect(server.reviews.map(r => r.decision)).toEqual(['edit', 'approve'])
	expect(server.sends()).toBe(1)
	await page.getByRole('button', {name: 'Inspect run diagnostics', exact: true}).click()
	const dialog = page.getByRole('dialog', {name: 'Errors and diagnostics'})
	await expect(dialog).toBeVisible()
	await expect(dialog.locator('pre')).toContainText('fixture-trace-123')
	await expect(dialog.locator('pre')).toContainText('tool_schema_bytes')
	await expect(dialog.locator('pre')).not.toContainText('Private edited title')
	await expect(dialog.locator('pre')).not.toContainText('Private tool result')
	await dialog.getByLabel('Include error details, tool arguments and results (may contain private content)').check()
	await expect(dialog.locator('pre')).toContainText('Private edited title')
	await expect(dialog.locator('pre')).not.toContainText('never-share-this-credential')
	await dialog.getByRole('button', {name: 'Copy diagnostic report', exact: true}).click()
	await expect(dialog.getByRole('button', {name: 'Copied', exact: true})).toBeVisible()
	const copied = await page.evaluate(() => navigator.clipboard.readText())
	expect(JSON.parse(copied).entry.metadata.trace_id).toBe('fixture-trace-123')
	expect(copied).not.toContain('never-share-this-credential')
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible()
	await page.reload(); await expect(page.locator('.chat-markdown')).toHaveText('Saved after review')
	expect(server.sends()).toBe(1)
})
test('proxy HTML errors produce a useful diagnostic instead of rendering the block page', async ({authenticatedPage: page}) => {
	await chatServer(page)
	await page.route('**/api/v2/ai/settings', route => route.fulfill({status: 403, contentType: 'text/html', body: '<!DOCTYPE html><html><title>Blocked</title><body>private-block-page-token</body></html>'}))
	await page.goto('/ai')
	await page.locator('.heading-actions').getByRole('button', {name: 'Errors and diagnostics', exact: true}).click()
	const dialog = page.getByRole('dialog', {name: 'Errors and diagnostics'})
	await expect(dialog.locator('pre')).toContainText('PROXY_HTML')
	await expect(dialog.locator('pre')).toContainText('/api/v2/ai/settings')
	await expect(dialog.locator('pre')).not.toContainText('private-block-page-token')
	await expect(dialog.locator('pre')).not.toContainText('<!DOCTYPE')
})


test('live thinking, real usage and tool drafts remain observable after leaving the page', async ({authenticatedPage:page})=>{
	const server=await chatServer(page,false,true)
	await page.goto('/ai')
	await page.getByLabel('Your request').fill('Live run')
	await page.getByLabel('Your request').press('Enter')
	await expect(page.locator('.live-run-panel')).toContainText('Receiving model stream')
	await expect(page.locator('.live-run-panel [data-scope="request"]')).toContainText('Input 30')
	// Checked before the fixture completes the run 2.5 s after sending; afterwards it is only a proposed call.
	await expect(page.locator('.tool-row.is-draft')).toContainText('Receiving proposed tool arguments')
	await page.locator('.reasoning > summary').click()
	await expect(page.locator('.reasoning')).toContainText('Checking accessible projects as data arrives')
	const url=page.url()
	await page.goto('/')
	await expect.poll(()=>[...server.conversations.values()][0]?.turns[0]?.status).toBe('completed')
	await page.goto(url)
	await expect(page.locator('.chat-markdown')).toHaveText('Saved after background execution')
	expect(server.sends()).toBe(1)
})

test('failed compaction exposes provider termination and can retry without losing messages', async ({authenticatedPage: page}) => {
	const server = await chatServer(page)
	await page.goto('/ai')
	await page.getByLabel('Your request').fill('Preserve this original message')
	await page.getByLabel('Your request').press('Enter')
	await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	const c = [...server.conversations.values()][0]
	c.compact_error = 'The model reached its output token limit before finishing.'
	c.compact_progress = {batch: 1, batches: 3, attempt: 2, duration_ms: 15200, protocol: 'anthropic', endpoint: 'https://fixture.example/v1/messages', error_code: 'MODEL_OUTPUT_LIMIT', usage: {reported: true, input: 200, output: 8192}, steps: [{round: 1, model: 'actual-fixture', http_status: 200, stop_reason: 'max_tokens', usage: {reported: true, output: 4096}}]}
	await page.reload()
	await expect(page.locator('.compact-progress')).toContainText('Batch 1/3 · Attempt 2/2')
	await expect(page.locator('.compact-progress')).toContainText('8392')
	await page.getByRole('button', {name: 'Compaction diagnostics', exact: true}).click()
	const dialog = page.getByRole('dialog', {name: 'Errors and diagnostics'})
	await expect(dialog.locator('pre')).toContainText('MODEL_OUTPUT_LIMIT')
	await expect(dialog.locator('pre')).toContainText('max_tokens')
	await expect(dialog.locator('pre')).not.toContainText('Preserve this original message')
	await page.keyboard.press('Escape')
	page.on('dialog', dialog => dialog.accept())
	await page.getByRole('button', {name: 'Retry compaction', exact: true}).click()
	await expect(page.locator('.summary-banner')).toContainText('Kept compact summary')
	// A finished compaction leaves only its summary; the failed run's progress is gone.
	await expect(page.locator('.compact-progress')).toHaveCount(0)
	await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	expect(c.turns).toHaveLength(1)
	expect(server.sends()).toBe(1)
})

for (const width of [320, 390]) {
	test(`first mobile visit ${width}px keeps installation promotion out of the chat composer`, async ({authenticatedPage: page}) => {
		await chatServer(page)
		await page.setViewportSize({width, height: 844})
		await page.addInitScript(() => localStorage.setItem('hideAddToHomeScreenMessage', 'false'))
		await page.goto('/')
		await expect(page.locator('.add-to-home-screen')).toBeVisible()
		await page.goto('/ai')
		await expect(page.getByLabel('Your request')).toBeVisible()
		await expect(page.locator('.add-to-home-screen')).toHaveCount(0)
		await page.getByLabel('Your request').fill('First visit draft')
		const box = await page.locator('.composer').boundingBox()
		expect(box!.y + box!.height).toBeLessThanOrEqual(844)
		await page.getByLabel('Your request').press('Enter')
		await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
	})
}

test('permission switching survives reload, uses current request settings and restores each conversation', async ({authenticatedPage: page}) => {
 const server = await chatServer(page)
 await page.goto('/ai')
 const profile = page.locator('.profile-switch select')
 const send = async (text: string) => {
  const request = page.waitForRequest(r => r.url().endsWith('/messages') && r.method() === 'POST')
  await page.getByLabel('Your request').fill(text)
  await page.getByLabel('Your request').press('Enter')
  const body = (await request).postDataJSON()
  await expect(page.getByLabel('Your request')).toHaveValue('')
  return body
 }
 expect((await send('Read first')).mode).toBe('read')
 const firstURL = page.url()
 await profile.selectOption('assist')
 await expect(page.getByRole('status').filter({hasText: 'Applied to the next message'})).toBeVisible()
 await page.reload()
 await expect(profile).toHaveValue('assist')
 expect((await send('Now write')).mode).toBe('write')
 const first = [...server.conversations.values()][0]
 expect(first.turns[0].result.configuration.mode).toBe('read')
 expect(first.turns[1].result.configuration.mode).toBe('write')
 // A clean tab restores the server's last effective settings, not the account read-only default.
 await page.evaluate(() => sessionStorage.clear())
 await page.reload()
 await expect(page.locator('.composer-hint')).toContainText('Next message:')
 await expect(page.locator('.composer-hint')).toContainText('Execute')
 await profile.selectOption('ask')
 expect((await send('Read again')).mode).toBe('read')
 const panelButton = page.getByRole('button', {name: 'Scenarios & preferences', exact: true})
 await panelButton.click()
 const panel = page.getByRole('dialog', {name: 'Scenarios & preferences'})
 await panel.getByRole('button', {name: /Plan & review Turn ideas/}).click()
 await panel.getByRole('button', {name: 'Use for upcoming messages'}).click()
 const write = await send('Use reviewed writes')
 expect(write.mode).toBe('write'); expect(write.approval).toBe('review')
 await page.goto('/ai')
 await expect(profile).toHaveValue('ask')
 expect((await send('Separate read conversation')).mode).toBe('read')
 await page.goto(firstURL)
 await expect(page.locator('.composer-hint')).toContainText(/Review/i)
 const restored = await send('Continue original')
 expect(restored.mode).toBe('write'); expect(restored.approval).toBe('review')
})

for (const width of [1440, 390]) {
 test(`sending is immediate and sources stay collapsed at ${width}px`, async ({authenticatedPage: page}, testInfo) => {
  const server = await chatServer(page)
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  await page.route('**/ai/conversations/*/messages', async route => { await gate; await route.fallback() })
  await page.setViewportSize({width, height: 900})
  await page.goto('/ai')
  await page.getByLabel('Your request').fill('Show sources without blocking the composer')
  await page.getByLabel('Your request').press('Enter')
  await expect(page.locator('.user-message p')).toHaveText('Show sources without blocking the composer')
  await expect(page.getByLabel('Your request')).toHaveValue('')
  await expect(page.locator('.thinking-status')).toHaveText('Sending…')
  await page.locator('.chat-turn').evaluate(el => { el.setAttribute('data-identity-check', 'same-node') })
  unblock()
  await expect(page.locator('.chat-markdown')).toHaveText('Saved answer')
  await expect(page.locator('.chat-turn')).toHaveCount(1)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-identity-check', 'same-node')
  expect((await page.locator('.conversation-toolbar').boundingBox())!.height).toBeLessThan(65)
  const c = [...server.conversations.values()][0]
  c.turns[0].result.actions = [{round: 1, tool: 'web_search', success: true, search: {verified: true, protocol: 'deepseek', endpoint: 'https://api.deepseek.com/v1/tools/search', duration_ms: 123, sources: [{title: 'Vikunja documentation', url: 'https://vikunja.io/docs/'}, {title: 'Vue performance', url: 'https://vuejs.org/guide/best-practices/performance'}]}}]
  await page.reload()
  const evidence = page.locator('.assistant-message > .web-evidence')
  await expect(evidence.locator('.sources-disclosure')).not.toHaveAttribute('open')
  await expect(evidence.getByRole('link')).toHaveCount(0)
  await evidence.locator('.sources-disclosure > summary').click()
  await expect(evidence.getByRole('link', {name: 'Vikunja documentation'})).toBeVisible()
  await expect(evidence.locator('.source-diagnostics')).not.toHaveAttribute('open')
  await evidence.locator('.source-diagnostics > summary').click()
  await expect(evidence.locator('code')).toHaveText('https://api.deepseek.com/v1/tools/search')
  await evidence.locator('.sources-disclosure > summary').click()
  await expect(evidence.getByRole('link')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({path: testInfo.outputPath(`chat-sources-${width}.png`), animations: 'disabled'})
 })
}

test('failed send restores the draft and removes the pending row', async ({authenticatedPage: page}) => {
 await chatServer(page)
 await page.route('**/ai/conversations/*/messages', route => route.fulfill({status: 503, json: {message: 'Fixture unavailable'}}))
 await page.goto('/ai')
 await page.getByLabel('Your request').fill('Keep this unsent draft')
 await page.getByLabel('Your request').press('Enter')
 await expect(page.getByText('The message could not be sent. Your draft has been kept.')).toBeVisible()
 await expect(page.getByLabel('Your request')).toHaveValue('Keep this unsent draft')
 await expect(page.locator('.chat-turn')).toHaveCount(0)
})

for (const width of [1440, 390, 320]) {
 test(`icon centers and completed output speed at ${width}px`, async ({authenticatedPage: page}, testInfo) => {
  const server = await chatServer(page)
  await page.setViewportSize({width, height: 900})
  await page.goto('/ai')
  const sendButton = page.getByRole('button', {name: 'Send request', exact: true})
  async function expectCentered(selector: string) {
   const measurements = await page.locator(selector).evaluateAll(buttons => buttons.filter(b => b.getBoundingClientRect().width > 0).map(button => {
    const b = button.getBoundingClientRect(), svg = button.querySelector('svg')!.getBoundingClientRect()
    return {dx: Math.abs(svg.x + svg.width / 2 - b.x - b.width / 2), dy: Math.abs(svg.y + svg.height / 2 - b.y - b.height / 2)}
   }))
   expect(measurements.length).toBeGreaterThan(0)
   for (const m of measurements) { expect(m.dx).toBeLessThan(0.75); expect(m.dy).toBeLessThan(0.75) }
  }
  await expect(sendButton).toBeVisible()
  await expectCentered('.composer .send')
  await page.getByLabel('Your request').fill('Measure the final model response')
  await expectCentered('.composer .send')
  await sendButton.click()
  await expect(page.locator('.output-speed > summary')).toContainText('10.1 tokens/s')
  const c = [...server.conversations.values()][0]
  // The preceding model request and a long tool call must not affect the final response speed.
  c.turns[0].result.duration_ms = 90000
  c.turns[0].result.usage.output = 9999
  c.turns[0].result.steps = [{round: 1, model: 'tool-model', streaming: true, duration_ms: 20000, first_token_ms: 10000, usage: {reported: true, output: 999}}, {round: 2, model: 'final-model', text: '**Saved answer**', streaming: true, duration_ms: 3000, first_token_ms: 1000, usage: {reported: true, output: 101}}]
  await page.reload()
  await expect(page.locator('.output-speed > summary')).toHaveText('Output speed: 50.0 tokens/s')
  await page.locator('.output-speed > summary').click()
  await expect(page.locator('.speed-explanation')).toContainText('final-model')
  await expect(page.locator('.speed-calculation')).toHaveText('(101 − 1) ÷ 2 s')
  c.turns[0].status = 'running'
  c.turns[0].result.reply = ''
  await page.reload()
  await expect(page.locator('.output-speed')).toHaveCount(0)
  await expect(page.getByRole('button', {name: 'Stop execution', exact: true})).toBeVisible()
  await expectCentered('.composer .send')
  await expectCentered('.conversation-toolbar .chat-menu-trigger')
  await page.screenshot({path: testInfo.outputPath(`chat-stop-centered-${width}.png`), animations: 'disabled'})
  c.turns[0].status = 'completed'; c.turns[0].result.steps[1].streaming = false
  await page.reload()
  await expect(page.locator('.output-speed > summary')).toHaveText('Request-average speed: 33.7 tokens/s')
  c.turns[0].result.steps[1].usage.reported = false
  await page.reload()
  await expect(page.locator('.output-speed > summary')).toHaveText('Output speed: Unavailable')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
 })
}

for (const width of [1440, 390, 320]) {
 test(`floating Arona ${width}px preserves the page and continues when minimized`, async ({authenticatedPage: page}, testInfo) => {
  const server = await chatServer(page, false, true)
  await page.setViewportSize({width, height: 900})
  await page.goto('/user/settings/general')
  await expect(page).toHaveTitle(/General Settings/)
  const originalURL = page.url()
  const originalTitle = await page.title()
  await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
  const panel = page.getByRole('region', {name: 'Arona', exact: true})
  await expect(panel).toBeVisible()
  await panel.getByLabel('Your request').fill('Keep working while I browse')
  await expect(panel.getByRole('button', {name: 'Send request', exact: true})).toBeEnabled()
  await panel.getByRole('button', {name: 'Send request', exact: true}).click()
  await expect(panel.locator('.thinking-status')).toBeVisible()
  expect(page.url()).toBe(originalURL)
  expect(await page.title()).toBe(originalTitle)
  const box = await panel.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
  await expect(panel).toBeHidden()
  await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
  await expect(panel.locator('.chat-markdown')).toContainText('Saved after background execution')
  expect(server.sends()).toBe(1)
  await page.screenshot({path: testInfo.outputPath(`floating-${width}.png`)})
  const id = [...server.conversations.keys()][0]
  await panel.getByRole('button', {name: 'Open full conversation page', exact: true}).click()
  await expect(page).toHaveURL(new RegExp(`/ai\\?chat=${id}`))
  await expect(page.locator('.chat-markdown')).toContainText('Saved after background execution')
  await expect(page.locator('.floating-arona')).toHaveCount(0)
 })
}


test('floating Arona refreshes the visible task and follows task dialog context', async ({authenticatedPage: page, apiContext}) => {
 const server = await chatServer(page, false, true)
 await createProjects(1)
 await TaskFactory.create(1, {title: 'Before agent change'})
 await BucketFactory.create(1, {id: 1, project_view_id: 4})
 await TaskBucketFactory.create(1, {task_id: 1, bucket_id: 1, project_view_id: 4})
 await page.setViewportSize({width: 1440, height: 900})
 await page.goto('/projects/1/4')
 await page.getByText('Before agent change', {exact: true}).click()
 await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
 await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
 const panel = page.getByRole('region', {name: 'Arona', exact: true})
 await panel.press('Escape')
 await expect(panel).toBeHidden()
 await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
 await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
 await panel.getByLabel('Your request').fill('Rename the current task')
 await expect(panel.getByRole('button', {name: 'Send request', exact: true})).toBeEnabled()
 const sent = page.waitForRequest(r => r.url().endsWith('/messages') && r.method() === 'POST')
 await panel.getByRole('button', {name: 'Send request', exact: true}).click()
 const request = (await sent).postDataJSON()
 expect(JSON.parse(request.page_context)).toMatchObject({project_id: 1, task_id: 1})
 const token = await page.evaluate(() => localStorage.getItem('token'))
 const root = apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456') + '/api/v2'
 const response = await apiContext.patch(`${root}/tasks/1`, {headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/merge-patch+json'}, data: {title: 'Changed by agent fixture'}})
 expect(response.ok()).toBe(true)
 const conversation = [...server.conversations.values()][0]
 conversation.turns[0].result.actions = [{tool: 'update_task', success: true, arguments: '{"id":1}', result: '{}'}]
 await expect(page.locator('.task-view')).toContainText('Changed by agent fixture')
 await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
 // Return to the project without a reload; the same floating conversation survives.
 await page.getByRole('button', {name: 'Close dialog', exact: true}).click()
 await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
 await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
 await expect(panel.locator('.user-message')).toContainText('Rename the current task')
 expect(server.sends()).toBe(1)
})

for (const width of [1440, 390, 320]) {
 test(`retry interrupted model round from saved results at ${width}px`, async ({authenticatedPage: page}) => {
  const server = await chatServer(page)
  const id = crypto.randomUUID(), turnID = crypto.randomUUID()
  const c = {id, title: 'Interrupted request', turns: [{id: turnID, request_id: 'original-request', prompt: 'Create a meeting', status: 'failed', retryable: true, result: {stage: 'model', error: 'The model response stream was interrupted.', steps: [], actions: [{tool: 'create_task', success: true, result: '{"id":123}'}]}}], compactions: []}
  server.conversations.set(id, c)
  let retries = 0
  await page.route(`**/ai/conversations/${id}/review`, async route => {
   expect(route.request().postDataJSON().decision).toBe('retry')
   expect(route.request().postDataJSON().turn_id).toBe(turnID)
   retries++
   await new Promise(resolve => setTimeout(resolve, 300))
   Object.assign(c.turns[0], {status: 'completed', retryable: false})
   Object.assign(c.turns[0].result, {error: '', reply: 'Continued without another create'})
   await route.fulfill({status: 201, json: c})
  })
  await page.setViewportSize({width, height: 900})
  await page.goto(`/ai?chat=${id}`)
  const button = page.getByRole('button', {name: 'Retry and continue', exact: true})
  await expect(button).toBeVisible()
  await page.reload()
  await button.click()
  await expect(button).toBeDisabled()
  await expect(page.getByText('Continued without another create', {exact: true})).toBeVisible()
  await expect(button).toHaveCount(0)
  expect(retries).toBe(1)
  expect(server.sends()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
 })
}

for (const width of [1440, 390, 320]) {
	test(`cache efficiency uses weighted reported input and fits ${width}px`, async ({authenticatedPage: page}) => {
		const server = await chatServer(page)
		const id = crypto.randomUUID()
		server.conversations.set(id, {id, title: 'Cache metrics', turns: [{id: crypto.randomUUID(), prompt: 'Metrics fixture', status: 'completed', result: {
			system_prompt: 'Stable instructions', reply: 'Done', model: 'fixture', steps: [
				{round: 1, model: 'fixture', usage: {reported: true, input: 100, cached: 90, cache_reported: true}},
				{round: 2, model: 'fixture', usage: {reported: true, input: 900, cached: 450, cache_reported: true}},
				{round: 3, model: 'fixture', usage: {reported: true, input: 100, cached: 0, cache_reported: false}},
			], actions: [],
		}}], compactions: []})
		await page.setViewportSize({width, height: 900})
		await page.goto(`/ai?chat=${id}`)
		await page.reload()
		await page.locator('.run-summary > summary').click()
		const total = page.locator('.run-summary .run-cache [data-testid="cache-usage"]')
		await expect(total).toContainText('54.0%')
		await expect(total).toContainText('540 / 1,000')
		await expect(total).toContainText('460')
		await expect(total).toContainText('2/3')
		for (const round of [1, 2, 3]) await page.locator(`.timeline-step[data-round="${round}"] .step-meta > summary`).click()
		const steps = page.locator('.step-meta [data-testid="cache-usage"]')
		await expect(steps.nth(0)).toContainText('90.0%')
		await expect(steps.nth(1)).toContainText('50.0%')
		await expect(steps.nth(2)).toContainText('has not reported')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
	})
}

for (const width of [1440, 390, 320]) {
 test(`chat history management ${width}px pins searches archives restores and deletes without losing the current draft`, async ({authenticatedPage: page}) => {
  await page.setViewportSize({width, height: 900})
  const server = await chatServer(page)
  const first = {id: crypto.randomUUID(), title: 'Planning one', updated: new Date().toISOString(), turns: [{id: crypto.randomUUID(), prompt: 'Unique needle in message', status: 'completed', result: {reply: 'Saved answer'}}], compactions: []}
  const second = {id: crypto.randomUUID(), title: 'Planning two', updated: new Date().toISOString(), turns: [], compactions: []}
  server.conversations.set(first.id, first); server.conversations.set(second.id, second)
  await page.goto(`/ai?chat=${first.id}`)
  await page.getByLabel('Your request').fill('Keep this draft')
  if (!await page.locator('.chat-sidebar').isVisible()) await page.getByRole('button', {name: 'Conversations', exact: true}).click()
  const row = () => page.locator(`[data-chat-id="${second.id}"]`)
  await row().getByRole('button', {name: 'Options for Planning two'}).click()
  await page.getByRole('menuitem', {name: 'Pin chat', exact: true}).click()
  await expect(page.getByRole('region', {name: 'Pinned'}).locator('[data-chat-id]')).toHaveAttribute('data-chat-id', second.id)
  await row().getByRole('button', {name: 'Options for Planning two'}).click()
  await page.getByRole('menuitem', {name: 'Rename conversation'}).click()
  const dialog = page.getByRole('dialog', {name: 'Rename conversation'})
  await dialog.getByRole('textbox', {name: 'Chat title'}).fill('Renamed second')
  await dialog.getByRole('button', {name: 'Save', exact: true}).click()
  await expect(dialog).not.toBeVisible()
  await expect(row()).toContainText('Renamed second')
  await page.screenshot({path: `/opt/vikunja-tcymc/worklogs/v25-history-${width}.png`})
  await row().getByRole('button', {name: 'Options for Renamed second'}).click()
  await page.getByRole('menuitem', {name: 'Archive', exact: true}).click()
  await expect(row()).toHaveCount(0)
  await page.getByRole('button', {name: 'Archived', exact: true}).click()
  await expect(row()).toBeVisible()
  await row().getByRole('button', {name: 'Options for Renamed second'}).click()
  await page.getByRole('menuitem', {name: 'Unarchive', exact: true}).click()
  await expect(row()).toHaveCount(0)
  await page.getByRole('button', {name: 'Chats', exact: true}).click()
  // The list shown until the debounced search runs may be the cached one, so wait for the search itself.
  const searched = page.waitForResponse(response => {
   const url = new URL(response.url())
   return response.request().method() === 'GET' && url.pathname.endsWith('/ai/conversations')
    && url.searchParams.get('q') === 'needle' && url.searchParams.get('scope') === 'all'
  })
  await page.getByRole('searchbox', {name: 'Search chats'}).fill('needle')
  await searched
  // Only the chat whose message holds the needle, and only under the results heading.
  await expect(page.getByRole('region', {name: 'Search results'}).locator('.history-link')).toHaveText(['Planning one'])
  await expect(row()).toHaveCount(0)
  await page.getByRole('searchbox', {name: 'Search chats'}).fill('')
  await expect(row()).toBeVisible()
  await row().getByRole('button', {name: 'Options for Renamed second'}).click()
  await page.getByRole('menuitem', {name: 'Delete conversation'}).click()
  const deletion = page.getByRole('dialog', {name: 'Delete conversation'})
  await expect(deletion).toContainText('cannot be undone')
  await deletion.getByRole('button', {name: 'Cancel', exact: true}).click()
  expect(server.conversations.has(second.id)).toBe(true)
  await row().getByRole('button', {name: 'Options for Renamed second'}).click()
  await page.getByRole('menuitem', {name: 'Delete conversation'}).click()
  await deletion.getByRole('button', {name: 'Delete conversation', exact: true}).click()
  await expect(row()).toHaveCount(0)
  await page.locator('.history-panel').getByRole('button', {name: 'Close chat history', exact: true}).click()
  await expect(page.getByLabel('Your request')).toHaveValue('Keep this draft')
  expect(server.conversations.has(first.id)).toBe(true)
  expect(server.sends()).toBe(0)
  await page.reload()
  await expect(page.locator('.conversation-title')).toHaveText('Planning one')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow).toBe(false)
 })
}

test('chat history keyboard menu protects running work and current deletion returns to a clean composer', async ({authenticatedPage: page}) => {
 const server = await chatServer(page)
 const chat: any = {id: crypto.randomUUID(), title: 'Live chat', turns: [{id: crypto.randomUUID(), status: 'running', prompt: 'Continue', result: {}}], compactions: []}
 server.conversations.set(chat.id, chat)
 await page.goto(`/ai?chat=${chat.id}`)
 const trigger = page.locator('.conversation-toolbar .chat-menu-trigger')
 await trigger.focus(); await page.keyboard.press('Enter')
 await expect(page.getByRole('menuitem', {name: 'Delete conversation'})).toBeDisabled()
 await expect(page.getByRole('menuitem', {name: 'Pin chat', exact: true})).toBeFocused()
 await page.keyboard.press('ArrowDown')
 await expect(page.getByRole('menuitem', {name: 'Rename conversation'})).toBeFocused()
 await page.keyboard.press('Escape'); await expect(trigger).toBeFocused()
 await trigger.click(); await page.getByRole('menuitem', {name: 'Archive', exact: true}).click()
 await expect(page.locator('.archived-notice')).toBeVisible()
 expect(chat.turns[0].status).toBe('running')
 chat.turns[0].status = 'completed'
 await page.reload()
 await trigger.click(); await page.getByRole('menuitem', {name: 'Delete conversation'}).click()
 await page.getByRole('dialog', {name: 'Delete conversation'}).getByRole('button', {name: 'Delete conversation', exact: true}).click()
 await expect(page.locator('.conversation-title')).toHaveCount(0)
 await expect(page.getByLabel('Your request')).toHaveValue('')
 expect(server.conversations.size).toBe(0)
 await page.locator('.assistant-heading').getByRole('button', {name: 'New conversation', exact: true}).click()
 await page.locator('.assistant-heading').getByRole('button', {name: 'New conversation', exact: true}).click()
 await expect(page.getByLabel('Your request')).toBeFocused()
 expect(server.conversations.size).toBe(0)
 expect(server.sends()).toBe(0)
})

test('empty state suggestions fill and focus the prompt and name the scenario they switch to', async ({authenticatedPage: page}, testInfo) => {
	await chatServer(page)
	await page.goto('/ai')
	const suggestions = page.getByRole('list', {name: 'Suggestions', exact: true})
	await expect(suggestions.getByRole('button')).toHaveCount(4)
	const request = page.getByLabel('Your request')
	await suggestions.getByRole('button', {name: 'What should I do today?', exact: true}).click()
	await expect(request).toBeFocused()
	await expect(request).toHaveValue('List my unfinished tasks and suggest a plan for today based on their priority.')
	expect(await request.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length)).toBe(true)
	await expect(page.locator('.profile-switch select')).toHaveValue('ask')
	const create = suggestions.getByRole('button', {name: /^Create a task with one sentence/})
	await expect(create.locator('.scenario-tag')).toHaveText('Scenario: Plan & review')
	await create.click()
	await expect(request).toBeFocused()
	await expect(request).toHaveValue(/^Create a task in this project/)
	await expect(page.locator('.profile-switch select')).toHaveValue('plan')
	await expect(page.locator('.composer-hint')).toContainText('Review every change')
	await page.setViewportSize({width: 320, height: 720})
	await page.reload()
	await expect(suggestions).toBeVisible()
	await page.evaluate(() => document.documentElement.classList.replace('light', 'dark'))
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.screenshot({path: testInfo.outputPath('assistant-welcome-dark-320.png'), animations: 'disabled'})
})

test('empty state without a model offers setup instead of suggestions', async ({authenticatedPage: page}) => {
	await chatServer(page)
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {connections: [], assistant: '', transcription: '', cleanup: ''}}))
	await page.goto('/ai')
	const welcome = page.locator('.welcome')
	await expect(welcome.locator('.setup-note')).toContainText('Add a connection in AI and voice settings')
	await expect(welcome.getByRole('link', {name: 'AI and voice settings', exact: true})).toHaveAttribute('href', '/user/settings/ai')
	await expect(page.locator('.setup-note')).toHaveCount(1)
	await expect(page.getByRole('list', {name: 'Suggestions', exact: true})).toHaveCount(0)
	await expect(page.getByLabel('Web search for the next message')).toHaveCount(0)
})

test('history overlay marks the open chat, closes with Escape and returns focus at 390px', async ({authenticatedPage: page}) => {
	const server = await chatServer(page)
	const chat = {id: crypto.randomUUID(), title: 'Open chat', updated: new Date().toISOString(), turns: [], compactions: []}
	server.conversations.set(chat.id, chat)
	await page.setViewportSize({width: 390, height: 844})
	await page.goto(`/ai?chat=${chat.id}`)
	const toggle = page.locator('.assistant-heading').getByRole('button', {name: 'Conversations', exact: true})
	await expect(toggle).toHaveAttribute('aria-expanded', 'false')
	await toggle.click()
	await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	await expect(page.getByRole('searchbox', {name: 'Search chats'})).toBeFocused()
	await expect(page.locator(`[data-chat-id="${chat.id}"] .history-link`)).toHaveAttribute('aria-current', 'true')
	await page.keyboard.press('Escape')
	await expect(page.locator('.chat-sidebar')).toHaveCount(0)
	await expect(toggle).toBeFocused()
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
