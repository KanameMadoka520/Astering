import type {Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

// No model runs here: the conversation server is scripted with page.route and the test changes the saved turn
// between polls, the way the backend appends rounds to one running turn.

type Json = Record<string, unknown>

type FixtureResult = {
	stage: string
	model: string
	reply: string
	duration_ms?: number
	steps: Json[]
	actions: Json[]
	usage?: Json
	budget?: Json
	context_status?: Json
	auto_compactions?: Json[]
	subagents?: Json[]
}

type FixtureTurn = {
	id: string
	request_id: string
	prompt: string
	status: 'running' | 'completed'
	started: string
	result: FixtureResult
}

type FixtureConversation = {
	id: string
	title: string
	turns: FixtureTurn[]
	compactions: unknown[]
}

function conversationWith(title: string, result: Partial<FixtureResult>): FixtureConversation {
	return {
		id: crypto.randomUUID(),
		title,
		compactions: [],
		turns: [{
			id: crypto.randomUUID(),
			request_id: crypto.randomUUID(),
			prompt: title,
			status: 'running',
			started: new Date().toISOString(),
			result: {
				stage: 'model',
				model: 'fixture',
				reply: '',
				steps: [],
				actions: [],
				...result,
			},
		}],
	}
}

async function aronaServer(page: Page, conversation: FixtureConversation) {
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'model',
			name: 'Fixture',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.example/v1',
			model: 'fixture',
			has_key: true,
		}],
		assistant: 'model',
		transcription: '',
		cleanup: '',
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {
		system_prompt: 'Fixture prompt',
		tool_schema: '[]',
	}}))
	await page.route('**/api/v2/ai/conversations**', route => {
		const [, id, action] = new URL(route.request().url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			const items = [{
				id: conversation.id,
				title: conversation.title,
				turn_count: conversation.turns.length,
				running: conversation.turns.some(turn => turn.status === 'running'),
			}]
			return route.fulfill({json: {items, total: 1, total_pages: 1}})
		}
		if (id !== conversation.id) return route.fulfill({status: 404, json: {message: 'Not found'}})
		if (action === 'events') {
			const activity = {turn: conversation.turns.at(-1), compacting: false, compactions: []}
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `event: activity\ndata: ${JSON.stringify(activity)}\n\n`,
			})
		}
		return route.fulfill({json: conversation})
	})
}

const ROUND_TEXTS = [
	'Round one: I will look up the Launch project first.',
	'Round two: reading both launch tasks.',
	'Round three: the rename was rejected, so I will summarize instead.',
]
const FINAL = 'The launch plan is ready: both tasks are on track.'

function toolCall(id: string, name: string, args: string) {
	return {
		id,
		function: {
			name,
			arguments: args,
		},
	}
}

function action(round: number, tool: string, args: string, result: string, success = true) {
	return {
		round,
		tool,
		arguments: args,
		result,
		success,
		duration_ms: 8 + round,
	}
}

function step(round: number, extra: Json) {
	return {
		round,
		model: 'fixture',
		streaming: true,
		duration_ms: 1500 + round * 100,
		usage: {
			reported: true,
			input: 1000 * round,
			output: 40,
		},
		...extra,
	}
}

// Rounds 1–3 of a running turn: interim text, provider thinking in rounds 1 and 3, two calls of the same tool in
// round 2 and a failed call in round 3. Round 3's tools are running, a stage the backend really reports.
function firstThreeRounds() {
	return {
		stage: 'execute',
		steps: [
			step(1, {
				text: ROUND_TEXTS[0],
				reasoning: 'Provider reasoning for round one.',
				tool_calls: [toolCall('call-1', 'list_projects', '{}')],
			}),
			step(2, {
				text: ROUND_TEXTS[1],
				tool_calls: [
					toolCall('call-2a', 'get_task', '{"id":11}'),
					toolCall('call-2b', 'get_task', '{"id":12}'),
				],
			}),
			step(3, {
				text: ROUND_TEXTS[2],
				reasoning: 'Provider reasoning for round three.',
				tool_calls: [toolCall('call-3', 'update_task', '{"id":12,"title":"Renamed"}')],
			}),
		],
		actions: [
			action(1, 'list_projects', '{}', '{"items":[{"id":1,"title":"Launch"}]}'),
			action(2, 'get_task', '{"id":11}', '{"id":11,"title":"Write FAQ"}'),
			action(2, 'get_task', '{"id":12}', '{"id":12,"title":"Ship release"}'),
			action(3, 'update_task', '{"id":12,"title":"Renamed"}', '{"message":"Fixture rejection"}', false),
		],
	}
}

