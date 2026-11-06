import type {Page} from '@playwright/test'
import type {ChatTurn, Conversation} from '../../src/client/generated'
import {apiRootUrl} from './apiUrl'

export const MOBILE_CHAT_ID = '98bb9fad-4964-49ef-8df7-c008d2c7f15c'
export const MOBILE_REPLY = 'Your plan is saved. The deadline remains **31 December 2026**.'

export async function mobileArona(page: Page, options: {
	chinese?: boolean,
	running?: boolean,
	empty?: boolean,
	dark?: boolean,
	holdConversation?: boolean,
	mcp?: boolean,
	sendRunning?: boolean,
} = {}) {
	const requests: Record<string, unknown>[] = []
	let releaseConversation = () => {}
	const conversationReady = options.holdConversation
		? new Promise<void>(resolve => { releaseConversation = resolve })
		: Promise.resolve()
	const completed: ChatTurn = {
		id: 'mobile-completed-turn',
		request_id: 'mobile-completed-request',
		prompt: 'Keep the project deadline and review my next steps.',
		status: options.running ? 'running' : 'completed',
		started: '2026-11-06T12:00:00Z',
		finished: options.running ? undefined : '2026-11-06T12:00:08Z',
		result: {
			reply: options.running ? '' : MOBILE_REPLY,
			model: 'mobile-fixture-model',
			requested_model: 'mobile-fixture-model',
			protocol: 'openai-chat',
			endpoint: 'https://fixture.invalid/v1/chat/completions',
			system_prompt: 'Synthetic mobile layout test. No external service is called.',
			stage: options.running ? 'model' : 'completed',
			duration_ms: 8330,
			budget: {rounds: 3, round_limit: 40, operations: 2, operation_limit: 100},
			usage: {input: 18541, output: 320, cached: 16384, reported: true, cache_reported: true},
			steps: [{
				round: 1,
				model: 'mobile-fixture-model',
				text: options.running ? 'Preparing a safe plan.' : MOBILE_REPLY,
				reasoning: 'Checking the supplied dates and the current project.',
				streaming: true,
				started: '2026-11-06T12:00:00Z',
				duration_ms: 8330,
				first_token_ms: 200,
				first_text_ms: 500,
				usage: {input: 18541, output: 320, reported: true},
			}],
			actions: [],
		},
	}
	let conversation: Conversation = {
		id: MOBILE_CHAT_ID,
		unread: Boolean(options.holdConversation),
		latest_reply_id: options.holdConversation ? 'mobile-completed-turn' : undefined,
		title: 'A long project conversation title that should stay on a single line',
		turns: options.empty ? [] : [completed],
		compactions: [],
		storage: {record_bytes: 86000, attachment_bytes: 0, total_bytes: 86000, attachment_count: 0},
	}
	await page.route('**/api/v2/user', async route => {
		const response = await route.fetch()
		const user = await response.json()
		await route.fulfill({json: {
			...user,
			settings: {
				...user.settings,
				language: options.chinese ? 'zh-CN' : 'en',
				frontend_settings: {...user.settings?.frontend_settings, color_schema: options.dark ? 'dark' : 'light'},
			},
		}})
	})
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: ['primary', 'secondary'].map(id => ({
			id,
			name: `${id} · An intentionally long multimodal connection name`,
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.invalid/v1',
			model: 'mobile-fixture-model',
			has_key: true,
			web_search_protocol: 'deepseek',
		})),
		assistant: 'primary',
		transcription: '',
		cleanup: '',
	}}))
	await page.route('**/api/v2/user/settings/tcy-ai/mcp', route => route.fulfill({json: {
		revision: 0,
		connections: options.mcp ? [{
			id: 'layout-mcp',
			name: 'Layout-only MCP connection',
			url: 'https://fixture.invalid/mcp',
			transport: 'streamable_http',
			preset: 'custom',
			enabled: true,
			allow_write: false,
			allow_delete: false,
			has_key: true,
		}] : [],
	}}))
	await page.route('**/api/v2/ai/conversations**', async route => {
		const request = route.request()
		const path = new URL(request.url()).pathname.split('/ai/conversations')[1]
		if (!path && request.method() === 'POST') return route.fulfill({json: conversation})
		if (!path) return route.fulfill({json: {
			items: [{...conversation, turn_count: conversation.turns?.length, running: conversation.turns?.some(turn => turn.status === 'running') ?? false}],
			total: 1,
			total_pages: 1,
		}})
		if (path.endsWith('/read')) {
			requests.push({action: 'read', ...request.postDataJSON()})
			conversation = {...conversation, unread: false}
			return route.fulfill({json: {
				id: conversation.id,
				latest_reply_id: conversation.latest_reply_id,
				unread: false,
			}})
		}
		if (request.method() === 'GET') await conversationReady
		if (path.endsWith('/events')) return route.fulfill({
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({
				turn: conversation.turns?.at(-1),
				storage: conversation.storage,
				compacting: false,
				compactions: [],
			})}\n\n`,
		})
		if (path.endsWith('/messages')) {
			const body = request.postDataJSON() as Record<string, unknown>
			requests.push(body)
			conversation = {
				...conversation,
				turns: [...(conversation.turns ?? []), {
					...completed,
					id: `sent-${requests.length}`,
					request_id: String(body.request_id),
					prompt: String(body.message),
					status: options.sendRunning ? 'running' : 'completed',
					result: {...completed.result, stage: options.sendRunning ? 'model' : 'completed'},
				}],
			}
		}
		if (path.endsWith('/steer')) {
			const body = request.postDataJSON() as Record<string, unknown>
			requests.push({action: 'steer', ...body})
			conversation = {
				...conversation,
				turns: conversation.turns?.map(turn => ({
					...turn,
					steering: [...turn.steering ?? [], {
						id: `instruction-${requests.length}`,
						request_id: String(body.request_id),
						message: String(body.message),
						status: 'pending' as const,
					}],
				})),
			}
		}
		if (path.endsWith('/stop')) {
			requests.push({action: 'stop'})
			conversation = {
				...conversation,
				turns: conversation.turns?.map(turn => ({...turn, status: 'stopped', result: {...turn.result, stage: 'stopped'}})),
			}
		}
		return route.fulfill({json: conversation})
	})
	return {requests, conversation: () => conversation, releaseConversation}
}

export function mobileChatUrl() {
	const origin = process.env.ARONA_MOBILE_BASELINE ? apiRootUrl(process.env.API_URL!) : ''
	return `${origin}/ai?chat=${MOBILE_CHAT_ID}`
}
