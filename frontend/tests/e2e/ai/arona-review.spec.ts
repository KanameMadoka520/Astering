import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

// No model runs here: a scripted conversation server holds one turn that is paused for review, and the review
// endpoint records each decision the card sends.

type Json = Record<string, unknown>

type ReviewBody = {
	turn_id: string
	operation_id: string
	decision: string
	arguments: string
	answer: string
}

type FixtureTurn = {
	id: string
	request_id: string
	prompt: string
	status: 'awaiting_approval' | 'paused' | 'completed'
	started: string
	result: {
		stage: string
		model: string
		reply: string
		pause?: 'review' | 'budget'
		pending?: Json
		budget: Json
		steps: Json[]
		actions: Json[]
	}
}

const OPERATION_ID = 'operation-delete-archive'
const DELETE_ARGS = JSON.stringify({project_id: 7, view_id: 28, bucket_id: 41})

// Shapes follow planDeleteBucket in pkg/routes/api/v2/tcy_ai_buckets.go. The snapshot describes the bucket and where
// its tasks go; the after object is the board once it is gone. Deleting a bucket never deletes its tasks.
const BEFORE = [{
	id: 41,
	title: 'Archive',
	bucket_id: 41,
	view_id: 28,
	project_id: 7,
	limit: 0,
	is_default_bucket: false,
	is_done_bucket: false,
	tasks_moved: 3,
	done_tasks_moved: 1,
	tasks_deleted: 0,
	move_to_bucket_id: 40,
	move_to_bucket_title: 'Done later',
	clears: [],
	task_done_state: 'unchanged',
	sample_tasks: [
		{id: 101, title: 'Draft FAQ', done: false},
		{id: 102, title: 'Polish release notes', done: false},
		{id: 103, title: 'Retire old mockups', done: true},
	],
	hidden_sample_tasks: 0,
}]
const AFTER = {
	deleted_bucket_id: 41,
	tasks_moved: 3,
	move_to_bucket_id: 40,
	default_bucket_id: 40,
	done_bucket_id: 0,
	tasks_deleted: 0,
}

function toolCall(id: string, name: string, args: string) {
	return {
		id,
		function: {
			name,
			arguments: args,
		},
	}
}

// A long run that has continued through many segments: the cumulative limits are far above the old 200/1000 ceiling.
function pausedTurn(): FixtureTurn {
	return {
		id: crypto.randomUUID(),
		request_id: crypto.randomUUID(),
		prompt: 'Tidy up the launch board',
		status: 'awaiting_approval',
		started: new Date().toISOString(),
		result: {
			stage: 'review',
			model: 'fixture',
			reply: '',
			pause: 'review',
			budget: {rounds: 388, round_limit: 400, operations: 36, operation_limit: 2000},
			pending: {
				id: OPERATION_ID,
				tool: 'delete_bucket',
				status: 'prepared',
				units: 1,
				project_ids: [7],
				version: 'fixture-version',
				arguments: DELETE_ARGS,
				before: JSON.stringify(BEFORE),
				after: JSON.stringify(AFTER),
			},
			steps: [{
				round: 388,
				model: 'fixture',
				streaming: true,
				duration_ms: 2100,
				text: 'The Archive bucket only holds old work; removing it keeps the board short.',
				tool_calls: [toolCall('call-388', 'delete_bucket', DELETE_ARGS)],
				usage: {reported: true, input: 52_000, output: 120},
			}],
			actions: [],
		},
	}
}

async function reviewServer(page: Page) {
	const turn = pausedTurn()
	const conversation = {
		id: crypto.randomUUID(),
		title: 'Tidy up the launch board',
		compactions: [],
		turns: [turn],
	}
	const reviews: ReviewBody[] = []
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
		const request = route.request()
		const [, id, action] = new URL(request.url()).pathname.split('/ai/conversations')[1].split('/')
		if (!id) {
			const items = [{
				id: conversation.id,
				title: conversation.title,
				turn_count: conversation.turns.length,
				running: false,
			}]
			return route.fulfill({json: {items, total: 1, total_pages: 1}})
		}
		if (id !== conversation.id) return route.fulfill({status: 404, json: {message: 'Not found'}})
		if (action === 'events') {
			const activity = {turn, compacting: false, compactions: []}
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: `event: activity\ndata: ${JSON.stringify(activity)}\n\n`,
			})
		}
		if (action === 'review' && request.method() === 'POST') {
			const body = request.postDataJSON() as ReviewBody
			reviews.push(body)
			if (body.decision === 'approve') {
				// The bucket was deleted and the run went on until this segment's round limit.
				turn.status = 'paused'
				Object.assign(turn.result, {
					stage: 'budget',
					pause: 'budget',
					pending: undefined,
					budget: {rounds: 400, round_limit: 400, operations: 37, operation_limit: 2000},
					actions: [{
						round: 388,
						tool: 'delete_bucket',
						arguments: DELETE_ARGS,
						result: JSON.stringify({deleted_bucket_id: 41, tasks_moved: 3, move_to_bucket_id: 40, tasks_deleted: 0}),
						success: true,
						duration_ms: 18,
					}],
				})
			}
			if (body.decision === 'continue') {
				turn.status = 'completed'
				Object.assign(turn.result, {
					stage: 'completed',
					pause: undefined,
					reply: 'Cleanup finished.',
					budget: {rounds: 403, round_limit: 420, operations: 37, operation_limit: 2100},
				})
			}
		}
		return route.fulfill({json: conversation})
	})
	return {conversation, turn, reviews}
}

for (const width of [1440, 390]) {
	test(`bucket deletion review shows where tasks go and a long run can still continue at ${width}px`, async ({
		authenticatedPage: page,
	}) => {
		const server = await reviewServer(page)
		await page.setViewportSize({width, height: 900})
		await page.goto(`/ai?chat=${server.conversation.id}`)
		const card = page.locator('section.agent-review')
		const impact = card.locator('section.bucket-impact')

		// The impact is visible without opening any JSON: tasks move, none are deleted.
		await expect(impact).toBeVisible()
		const moved = impact.locator('li[data-impact="tasks-moved"]')
		await expect(moved).toContainText('3')
		await expect(moved).toContainText('Done later')
		await expect(impact.locator('li[data-impact="tasks-deleted"]')).toHaveCount(1)
		// Bucket ids are not task fields: no generic task before/after table is built from them.
		await expect(card.getByRole('columnheader', {name: 'Field', exact: true})).toHaveCount(0)
		await expect(card.getByRole('cell', {name: /^(Destination project|project_id|view_id|bucket_id)$/})).toHaveCount(0)
		// The exact arguments stay available for checking.
		const exact = card.locator('details', {has: page.getByText('Show exact arguments', {exact: true})})
		await expect(exact).toHaveCount(1)
		await exact.locator('summary').click()
		await expect(exact.locator('pre')).toContainText('"bucket_id": 41')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

		await card.getByRole('button', {name: 'Approve and continue', exact: true}).click()
		// Cumulative limits of 400 rounds and 2000 operations no longer block continuing.
		const next = card.getByRole('button', {name: 'Add budget and continue', exact: true})
		await expect(card).toContainText('400/400')
		await expect(next).toBeEnabled()
		await next.click()
		await expect(page.locator('.chat-markdown')).toHaveText('Cleanup finished.')
		expect(server.reviews.map(review => review.decision)).toEqual(['approve', 'continue'])
		expect(server.reviews[0]).toMatchObject({turn_id: server.turn.id, operation_id: OPERATION_ID})
		expect(server.reviews[1]).toMatchObject({turn_id: server.turn.id, decision: 'continue'})
	})
}