async function expectEarlierRounds(scope: Locator) {
	for (const [index, text] of ROUND_TEXTS.entries()) {
		await expect(scope.locator(`.timeline-step[data-round="${index + 1}"] .step-reply`)).toHaveText(text)
	}
	const firstReasoning = scope.locator('.timeline-step[data-round="1"] .reasoning > summary')
	await expect(firstReasoning).toContainText('Thinking returned by the provider')
	await expect(scope.locator('.timeline-step[data-round="3"] .reasoning')).toHaveCount(1)
	await expect(scope.locator('.timeline-step .reasoning')).toHaveCount(2)
	await expect(scope.locator('.timeline-step[data-round="1"] .tool-row.is-succeeded')).toHaveCount(1)
	// Each call of a repeated tool keeps its own row and its own receipt.
	const repeated = scope.locator('.timeline-step[data-round="2"] .tool-row.is-succeeded')
	await expect(repeated).toHaveCount(2)
	await expect(repeated.nth(0)).toContainText(/\b11\b/)
	await expect(repeated.nth(1)).toContainText(/\b12\b/)
	await expect(scope.locator('.timeline-step[data-round="3"] .tool-row.is-failed')).toHaveCount(1)
}

async function expectCompleted(scope: Locator) {
	await expect(scope.locator('.chat-markdown')).toHaveText(FINAL)
	await expect(scope.locator('.chat-markdown')).toHaveCount(1)
	await expect(scope.locator('.timeline-step')).toHaveCount(4)
	await expect(scope.locator('.timeline-step.is-live')).toHaveCount(0)
	// The last round's text became the answer and is not repeated as an interim reply.
	await expect(scope.locator('.timeline-step[data-round="4"] .step-reply')).toHaveCount(0)
	await expect(scope.locator('.step-reply, .chat-markdown').filter({hasText: FINAL})).toHaveCount(1)
	await expectEarlierRounds(scope)
}

test('earlier rounds stay after later rounds, a reload and in the floating panel', async ({
	authenticatedPage: page,
}) => {
	const conversation = conversationWith('Plan the launch', firstThreeRounds())
	const turn = conversation.turns[0]
	await aronaServer(page, conversation)
	await page.setViewportSize({width: 1440, height: 900})
	await page.goto(`/ai?chat=${conversation.id}`)
	const card = page.locator('.chat-turn')
	await expect(card.locator('.timeline-step')).toHaveCount(3)
	await expect(card.locator('.timeline-step[data-round="3"]')).toHaveClass(/\bis-live\b/)
	await expectEarlierRounds(card)
	await expect(card.locator('.chat-markdown')).toHaveCount(0)

	turn.result.stage = 'model'
	turn.result.steps.push({
		round: 4,
		model: 'fixture',
		started: new Date().toISOString(),
		streaming: true,
		text: 'The launch plan is',
		output_characters: 18,
	})
	await expect(card.locator('.timeline-step[data-round="4"]')).toHaveClass(/\bis-live\b/)
	await expect(card.locator('.timeline-step[data-round="4"] .step-reply')).toContainText('The launch plan is')
	await expect(card.locator('.timeline-step.is-live')).toHaveCount(1)
	await expectEarlierRounds(card)
	await expect(card.locator('.chat-markdown')).toHaveCount(0)

	Object.assign(turn.result.steps[3], {
		text: FINAL,
		duration_ms: 2400,
		usage: {
			reported: true,
			input: 4000,
			output: 30,
		},
	})
	Object.assign(turn.result, {
		stage: 'completed',
		reply: FINAL,
		duration_ms: 9000,
	})
	turn.status = 'completed'
	await expectCompleted(card)

	await page.reload()
	await expectCompleted(card)
	const reasoning = card.locator('.timeline-step[data-round="1"] .reasoning')
	await card.locator('.timeline-step[data-round="1"] .reasoning > summary').click()
	await expect(reasoning).toContainText('Provider reasoning for round one.')
	await page.setViewportSize({width: 320, height: 800})
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

	await page.setViewportSize({width: 1440, height: 900})
	await page.goto('/user/settings/general')
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	await panel.getByRole('button', {name: 'Conversations', exact: true}).click()
	await panel.locator(`li[data-chat-id="${conversation.id}"] .history-link`).click()
	await expectCompleted(panel)
})

