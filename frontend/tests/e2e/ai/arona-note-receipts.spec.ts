import type {Page} from '@playwright/test'
import type {ChatTurn, Conversation} from '../../../src/client/generated'
import type {Note} from '../../../src/client/queries/notes'
import {test, expect} from '../../support/fixtures'

type PreparedWrite = {
	tool: 'create_note' | 'update_note' | 'delete_note'
	args: Record<string, unknown>
	before?: object
	commit: () => Promise<object>
}
const metadata = (note: Note) => { const {content: _content, ...summary} = note; return summary }

// The model transport is scripted; approval commits through the real owner-isolated Notes API.
// Backend execution/permission enforcement is separately covered by the actual agent web tests.
async function noteAssistant(page: Page, prepare: () => Promise<PreparedWrite>) {
	const conversations = new Map<string, Conversation>()
	const prepared = new Map<string, PreparedWrite>()
	const sent: Record<string, unknown>[] = []
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {revision: 0, default_profile: 'ask', profiles: []}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{id: 'fixture', name: 'Fixture', kind: 'chat', protocol: 'openai-chat', base_url: 'https://fixture.invalid/v1', model: 'fixture', has_key: true}],
		assistant: 'fixture',
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {system_prompt: 'Fixture', tool_schema: '[]'}}))
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const [, id, action] = new URL(request.url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			if (request.method() === 'GET') return route.fulfill({json: {items: [...conversations.values()].map(item => ({id: item.id, title: item.title, turn_count: item.turns?.length ?? 0, running: false})), total: conversations.size, total_pages: 1}})
			const created: Conversation = {id: crypto.randomUUID(), title: '', turns: [], compactions: []}
			conversations.set(created.id!, created)
			return route.fulfill({status: 201, json: created})
		}
		const conversation = conversations.get(id)
		if (!conversation) return route.fulfill({status: 404, json: {message: 'Not found'}})
		if (action === 'events') return route.fulfill({contentType: 'text/event-stream', body: `event: activity\ndata: ${JSON.stringify({turn: conversation.turns?.at(-1), compacting: false, compactions: []})}\n\n`})
		if (action === 'messages' && request.method() === 'POST') {
			const body = request.postDataJSON()
			sent.push(body)
			const enabled = body.tool_modules?.notes === 'write'
			const write = enabled ? await prepare() : undefined
			const turn: ChatTurn = {
				id: crypto.randomUUID(), request_id: body.request_id, prompt: body.message,
				status: enabled ? 'awaiting_approval' : 'completed',
				result: write ? {
					stage: 'review', pause: 'review', actions: [], steps: [],
					pending: {id: crypto.randomUUID(), tool: write.tool, units: 1, arguments: JSON.stringify(write.args), before: JSON.stringify(write.before ? [write.before] : null)},
				} : {stage: 'completed', reply: 'Notes tools stayed off', actions: [], steps: []},
			}
			if (write) prepared.set(turn.id!, write)
			conversation.turns!.push(turn)
			return route.fulfill({status: 201, json: conversation})
		}
		if (action === 'review' && request.method() === 'POST') {
			const body = request.postDataJSON()
			const turn = conversation.turns!.find(turn => turn.id === body.turn_id)!
			const write = prepared.get(turn.id!)!
			expect(body.operation_id).toBe(turn.result!.pending!.id)
			expect(body.decision).toBe('approve')
			const result = await write.commit()
			Object.assign(turn, {status: 'completed', result: {stage: 'completed', reply: 'Notes fixture complete', steps: [], actions: [{round: 1, tool: write.tool, arguments: JSON.stringify(write.args), result: JSON.stringify(result), success: true}]}})
			return route.fulfill({json: conversation})
		}
		return route.fulfill({json: conversation})
	})
	return sent
}