// Shape of a real audited run (aggregates only): nine requests whose inputs add up to 1,108,119 tokens.
const AUDIT = {
	input: [111612, 111848, 112710, 120586, 125860, 127830, 129497, 133147, 135029],
	output: [99, 22, 100, 2252, 469, 368, 1593, 463, 944],
	cached: [87071, 111609, 111845, 112707, 120583, 125857, 127827, 129494, 133144],
	reasoning: [0, 0, 24, 516, 59, 0, 23, 0, 71],
}

// The server's turn usage gains a request only once that request has returned (runtime.go), so between rounds it
// holds exactly rounds 1–9.
const AUDIT_TOTAL = {
	reported: true,
	input: 1_108_119,
	output: 6_310,
	cached: 1_060_137,
	cache_reported: true,
	reasoning: 693,
	reasoning_reported: true,
}

// Round 10's usage arrives with its last streamed chunk, while the request is still open.
const ROUND_10_USAGE = {
	reported: true,
	input: 140_000,
	output: 210,
	cached: 135_026,
	cache_reported: true,
	reasoning: 18,
	reasoning_reported: true,
}

// Capacity 0: the provider reported no context window and none is configured.
function auditSteps(): Json[] {
	return AUDIT.input.map((input, index) => ({
		round: index + 1,
		model: 'fixture',
		streaming: true,
		context_window: 0,
		duration_ms: index === 8 ? 14326 : 5000 + index * 250,
		usage: {
			reported: true,
			input,
			output: AUDIT.output[index],
			cached: AUDIT.cached[index],
			cache_reported: true,
			reasoning: AUDIT.reasoning[index],
			reasoning_reported: true,
		},
	}))
}

function contextStatus(tokens: number) {
	return {
		tokens,
		estimated: false,
		context_window: 200_000,
		threshold_tokens: 180_000,
		source: 'provider',
	}
}