async function openAssistant(page: Page, enable: boolean, allowDelete = false) {
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	await panel.locator('.configuration-toggle').click()
	const configuration = page.getByRole('dialog', {name: 'Chat configuration', exact: true})
	await configuration.getByRole('button', {name: 'Tool capabilities', exact: true}).click()
	const picker = page.locator('.tool-module-picker')
	const notes = picker.getByRole('combobox', {name: 'Personal notes', exact: true})
	await expect(notes).toHaveValue('off')
	if (enable) await notes.selectOption('write')
	await expect(picker.getByRole('combobox', {name: 'Projects and tasks', exact: true})).toHaveValue('read')
	await expect(picker.getByRole('combobox', {name: 'Compass', exact: true})).toHaveValue('off')
	await page.keyboard.press('Escape')
	if (allowDelete) {
		await configuration.getByRole('button', {name: 'Permissions and execution', exact: true}).click()
		const preferences = page.getByRole('dialog', {name: 'Scenarios & preferences'})
		await preferences.getByLabel('Allow task or personal note deletion for this request', {exact: true}).check()
		await preferences.getByRole('button', {name: 'Use for upcoming messages', exact: true}).click()
	}
	await configuration.getByRole('button', {name: 'Back to chat', exact: true}).click()
	await panel.getByLabel('Your request', {exact: true}).fill('Apply the prepared note change')
	await panel.getByRole('button', {name: 'Send request', exact: true}).click()
	return panel
}

for (const width of [1440, 390]) {
	test(`reviewed Notes receipt refreshes the library without unrelated tasks or document reload at ${width}px`, async ({authenticatedPage: page, apiContext, userToken}, info) => {
		await page.setViewportSize({width, height: 900})
		const headers = {Authorization: `Bearer ${userToken}`}
		const sent = await noteAssistant(page, async () => ({
			tool: 'create_note', args: {title: 'Saved by Arona', content: 'A reviewed article.'},
			commit: async () => {
				const response = await apiContext.post('/api/v2/notes', {headers, data: {title: 'Saved by Arona', content: 'A reviewed article.', pinned: false}})
				expect(response.ok()).toBe(true)
				const note = await response.json()
				return {note_id: note.id, note: metadata(note), success: true}
			},
		}))
		await page.goto('/notes')
		const library = page.getByRole('complementary', {name: 'Personal notes library', exact: true})
		await expect(library.getByText('No notes yet. Start writing, or create one to record your thoughts.', {exact: true})).toBeVisible()
		await page.evaluate(() => {document.documentElement.dataset.notesDocument = 'kept'})
		const taskReads: string[] = []
		page.on('request', request => {
			if (request.method() === 'GET' && /\/api\/v2\/tasks(?:\/|$)/.test(new URL(request.url()).pathname)) taskReads.push(request.url())
		})
		const panel = await openAssistant(page, true)
		await expect(panel.locator('.agent-review .review-note')).toContainText('Saved by Arona')
		await page.screenshot({path: info.outputPath(`notes-write-review-${width}.png`), animations: 'disabled'})
		await panel.locator('.agent-review').getByRole('button', {name: 'Approve and continue', exact: true}).click()
		await expect(panel.getByText('Notes fixture complete', {exact: true})).toBeVisible()
		await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
		await expect(page.locator('.notes-library__list .note-row strong')).toContainText('Saved by Arona')
		await expect(library.getByRole('link', {name: /Saved by Arona/})).toBeVisible()
		expect(sent[0]).toMatchObject({mode: 'write', tool_modules: {project_tasks: 'read', compass: 'off', notes: 'write'}})
		expect(taskReads).toEqual([])
		expect(await page.locator('html').getAttribute('data-notes-document')).toBe('kept')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({path: info.outputPath(`notes-receipt-${width}.png`), animations: 'disabled'})
		await page.reload()
		await expect(page.locator('.notes-library__list .note-row strong')).toContainText('Saved by Arona')
		await expect(library.getByRole('link', {name: /Saved by Arona/})).toBeVisible()
	})
}

test('Notes remain off in a new draft and the actual prompt catalogue excludes their tools', async ({authenticatedPage: page, apiContext, userToken}) => {
	let commits = 0
	const sent = await noteAssistant(page, async () => {commits++; throw new Error('Disabled tools must not be prepared')})
	await page.goto('/notes')
	const panel = await openAssistant(page, false)
	await expect(panel.getByText('Notes tools stayed off', {exact: true})).toBeVisible()
	expect(sent[0]).toMatchObject({mode: 'read', tool_modules: {notes: 'off'}})
	expect(commits).toBe(0)
	const prompt = await apiContext.get('/api/v2/ai/prompt?mode=write&notes=off&project_tasks=off&compass=off', {headers: {Authorization: `Bearer ${userToken}`}})
	expect(prompt.ok()).toBe(true)
	const diagnostic = await prompt.json()
	const catalogue = `${diagnostic.system_prompt}\n${diagnostic.tool_schema}`
	for (const tool of ['list_notes', 'get_note', 'list_note_segments', 'create_note', 'update_note', 'delete_note']) expect(catalogue).not.toContain(tool)
})