test('usage keeps its scope: this request, the context in use and the turn total', async ({
	authenticatedPage: page,
}) => {
	// Between rounds: round 9 has returned and its tools run, so the server total already holds rounds 1–9.
	// Round 9 has no start time, so its elapsed time is the saved 14.33 s instead of a ticking clock.
	const conversation = conversationWith('Audit the launch', {
		stage: 'execute',
		steps: auditSteps(),
		usage: {...AUDIT_TOTAL},
		budget: {rounds: 9},
	})
	const turn = conversation.turns[0]
	await aronaServer(page, conversation)
	await page.setViewportSize({width: 1440, height: 900})
	await page.goto(`/ai?chat=${conversation.id}`)
	const live = page.locator('.run-status.live-run-panel')
	const request = live.locator('[data-scope="request"]')
	const context = live.locator('[data-scope="context"]')
	const total = live.locator('[data-scope="turn"]')
	const inflight = live.locator('[data-scope="inflight"]')

	await expect(request).toContainText('round 9')
	await expect(request).toContainText('135,029')
	await expect(request).toContainText('14.33')
	await expect(request).not.toContainText('1,108,119')
	await expect(request).not.toContainText('6,310')
	// Cache hits still occupy context; the turn's running total is not the context size.
	await expect(context).toContainText('135,029')
	await expect(context).not.toContainText('1,108,119')
	// Capacity 0 means unknown: no share is computed.
	await expect(context).not.toContainText('%')
	await expect(total).toContainText('9 requests')
	await expect(total).toContainText('1,108,119')
	await expect(total).toContainText('6,310')
	await expect(total).toContainText('693')
	await expect(total).not.toContainText('135,029')
	// Nothing streams between rounds.
	await expect(inflight).toHaveCount(0)

	// The backend's context status with a declared capacity: now a share exists, and the compaction threshold is
	// shown as a separate policy figure.
	turn.result.context_status = contextStatus(135_029)
	await expect(context).toContainText('67.5%')
	await expect(context).toContainText('200,000')
	await expect(context).toContainText('180,000')
	await expect(context).not.toContainText('1,108,119')

	// Round 10 streams. Its usage is in, but the server total still holds rounds 1–9 until the request returns.
	Object.assign(turn.result, {stage: 'model', budget: {rounds: 10}})
	turn.result.steps = [...auditSteps(), {
		round: 10,
		model: 'fixture',
		started: new Date().toISOString(),
		streaming: true,
		context_window: 0,
		text: 'All nine checks passed; writing the summary.',
		output_characters: 44,
		usage: {...ROUND_10_USAGE},
	}]
	await expect(request).toContainText('round 10')
	await expect(request).toContainText('140,000')
	await expect(inflight).toContainText('140,000')
	await expect(inflight).not.toContainText('135,029')
	await expect(inflight).not.toContainText('1,108,119')
	await expect(total).toContainText('9 requests')
	await expect(total).toContainText('1,108,119')
	await expect(total).not.toContainText('140,000')
	await expect(total).not.toContainText('1,248,119')

	// Round 10 returned and the turn finished: the server total now holds all ten requests.
	Object.assign(turn.result.steps[9], {duration_ms: 6200})
	Object.assign(turn.result, {
		stage: 'completed',
		reply: 'Audit finished.',
		duration_ms: 95_000,
		usage: {
			...AUDIT_TOTAL,
			input: 1_248_119,
			output: 6_520,
			cached: 1_195_163,
			reasoning: 711,
		},
		context_status: contextStatus(140_000),
	})
	turn.status = 'completed'
	await page.locator('.run-summary > summary').click()
	const summary = page.locator('.run-summary')
	await expect(summary.locator('[data-scope="request"]')).toContainText('round 10')
	await expect(summary.locator('[data-scope="request"]')).toContainText('140,000')
	await expect(summary.locator('[data-scope="request"]')).not.toContainText('1,248,119')
	await expect(summary.locator('[data-scope="context"]')).toContainText('70%')
	await expect(summary.locator('[data-scope="context"]')).not.toContainText('1,248,119')
	await expect(summary.locator('[data-scope="turn"]')).toContainText('10 requests')
	await expect(summary.locator('[data-scope="turn"]')).toContainText('1,248,119')
	await expect(summary.locator('[data-scope="inflight"]')).toHaveCount(0)
})

function reported(input: number, output: number) {
	return {reported: true, input, output}
}

const DELEGATE_ARGS = '{"tasks":[{"goal":"List overdue launch tasks"},{"goal":"Check the release notes for blockers"}]}'
const SCOUT_TEXT = 'Listing the overdue launch tasks.'
const SCOUT_FINDINGS = 'Two launch tasks are overdue: Write FAQ and Ship release.'
const CHECKPOINT = 'Checkpoint: Launch has two open tasks and the FAQ draft is attached.'
const SUBAGENT_ERROR = 'The release notes project could not be read.'
const RUNTIME_FINAL = 'Two tasks are overdue; the release-notes check failed and needs a retry.'