for (const {deletion, dirty} of [{deletion: false, dirty: true}, {deletion: true, dirty: true}, {deletion: true, dirty: false}]) {
	test(`Arona ${deletion ? 'deletion' : 'update'} ${dirty ? 'preserves an unsaved article' : 'removes a clean editor'}`, async ({authenticatedPage: page, apiContext, userToken}, info) => {
		await page.setViewportSize({width: 390, height: 900})
		const headers = {Authorization: `Bearer ${userToken}`}
		const response = await apiContext.post('/api/v2/notes', {headers, data: {title: 'Open article', content: 'Saved original', pinned: false}})
		expect(response.ok()).toBe(true)
		const original: Note = await response.json()
		await noteAssistant(page, async () => ({
			tool: deletion ? 'delete_note' : 'update_note',
			args: {id: original.id, expected_revision: original.revision, ...(deletion ? {} : {content: 'Server article'})},
			before: metadata(original),
			commit: async () => {
				if (deletion) {
					const removed = await apiContext.delete(`/api/v2/notes/${original.id}`, {headers})
					expect(removed.status()).toBe(204)
					return {note_id: original.id, revision: original.revision, deleted: true, success: true}
				}
				const updated = await apiContext.put(`/api/v2/notes/${original.id}`, {headers, data: {title: original.title, content: 'Server article', pinned: false, expected_revision: original.revision}})
				expect(updated.ok()).toBe(true)
				return {note_id: original.id, note: metadata(await updated.json()), success: true}
			},
		}))
		await page.route(`**/api/v2/notes/${original.id}`, route => route.request().method() === 'PUT'
			? route.fulfill({status: 503, json: {status: 503, detail: 'Fixture save is offline'}}) : route.fallback())
		await page.goto(`/notes/${original.id}`)
		const body = page.getByRole('textbox', {name: 'Article in Markdown', exact: true})
		await expect(body).toHaveValue('Saved original')
		if (dirty) {
			await body.fill('My unsaved draft must survive')
			await page.locator('.note-editor__actions').getByRole('button', {name: 'Save', exact: true}).click()
			await expect(page.locator('.note-editor__status')).toHaveText('Not saved')
		}
		const panel = await openAssistant(page, true, deletion)
		await expect(panel.locator('.agent-review .review-note')).toContainText(`#${original.id}`)
		await panel.locator('.agent-review').getByRole('button', {name: 'Approve and continue', exact: true}).click()
		await expect(panel.getByText('Notes fixture complete', {exact: true})).toBeVisible()
		await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
		if (dirty) await expect(body).toHaveValue('My unsaved draft must survive')
		const actual = await apiContext.get(`/api/v2/notes/${original.id}`, {headers})
		if (deletion) {
			expect(actual.status()).toBe(404)
			if (dirty) {
				await expect(body).toHaveAttribute('readonly', '')
				await expect(page.getByText('Note deleted · draft kept in this tab', {exact: true})).toBeVisible()
				const download = page.waitForEvent('download')
				await page.getByRole('button', {name: 'Export Markdown', exact: true}).click()
				expect((await download).suggestedFilename()).toMatch(/\.md$/)
			} else await expect(page.locator('.note-editor')).toHaveCount(0)
			await expect(page.locator('.note-editor__actions')).toHaveCount(0)
			await expect(page.locator('.live-voice')).toHaveCount(0)
		} else {
			await expect(page.getByText('Newer version available', {exact: true})).toBeVisible()
			expect(await actual.json()).toMatchObject({content: 'Server article', revision: original.revision + 1})
		}
		await page.screenshot({path: info.outputPath(`notes-draft-${deletion ? 'deleted' : 'conflict'}-${dirty ? 'dirty' : 'clean'}.png`), animations: 'disabled'})
	})
}