// One running turn as the backend reports it: an automatic compaction between rounds 1 and 2, then two read-only
// subagents started by round 2. result.usage only ever holds finished work, and once a compaction or subagent has
// finished its usage is part of it; the UI must itemize those figures, never add them on top.
test('automatic compactions and subagents keep their status, stay inside the turn total and survive a reload', async ({
	authenticatedPage: page,
}) => {
	const base = Date.now() - 5 * 60_000
	const at = (seconds: number) => new Date(base + seconds * 1000).toISOString()
	const listProjects = action(1, 'list_projects', '{}', '{"items":[{"id":1,"title":"Launch"}]}')
	const round1 = {
		round: 1,
		model: 'fixture',
		started: at(0),
		streaming: true,
		duration_ms: 4200,
		text: 'Reading the launch board first.',
		tool_calls: [toolCall('call-1', 'list_projects', '{}')],
		usage: reported(181_000, 300),
	}
	const round2 = {
		round: 2,
		model: 'fixture',
		started: at(40),
		streaming: true,
		duration_ms: 2100,
		text: 'Splitting the review into two read-only subtasks.',
		tool_calls: [toolCall('call-2', 'delegate_tasks', DELEGATE_ARGS)],
		usage: reported(26_000, 180),
	}
	const round3 = {
		round: 3,
		model: 'fixture',
		started: at(110),
		streaming: true,
		duration_ms: 3000,
		text: RUNTIME_FINAL,
		usage: reported(31_000, 420),
	}
	const listTasks = action(1, 'list_tasks', '{"project_id":1,"overdue":true}', '{"items":[{"id":11,"title":"Write FAQ"},{"id":12,"title":"Ship release"}]}')
	const scoutRound1 = {
		round: 1,
		model: 'fixture',
		started: at(46),
		streaming: true,
		duration_ms: 3000,
		text: SCOUT_TEXT,
		tool_calls: [toolCall('scout-1', 'list_tasks', '{"project_id":1,"overdue":true}')],
		usage: reported(8_000, 200),
	}
	const scoutRound2 = {
		round: 2,
		model: 'fixture',
		started: at(52),
		streaming: true,
		duration_ms: 2500,
		text: SCOUT_FINDINGS,
		usage: reported(10_400, 450),
	}
	const checkerRound1 = {
		round: 1,
		model: 'fixture',
		started: at(47),
		streaming: true,
		text: 'Opening the release notes.',
		tool_calls: [toolCall('checker-1', 'get_project', '{"id":9}')],
	}
	const scout = {
		id: 'subagent-scout',
		goal: 'List overdue launch tasks',
		model: 'fixture',
		started: at(45),
	}
	const checker = {
		id: 'subagent-checker',
		goal: 'Check the release notes for blockers',
		model: 'fixture',
		started: at(45),
	}

	const conversation = conversationWith('Review the launch', {
		stage: 'compacting',
		steps: [round1],
		actions: [listProjects],
		usage: reported(181_000, 300),
		auto_compactions: [{
			id: 'compaction-1',
			status: 'running',
			started: at(20),
			before_tokens: 182_000,
			progress: {batch: 1, batches: 2, attempt: 1, started: at(20)},
		}],
	})
	const turn = conversation.turns[0]
	await aronaServer(page, conversation)
	await page.setViewportSize({width: 1440, height: 900})
	await page.goto(`/ai?chat=${conversation.id}`)
	const card = page.locator('.chat-turn')
	const live = page.locator('.run-status.live-run-panel')
	const total = live.locator('[data-scope="turn"]')
	const marker = card.locator('.timeline-marker.is-compaction')
	const rows = card.locator('details.subagent-row')
	const done = card.locator('details.subagent-row[data-status="completed"]')
	const failed = card.locator('details.subagent-row[data-status="failed"]')

	await expect(marker).toHaveAttribute('data-status', 'running')
	await expect(marker).toContainText('182,000')
	// No "after" figure exists until the checkpoint is done.
	await expect(marker).not.toContainText('24,000')
	await expect(total).toContainText('181,000')

	// The checkpoint finished (its usage is now in the server total) and round 2 started two subagents.
	Object.assign(turn.result, {
		stage: 'execute',
		steps: [round1, round2],
		usage: reported(383_000, 2_880),
		auto_compactions: [{
			id: 'compaction-1',
			status: 'completed',
			started: at(20),
			before_tokens: 182_000,
			after_tokens: 24_000,
			attachment_count: 2,
			summary: CHECKPOINT,
			usage: reported(176_000, 2_400),
			duration_ms: 15_500,
		}],
		subagents: [
			// The scout's first request returned and its tool ran; the checker's first request still streams.
			{...scout, status: 'running', stage: 'execute', steps: [scoutRound1], actions: [listTasks], usage: reported(8_000, 200)},
			{...checker, status: 'running', stage: 'model', steps: [checkerRound1], actions: [], usage: {reported: false, input: 0, output: 0}},
		],
	})
	await expect(marker).toHaveAttribute('data-status', 'completed')
	await expect(marker).toContainText('24,000')
	await expect(marker).toContainText('2 attachment references kept')
	await expect(rows).toHaveCount(2)
	await expect(card.locator('details.subagent-row[data-status="running"]')).toHaveCount(2)
	await expect(live.locator('[data-scope="subagents"]')).toContainText('2 running')
	await expect(total).toContainText('Input 383,000')
	// Running subagents only report provisionally, apart from the total.
	await expect(live.locator('[data-scope="inflight"]')).toContainText('8,000')

	// Both subagents ended: one with findings, one failed. The server added each one's usage to the turn once.
	Object.assign(turn.result, {
		actions: [listProjects, action(2, 'delegate_tasks', DELEGATE_ARGS, '{"completed":1,"failed":1}')],
		usage: reported(408_600, 3_620),
		subagents: [
			{
				...scout,
				status: 'completed',
				steps: [scoutRound1, scoutRound2],
				actions: [listTasks],
				reply: SCOUT_FINDINGS,
				usage: reported(18_400, 650),
				duration_ms: 9_000,
			},
			{
				...checker,
				status: 'failed',
				steps: [{...checkerRound1, duration_ms: 1800, usage: reported(7_200, 90)}],
				actions: [action(1, 'get_project', '{"id":9}', '{"message":"Project 9 not found"}', false)],
				error: SUBAGENT_ERROR,
				usage: reported(7_200, 90),
				duration_ms: 2_400,
			},
		],
	})
	await expect(done).toHaveCount(1)
	await expect(failed).toHaveCount(1)
	await expect(failed.locator(':scope > summary')).toContainText('Failed')
	await expect(failed.locator(':scope > summary')).not.toContainText('Completed')
	const subagentStatus = live.locator('[data-scope="subagents"]')
	await expect(subagentStatus).toContainText('1 completed')
	await expect(subagentStatus).toContainText('1 failed')
	// Exactly the server's total: 408,600 already holds the compaction (176,000) and both subagents (25,600).
	await expect(total).toContainText('Input 408,600')
	await expect(total).not.toContainText('610,200')
	await expect(live.locator('[data-scope="inflight"]')).toHaveCount(0)
	await done.locator(':scope > summary').click()
	await expect(done.locator('.timeline-step[data-round="1"] .step-reply')).toHaveText(SCOUT_TEXT)
	await expect(done.locator('.timeline-step[data-round="1"] .tool-row.is-succeeded')).toHaveCount(1)
	await expect(done.locator('.timeline-step[data-round="2"]')).toHaveCount(1)
	await expect(done.locator('.subagent-reply')).toHaveText(SCOUT_FINDINGS)

	Object.assign(turn.result, {
		stage: 'completed',
		steps: [round1, round2, round3],
		reply: RUNTIME_FINAL,
		usage: reported(439_600, 4_040),
		duration_ms: 125_000,
	})
	turn.status = 'completed'
	await expect(card.locator('.chat-markdown')).toHaveText(RUNTIME_FINAL)
	await expect(live).toHaveCount(0)
	await page.locator('.run-summary > summary').click()
	const summary = page.locator('.run-summary')
	await expect(summary.locator('[data-scope="turn"]')).toContainText('Input 439,600')
	await expect(summary.locator('[data-scope="turn"]')).not.toContainText('641,200')
	await expect(summary.locator('[data-scope="subagents"]')).toContainText('1 failed')

	// Everything is saved with the turn: after a reload the records can still be opened.
	await page.reload()
	await expect(card.locator('.chat-markdown')).toHaveText(RUNTIME_FINAL)
	await expect(marker).toHaveCount(1)
	await expect(marker).toHaveAttribute('data-status', 'completed')
	await marker.locator('summary').click()
	await expect(marker.locator('.compaction-summary')).toContainText(CHECKPOINT)
	await expect(rows).toHaveCount(2)
	await done.locator(':scope > summary').click()
	await expect(done.locator('.timeline-step[data-round="1"] .step-reply')).toHaveText(SCOUT_TEXT)
	await expect(done.locator('.subagent-reply')).toHaveText(SCOUT_FINDINGS)
	await failed.locator(':scope > summary').click()
	await expect(failed.locator('.subagent-error')).toContainText(SUBAGENT_ERROR)
	await expect(failed.locator('.subagent-reply')).toHaveCount(0)
	await expect(failed.locator(':scope > summary')).not.toContainText('Completed')
})
