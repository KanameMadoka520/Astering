import type {
	CDPSession,
	Locator,
	Page,
	WebSocketRoute,
} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

const CHAT_ID = '2b8d6024-4d76-4a20-8e55-b077b16dd63b'
const OTHER_CHAT_ID = '72bd4a08-8137-4d25-bdd2-a476dd96ce85'
const TRANSCRIPT = 'Voice fixture: review the plan tomorrow.'
const CLEANED_TRANSCRIPT = 'Review the project plan tomorrow.'
type MicrophoneFixture = {
	mode: 'normal' | 'pending' | 'denied' | 'busy' | 'missing'
	requests: number
	tracks: MediaStreamTrack[]
	contexts: AudioContext[]
	events: Record<string, unknown>[]
	release?: () => void
}
type FixtureWindow = Window & {voiceFixture: MicrophoneFixture}


test.afterEach(async ({page}, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return
	const diagnostic = await page.evaluate(() => {
		const fixture = (window as unknown as FixtureWindow).voiceFixture
		return fixture ? {
			requests: fixture.requests,
			tracks: fixture.tracks.map(track => track.readyState),
			contexts: fixture.contexts.map(context => ({state: context.state, time: context.currentTime})),
			events: fixture.events,
		} : {fixtureUnavailable: true}
	}).catch(() => ({pageUnavailable: true}))
	await testInfo.attach('voice-pointer-diagnostic', {
		body: Buffer.from(JSON.stringify(diagnostic, null, 2)),
		contentType: 'application/json',
	})
})

// Audio is generated locally; the real recording hook and MediaRecorder encode real browser tracks.
// No permission prompt, microphone hardware or external recognition provider is involved.
async function microphone(page: Page, mode: MicrophoneFixture['mode'] = 'normal') {
	await page.addInitScript(initialMode => {
		const state: MicrophoneFixture = {
			mode: initialMode,
			requests: 0,
			tracks: [],
			contexts: [],
			events: [],
		}
		;(window as unknown as FixtureWindow).voiceFixture = state
		for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'click']) {
			window.addEventListener(name, event => {
				const pointer = event as PointerEvent
				const target = event.target instanceof Element ? event.target : undefined
				state.events.push({
					type: event.type,
					time: performance.now(),
					target: target?.tagName,
					className: target?.getAttribute('class'),
					detail: pointer.detail,
					isPrimary: pointer.isPrimary,
					pointerType: pointer.pointerType,
					x: pointer.clientX,
					y: pointer.clientY,
				})
				if (state.events.length > 100) state.events.shift()
			}, true)
		}
		Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => {
			state.requests++
			if (state.mode === 'denied') throw new DOMException('Fixture permission rejection', 'NotAllowedError')
			if (state.mode === 'busy') throw new DOMException('Fixture device busy', 'NotReadableError')
			if (state.mode === 'missing') throw new DOMException('Fixture device absent', 'NotFoundError')
			if (state.mode === 'pending') await new Promise<void>(resolve => { state.release = resolve })
			const context = new AudioContext()
			const oscillator = context.createOscillator()
			const output = context.createMediaStreamDestination()
			oscillator.connect(output)
			oscillator.start()
			state.contexts.push(context)
			for (const track of output.stream.getTracks()) {
				state.tracks.push(track)
				const stop = track.stop.bind(track)
				track.stop = () => {
					stop()
					void context.close()
				}
			}
			return output.stream
		}})
	}, mode)
}

type ServerOptions = {
	configured?: boolean,
	running?: boolean,
	chinese?: boolean,
	protocol?: 'openai-transcription' | 'dashscope-asr' | 'qwen-asr-realtime',
	cleanup?: boolean,
}

async function server(page: Page, options: ServerOptions = {}) {
	const requests: {filename: string, audio: string, cleanup: boolean}[] = []
	const writes: string[] = []
	const cleanupRequests: {text: string}[] = []
	const sentMessages: {message: string}[] = []
	const protocol = options.protocol ?? 'openai-transcription'
	await page.route('**/api/v2/user', async route => {
		const response = await route.fetch()
		const body = await response.json()
		await route.fulfill({json: {...body, settings: {...body.settings, language: options.chinese ? 'zh-CN' : 'en'}}})
	})
	await page.route('**/api/v2/ai/settings', route => route.fulfill({json: {
		connections: [{
			id: 'chat',
			name: 'Chat fixture',
			kind: 'chat',
			protocol: 'openai-chat',
			base_url: 'https://fixture.invalid/v1',
			model: 'fixture',
			has_key: true,
		}, {
			id: 'speech',
			name: 'Speech fixture',
			kind: 'transcription',
			protocol,
			base_url: protocol === 'openai-transcription'
				? 'https://fixture.invalid/v1'
				: 'https://speech.invalid/api-ws/v1/inference',
			model: protocol === 'openai-transcription' ? 'whisper-1' : 'live-speech-fixture',
			has_key: true,
		}],
		assistant: 'chat',
		transcription: options.configured === false ? '' : 'speech',
		cleanup: options.cleanup === false ? '' : 'chat',
	}}))
	await page.route('**/api/v2/ai/preferences', route => route.fulfill({json: {
		revision: 0,
		default_profile: 'ask',
		profiles: [],
	}}))
	await page.route('**/api/v2/ai/prompt?*', route => route.fulfill({json: {
		system_prompt: 'Fixture prompt',
		tool_schema: '[]',
	}}))
	await page.route('**/api/v2/ai/transcribe', async route => {
		requests.push(route.request().postDataJSON())
		await route.fulfill({json: {text: TRANSCRIPT, original: TRANSCRIPT}})
	})
	await page.route('**/api/v2/ai/cleanup', async route => {
		cleanupRequests.push(route.request().postDataJSON())
		await route.fulfill({json: {text: TRANSCRIPT, original: TRANSCRIPT}})
	})
	const turns = options.running ? [{
		id: 'running-fixture',
		request_id: 'running-request',
		prompt: 'Existing background work',
		status: 'running',
		started: new Date().toISOString(),
		result: {stage: 'model', model: 'fixture', reply: '', steps: [], actions: []},
	}] : []
	const conversation = {id: CHAT_ID, title: 'Voice input fixture', turns, compactions: []}
	await page.route('**/api/v2/ai/conversations**', route => {
		const request = route.request()
		const path = new URL(request.url()).pathname
		if (request.method() === 'POST' && path.endsWith('/messages')) {
			writes.push(path)
			const message = request.postDataJSON()
			sentMessages.push(message)
			return route.fulfill({json: {
				...conversation,
				turns: [{
					id: 'sent-fixture',
					request_id: message.request_id,
					prompt: message.message,
					status: 'completed',
					result: {
						reply: 'Fixture accepted.',
						steps: [],
						actions: [],
					},
				}],
			}})
		}
		if (request.method() !== 'GET') {
			writes.push(path)
			return route.fulfill({status: 400, json: {message: 'Unexpected conversation write'}})
		}
		const suffix = new URL(request.url()).pathname.split('/ai/conversations')[1]
		if (!suffix) return route.fulfill({json: {
			items: [{
				id: CHAT_ID,
				title: conversation.title,
				turn_count: turns.length,
				running: Boolean(options.running),
			}, {
				id: OTHER_CHAT_ID,
				title: 'Another voice conversation',
				turn_count: 0,
			}],
			total: 2,
			total_pages: 1,
		}})
		if (suffix.endsWith('/events')) return route.fulfill({
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({turn: turns.at(-1), compacting: false, compactions: []})}\n\n`,
		})
		return route.fulfill({json: path.includes(OTHER_CHAT_ID)
			? {...conversation, id: OTHER_CHAT_ID, title: 'Another voice conversation', turns: []}
			: conversation})
	})
	return {
		requests,
		writes,
		cleanupRequests,
		sentMessages,
	}
}

async function open(page: Page) {
	await page.goto(`/ai?chat=${CHAT_ID}`)
	await expect(page.locator('.speech-input-control__mic')).toBeVisible()
	await expect(page.locator('.speech-input-control__mic')).not.toHaveAttribute('aria-disabled', 'true')
}

async function released(page: Page, requestCount = 1) {
	await expect.poll(() => page.evaluate(() => {
		const fixture = (window as unknown as FixtureWindow).voiceFixture
		return fixture.tracks.length >= 1 && fixture.tracks.every(track => track.readyState === 'ended')
	})).toBe(true)
	expect(await page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.requests)).toBe(requestCount)
}

async function captureReady(page: Page) {
	await expect.poll(() => page.evaluate(() => {
		const fixture = (window as unknown as FixtureWindow).voiceFixture
		return fixture.tracks.some(track => track.readyState === 'live')
	})).toBe(true)
	// A real encoder needs an audio frame; this waits on the audio clock, not a guessed network delay.
	await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.contexts.at(-1)?.currentTime ?? 0)).toBeGreaterThan(.1)
}

async function point(locator: Locator) {
	// CDP coordinates lack locator actionability; wait for visibility and stable layout without clicking.
	await locator.click({trial: true})
	const bounds = await locator.boundingBox()
	expect(bounds).not.toBeNull()
	const position = {x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2, id: 1}
	await locator.evaluate((element, location) => {
		const target = document.elementFromPoint(location.x, location.y)
		;(window as unknown as FixtureWindow).voiceFixture.events.push({
			type: 'coordinate-hit-test',
			time: performance.now(),
			...location,
			hitsTrigger: target === element || Boolean(target && element.contains(target)),
			target: target?.tagName,
			className: target?.getAttribute('class'),
		})
	}, position)
	return position
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: {x: number, y: number, id: number}[]) {
	await cdp.send('Input.dispatchTouchEvent', {type, touchPoints: points})
}

function barrier() {
	let release!: () => void
	const promise = new Promise<void>(resolve => { release = resolve })
	return {
		promise,
		release,
	}
}

async function delayedCleanup(page: Page, options: {
	fail?: boolean,
	text?: string,
} = {}) {
	const ready = barrier()
	const state = {
		received: false,
		settled: false,
		requests: [] as {text: string}[],
		release: ready.release,
	}
	await page.route('**/api/v2/ai/cleanup', async route => {
		state.received = true
		state.requests.push(route.request().postDataJSON())
		await ready.promise
		await route.fulfill(options.fail ? {
			status: 502,
			json: {message: 'Fixture cleanup provider unavailable'},
		} : {json: {
			text: options.text ?? CLEANED_TRANSCRIPT,
			original: TRANSCRIPT,
		}})
		state.settled = true
	})
	return state
}

async function uploadAudio(page: Page) {
	await page.getByRole('button', {name: 'Voice options', exact: true}).click()
	const chooser = page.waitForEvent('filechooser')
	await page.getByRole('button', {name: 'Upload audio', exact: true}).click()
	await (await chooser).setFiles({
		name: 'fixture.wav',
		mimeType: 'audio/wav',
		buffer: wav(),
	})
}

async function selectOtherConversation(page: Page) {
	const target = page.locator(`[data-chat-id="${OTHER_CHAT_ID}"] .history-link`)
	if (!await target.isVisible()) {
		await page.getByRole('button', {name: 'Conversations', exact: true}).click()
	}
	await target.click()
	await expect(page).toHaveURL(new RegExp(`chat=${OTHER_CHAT_ID}`))
	await expect(page.locator('.composer textarea')).toBeVisible()
}

async function expandDetails(details: Locator) {
	await expect(details).toBeVisible()
	if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) {
		await details.locator('summary').click()
	}
}

async function liveServer(page: Page) {
	const endpoint = 'wss://speech.invalid/api-ws/v1/inference'
	const requestID = 'short-live-speech-fixture'
	const state = {
		wire: undefined as WebSocketRoute | undefined,
		commands: [] as {
			action: string,
			connection_id?: string,
			token?: string,
		}[],
		pcmBytes: 0,
		closed: false,
		connections: 0,
	}
	function send(event: Record<string, unknown>) {
		expect(state.wire).toBeDefined()
		state.wire!.send(JSON.stringify(event))
	}
	await page.routeWebSocket('**/api/v2/ai/speech/live', wire => {
		state.wire = wire
		state.connections++
		wire.onClose(() => { state.closed = true })
		wire.onMessage(message => {
			if (typeof message !== 'string') {
				state.pcmBytes += message.byteLength
				return
			}
			const command = JSON.parse(message)
			state.commands.push(command)
			if (command.action !== 'start') return
			expect(command.connection_id).toBe('speech')
			expect(command.token).toEqual(expect.any(String))
			expect(new URL(wire.url()).search).toBe('')
			send({
				type: 'ready',
				sample_rate: 16000,
				model: 'live-speech-fixture',
				endpoint,
				max_seconds: 180,
				request_id: requestID,
			})
		})
	})
	return {
		state,
		endpoint,
		transcript: (id: string, text: string, final = false) => send({
			type: 'transcript',
			id,
			text,
			final,
		}),
		done: (text = TRANSCRIPT) => send({
			type: 'done',
			text,
			elapsed_ms: 2300,
			first_text_ms: 140,
			audio_duration_ms: Math.round(state.pcmBytes / 32),
			finish_ms: 180,
			request_id: requestID,
		}),
	}
}

for (const chinese of [false, true]) {
	test(`desktop direct recording appends without sending (${chinese ? 'zh-CN' : 'en'})`, async ({authenticatedPage: page}, testInfo) => {
		await microphone(page)
		const state = await server(page, {chinese})
		await open(page)
		await expect(page.locator('.speech-input-control__mic')).toHaveAccessibleName(chinese ? '开始语音输入' : 'Start voice input')
		const prompt = page.locator('.composer textarea')
		await prompt.fill('Existing draft')
		await page.locator('.speech-input-control__mic').click()
		await captureReady(page)
		await expect(page.locator('.speech-input-control__state')).toBeVisible()
		await page.screenshot({path: testInfo.outputPath('desktop-recording.png'), animations: 'disabled'})
		await page.locator('.speech-input-control__mic').click()
		await expect(prompt).toHaveValue(`Existing draft\n${TRANSCRIPT}`)
		await released(page)
		expect(state.requests).toHaveLength(1)
		expect(state.requests[0].cleanup).toBe(false)
		expect(Buffer.from(state.requests[0].audio, 'base64').byteLength).toBeGreaterThan(0)
		expect(state.writes).toEqual([])
	})
}

test('Space starts, Enter stops, and Escape cancels only the floating microphone', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page, {running: true})
	await open(page)
	await page.goto('/')
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	const trigger = panel.locator('.speech-input-control__mic')
	await expect(trigger).toBeVisible()
	await expect(panel.getByText('Existing background work', {exact: true})).toBeVisible()
	await trigger.focus()
	await page.keyboard.press('Space')
	await captureReady(page)
	await page.keyboard.press('Enter')
	await expect(panel.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
	await released(page)
	await trigger.focus()
	await page.keyboard.press('Enter')
	await captureReady(page)
	await page.keyboard.press('Escape')
	await expect(panel).toBeVisible()
	await released(page, 2)
	expect(state.requests).toHaveLength(1)
	await trigger.click()
	await captureReady(page)
	await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
	await expect(panel).toBeHidden()
	await released(page, 3)
	expect(state.writes).toEqual([])
})

test('audio upload remains in voice options and respects the cleanup choice', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	await open(page)
	await page.getByRole('button', {name: 'Voice options', exact: true}).click()
	await page.locator('.speech-input-menu input[type=checkbox]').uncheck()
	const chooser = page.waitForEvent('filechooser')
	await page.getByRole('button', {name: 'Upload audio', exact: true}).click()
	await (await chooser).setFiles({name: 'fixture.wav', mimeType: 'audio/wav', buffer: wav()})
	await expect(page.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
	expect(state.requests).toHaveLength(1)
	expect(state.requests[0].cleanup).toBe(false)
	expect(state.requests[0].filename).toBe('fixture.wav')
	expect(state.writes).toEqual([])
	expect(await page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.requests)).toBe(0)
})

function wav() {
	const data = Buffer.alloc(44 + 3200)
	data.write('RIFF')
	data.writeUInt32LE(data.length - 8, 4)
	data.write('WAVEfmt ', 8)
	data.writeUInt32LE(16, 16)
	data.writeUInt16LE(1, 20)
	data.writeUInt16LE(1, 22)
	data.writeUInt32LE(16000, 24)
	data.writeUInt32LE(32000, 28)
	data.writeUInt16LE(2, 32)
	data.writeUInt16LE(16, 34)
	data.write('data', 36)
	data.writeUInt32LE(3200, 40)
	return data
}

test('missing recognizer explains setup without requesting a microphone', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page, {configured: false})
	await page.goto(`/ai?chat=${CHAT_ID}`)
	await expect(page.locator('.speech-input-control__mic')).toHaveAttribute('aria-disabled', 'true')
	await page.locator('.speech-input-control__mic').click({force: true})
	await expect(page.locator('.speech-input-control__mic')).toHaveAttribute('title', /speech recognition model.*settings/i)
	expect(await page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.requests)).toBe(0)
	expect(state.requests).toEqual([])
})

test('denied microphone permission leaves a usable retry', async ({authenticatedPage: page}) => {
	await microphone(page, 'denied')
	const state = await server(page)
	await open(page)
	await page.locator('.speech-input-control__mic').click()
	await expect(page.getByText(/Cannot access the microphone/i)).toBeVisible()
	await page.evaluate(() => { (window as unknown as FixtureWindow).voiceFixture.mode = 'normal' })
	await page.locator('.speech-input-control__mic').click()
	await captureReady(page)
	await page.locator('.speech-input-control__mic').click()
	await expect(page.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
	await released(page, 2)
	expect(state.requests).toHaveLength(1)
})

for (const mode of ['busy', 'missing'] as const) {
	test(`microphone ${mode} reports the actual capture problem and allows retry`, async ({authenticatedPage: page}) => {
		await microphone(page, mode)
		const state = await server(page)
		await open(page)
		await page.locator('.composer textarea').fill('Keep my draft')
		await page.locator('.speech-input-control__mic').click()
		await expect(page.getByText(mode === 'busy'
			? /The microphone could not start/
			: /No microphone was found/)).toBeVisible()
		await expect(page.locator('.composer textarea')).toHaveValue('Keep my draft')
		await page.evaluate(() => { (window as unknown as FixtureWindow).voiceFixture.mode = 'normal' })
		await page.locator('.speech-input-control__mic').click()
		await captureReady(page)
		await page.locator('.speech-input-control__mic').click()
		await expect(page.locator('.composer textarea')).toHaveValue(`Keep my draft\n${TRANSCRIPT}`)
		await released(page, 2)
		expect(state.requests).toHaveLength(1)
		expect(state.writes).toEqual([])
	})
}

for (const width of [320, 390]) {
	test.describe(`voice touch ${width}px`, () => {
		test.use({hasTouch: true, viewport: {width, height: 844}})
		test('tap toggles recording; holding sends on release without a duplicate synthetic click', async ({authenticatedPage: page}, testInfo) => {
			await microphone(page)
			const state = await server(page)
			await open(page)
			const cdp = await page.context().newCDPSession(page)
			try {
				const trigger = page.locator('.speech-input-control__mic')
				const start = await point(trigger)
				await touch(cdp, 'touchStart', [start])
				await page.waitForTimeout(50) // A real short tap, comfortably below the hold threshold.
				await touch(cdp, 'touchEnd', [])
				await captureReady(page)
				await page.screenshot({path: testInfo.outputPath('touch-recording.png'), animations: 'disabled'})
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
				await touch(cdp, 'touchStart', [await point(trigger)])
				await page.waitForTimeout(50)
				await touch(cdp, 'touchEnd', [])
				await expect(page.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
				await released(page)
				await touch(cdp, 'touchStart', [await point(trigger)])
				// Exercise the actual 350ms hold threshold rather than dispatching a synthetic long-press event.
				await page.waitForTimeout(400)
				await captureReady(page)
				await touch(cdp, 'touchEnd', [])
				await expect(page.locator('.composer textarea')).toHaveValue(`${TRANSCRIPT}\n${TRANSCRIPT}`)
				await released(page, 2)
				expect(state.requests).toHaveLength(2)
				expect(state.writes).toEqual([])
			} finally {
				await cdp.detach()
			}
		})
	})
}

test.describe('voice touch cancellation', () => {
	test.use({hasTouch: true, viewport: {width: 390, height: 844}})
	for (const action of ['swipe', 'multitouch', 'late-permission'] as const) {
		test(`${action} keeps gesture ownership and releases every track`, async ({authenticatedPage: page}) => {
			await microphone(page, action === 'late-permission' ? 'pending' : 'normal')
			const state = await server(page)
			await open(page)
			const cdp = await page.context().newCDPSession(page)
			try {
				const start = await point(page.locator('.speech-input-control__mic'))
				await touch(cdp, 'touchStart', [start])
				await page.waitForTimeout(400)
				if (action !== 'late-permission') await captureReady(page)
				else await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.requests)).toBe(1)
				if (action === 'swipe') await touch(cdp, 'touchMove', [{...start, x: start.x - 100}])
				if (action === 'multitouch') await touch(cdp, 'touchStart', [start, {x: start.x + 60, y: start.y - 10, id: 2}])
				await touch(cdp, 'touchEnd', [])
				if (action === 'late-permission') await page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.release?.())
				await released(page)
				await expect(page.locator('.composer textarea')).toHaveValue('')
				expect(state.requests).toHaveLength(0)
				expect(state.writes).toEqual([])
			} finally {
				await cdp.detach()
			}
		})
	}
})

test('cleanup cannot replace text edited while its response was pending', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	let received = false
	let release = () => {}
	const ready = new Promise<void>(resolve => { release = resolve })
	await page.route('**/api/v2/ai/cleanup', async route => {
		received = true
		await ready
		await route.fulfill({json: {text: 'Old cleaned fixture', original: 'Before cleanup'}})
	})
	await open(page)
	const prompt = page.locator('.composer textarea')
	await prompt.fill('Before cleanup')
	await page.getByRole('button', {name: 'Voice options', exact: true}).click()
	await page.getByRole('button', {name: 'Clean up text', exact: true}).click()
	await expect.poll(() => received).toBe(true)
	await prompt.fill('My newer draft')
	release()
	const result = page.locator('[data-voice-cleanup-result]')
	await expandDetails(result)
	await expect(result.getByText('Old cleaned fixture', {exact: true})).toBeVisible()
	await expect(prompt).toHaveValue('My newer draft')
	expect(state.writes).toEqual([])
})

test('recorded fallback reveals raw text and permits sending while cleanup is still pending', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	const cleanup = await delayedCleanup(page)
	try {
		await open(page)
		const prompt = page.locator('.composer textarea')
		await page.locator('.speech-input-control__mic').click()
		await captureReady(page)
		await page.locator('.speech-input-control__mic').click()
		await expect(prompt).toHaveValue(TRANSCRIPT)
		await expect.poll(() => cleanup.received).toBe(true)
		await expect(page.locator('[data-voice-cleanup]')).toBeVisible()
		expect(cleanup.settled).toBe(false)
		expect(state.requests).toHaveLength(1)
		expect(state.requests[0].cleanup).toBe(false)
		await released(page)
		const edited = `${TRANSCRIPT}\nKeep my additional instruction.`
		await prompt.fill(edited)
		const send = page.locator('.composer-actions button[type=submit]')
		await expect(send).not.toHaveAttribute('aria-disabled', 'true')
		await send.click()
		await expect.poll(() => state.sentMessages.length).toBe(1)
		expect(state.sentMessages[0].message).toBe(edited)
		expect(cleanup.settled).toBe(false)
		cleanup.release()
		await expect.poll(() => cleanup.settled).toBe(true)
		await expect(prompt).toHaveValue('')
	} finally {
		cleanup.release()
	}
})

test('uploaded audio exposes raw text before cleanup and applies the result only to the unchanged draft', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	const cleanup = await delayedCleanup(page)
	try {
		await open(page)
		const prompt = page.locator('.composer textarea')
		await prompt.fill('Existing draft')
		await uploadAudio(page)
		await expect(prompt).toHaveValue(`Existing draft\n${TRANSCRIPT}`)
		await expect.poll(() => cleanup.received).toBe(true)
		expect(cleanup.settled).toBe(false)
		expect(state.requests[0]).toMatchObject({
			filename: 'fixture.wav',
			cleanup: false,
		})
		cleanup.release()
		await expect(prompt).toHaveValue(`Existing draft\n${CLEANED_TRANSCRIPT}`)
		await expect(page.locator('[data-voice-cleanup]')).toBeHidden()
		expect(state.writes).toEqual([])
		expect(await page.evaluate(() => (window as unknown as FixtureWindow).voiceFixture.requests)).toBe(0)
	} finally {
		cleanup.release()
	}
})

test('failed automatic cleanup preserves raw text and leaves the composer usable', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	const cleanup = await delayedCleanup(page, {fail: true})
	try {
		await open(page)
		await uploadAudio(page)
		const prompt = page.locator('.composer textarea')
		await expect(prompt).toHaveValue(TRANSCRIPT)
		await expect.poll(() => cleanup.received).toBe(true)
		cleanup.release()
		await expect.poll(() => cleanup.settled).toBe(true)
		await expect(page.locator('[data-voice-cleanup]')).toBeHidden()
		await expect(prompt).toHaveValue(TRANSCRIPT)
		await prompt.fill(`${TRANSCRIPT}\nThe raw text is safe to edit.`)
		await expect(page.locator('.composer-actions button[type=submit]')).not.toHaveAttribute('aria-disabled', 'true')
		expect(state.writes).toEqual([])
	} finally {
		cleanup.release()
	}
})

test('automatic cleanup keeps the edited draft and offers its completed result separately', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	const cleanup = await delayedCleanup(page)
	try {
		await open(page)
		await uploadAudio(page)
		const prompt = page.locator('.composer textarea')
		await expect(prompt).toHaveValue(TRANSCRIPT)
		await expect.poll(() => cleanup.received).toBe(true)
		await prompt.fill('My corrected instruction takes priority.')
		cleanup.release()
		const result = page.locator('[data-voice-cleanup-result]')
		await expandDetails(result)
		await expect(result.getByText(CLEANED_TRANSCRIPT, {exact: true})).toBeVisible()
		await expect(prompt).toHaveValue('My corrected instruction takes priority.')
		expect(state.writes).toEqual([])
	} finally {
		cleanup.release()
	}
})

test('a cleanup response cannot fill the draft of a different conversation', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page)
	const cleanup = await delayedCleanup(page)
	try {
		await open(page)
		await uploadAudio(page)
		await expect(page.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
		await expect.poll(() => cleanup.received).toBe(true)
		await selectOtherConversation(page)
		await page.locator('.composer textarea').fill('Only the second conversation owns this draft.')
		cleanup.release()
		await expect.poll(() => cleanup.settled).toBe(true)
		await expect(page.locator('.composer textarea')).toHaveValue('Only the second conversation owns this draft.')
		await expect(page.locator('[data-voice-cleanup-result]')).toBeHidden()
		expect(state.writes).toEqual([])
	} finally {
		cleanup.release()
	}
})

for (const viewport of [
	{
		width: 1440,
		height: 1000,
		protocol: 'dashscope-asr',
	},
	{
		width: 320,
		height: 844,
		protocol: 'qwen-asr-realtime',
	},
	{
		width: 390,
		height: 844,
		protocol: 'dashscope-asr',
	},
] as const) {
	test.describe(`live dictation ${viewport.protocol} ${viewport.width}px`, () => {
		test.use({
			hasTouch: viewport.width < 901,
			viewport: {
				width: viewport.width,
				height: viewport.height,
			},
		})
		test('previews incremental speech before stop and commits only after provider finalization', async ({authenticatedPage: page}, info) => {
			await microphone(page)
			const state = await server(page, {
				protocol: viewport.protocol,
				cleanup: false,
			})
			const live = await liveServer(page)
			await open(page)
			const prompt = page.locator('.composer textarea')
			await prompt.fill('Existing draft')
			const trigger = page.locator('.speech-input-control__mic')
			const cdp = viewport.width < 901 ? await page.context().newCDPSession(page) : undefined
			try {
				if (cdp) {
					await touch(cdp, 'touchStart', [await point(trigger)])
					await page.waitForTimeout(400) // Exercise the real hold threshold; network progress has its own barrier.
				} else {
					await trigger.click()
				}
				await captureReady(page)
				await expect.poll(() => live.state.pcmBytes).toBeGreaterThanOrEqual(3200)
				live.transcript('sentence-1', 'Review the plan…')
				await expect(page.locator('[data-voice-preview]')).toContainText('Review the plan…')
				await expect(trigger).toHaveAttribute('aria-pressed', 'true')
				await expect(prompt).toHaveValue('Existing draft')
				expect(live.state.commands.map(command => command.action)).toEqual(['start'])
				expect(state.requests).toEqual([])
				expect(state.writes).toEqual([])
				live.transcript('sentence-1', TRANSCRIPT, true)
				await expect(page.locator('[data-voice-preview]')).toContainText(TRANSCRIPT)
				// A stale partial cannot replace the final revision of the same provider sentence.
				live.transcript('sentence-1', 'An obsolete partial')
				await expect(page.locator('[data-voice-preview]')).not.toContainText('An obsolete partial')
				await page.screenshot({path: info.outputPath(`live-before-stop-${viewport.width}.png`), animations: 'disabled'})
				if (cdp) await touch(cdp, 'touchEnd', [])
				else await trigger.click()
				await expect.poll(() => live.state.commands.filter(command => command.action === 'stop').length).toBe(1)
				await released(page)
				// The explicit finalization barrier proves release does not prematurely append or send a partial.
				await expect(prompt).toHaveValue('Existing draft')
				expect(state.writes).toEqual([])
				live.done()
				await expect(prompt).toHaveValue(`Existing draft\n${TRANSCRIPT}`)
				await expect(page.locator('[data-voice-preview]')).toBeHidden()
				const stats = page.locator('[data-voice-stats]')
				await expandDetails(stats)
				await expect(stats).toContainText('live-speech-fixture')
				await expect(stats).toContainText(live.endpoint)
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
				expect(live.state.connections).toBe(1)
				expect(state.requests).toEqual([])
				expect(state.cleanupRequests).toEqual([])
				expect(state.writes).toEqual([])
			} finally {
				await cdp?.detach()
			}
		})
	})
}

test.describe('live dictation with constrained page networking', () => {
	test.use({
		hasTouch: true,
		viewport: {
			width: 390,
			height: 844,
		},
	})
	test('keeps the mobile draft usable while incremental and final speech responses wait', async ({authenticatedPage: page}, info) => {
		test.setTimeout(120_000)
		await microphone(page)
		const state = await server(page, {
			protocol: 'qwen-asr-realtime',
			cleanup: false,
			chinese: true,
		})
		const live = await liveServer(page)
		const finalResult = barrier()
		let finalizing: Promise<void> | undefined
		const cdp = await page.context().newCDPSession(page)
		try {
			await cdp.send('Network.enable')
			// CDP constrains page HTTP loading; fulfilled routes and mocked WebSockets do not prove public-network throughput.
			// Provider latency is controlled separately by the explicit partial/done barriers below.
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 150,
				downloadThroughput: 80 * 1024,
				uploadThroughput: 48 * 1024,
				connectionType: 'cellular3g',
			})
			await open(page)
			const prompt = page.locator('.composer textarea')
			await prompt.fill('保留原有草稿')
			const trigger = page.locator('.speech-input-control__mic')
			await trigger.click()
			await captureReady(page)
			// PCM comes from the real browser AudioWorklet; the fixture only supplies a local audio track.
			await expect.poll(() => live.state.pcmBytes).toBeGreaterThanOrEqual(3200)
			live.transcript('slow-sentence', '明天检查项目…')
			await expect(page.locator('[data-voice-preview]')).toContainText('明天检查项目…')
			await expect(prompt).toHaveValue('保留原有草稿')
			await expect(trigger).toHaveAttribute('aria-pressed', 'true')
			expect(live.state.commands.map(command => command.action)).toEqual(['start'])
			expect(state.requests).toEqual([])
			expect(state.writes).toEqual([])
			await page.screenshot({path: info.outputPath('weak-network-live-preview-390-zh.png'), animations: 'disabled'})
			await trigger.click()
			await expect.poll(() => live.state.commands.filter(command => command.action === 'stop').length).toBe(1)
			await released(page)
			finalizing = finalResult.promise.then(() => { if (!live.state.closed) live.done('明天检查项目计划。') })
			await expect(page.locator('.speech-input-control [role="status"]')).toContainText('正在等待最终转录')
			await expect(prompt).toHaveValue('保留原有草稿')
			await expect(page.locator('[data-voice-preview]')).toContainText('明天检查项目…')
			expect(state.writes).toEqual([])
			finalResult.release()
			await finalizing
			await expect(prompt).toHaveValue('保留原有草稿\n明天检查项目计划。')
			await expect(page.locator('[data-voice-preview]')).toBeHidden()
			await prompt.fill('保留原有草稿\n明天检查项目计划，并手动补充这一句。')
			await expect(page.locator('.composer-actions button[type=submit]')).not.toHaveAttribute('aria-disabled', 'true')
			expect(live.state.connections).toBe(1)
			expect(state.requests).toEqual([])
			expect(state.cleanupRequests).toEqual([])
			expect(state.writes).toEqual([])
			expect(state.sentMessages).toEqual([])
		} finally {
			finalResult.release()
			await finalizing
			await cdp.detach()
		}
	})
})

test('canceling a live recording discards its preview without adding text or sending a message', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page, {
		protocol: 'qwen-asr-realtime',
		cleanup: false,
	})
	const live = await liveServer(page)
	await open(page)
	const prompt = page.locator('.composer textarea')
	await prompt.fill('Keep this draft')
	await page.locator('.speech-input-control__mic').click()
	await expect.poll(() => live.state.pcmBytes).toBeGreaterThan(0)
	// Even a provider-final sentence is provisional until the whole dictation receives done.
	live.transcript('cancelled-sentence', TRANSCRIPT, true)
	await expect(page.locator('[data-voice-preview]')).toContainText(TRANSCRIPT)
	await page.locator('.speech-input-control__cancel').click()
	await released(page)
	await expect.poll(() => live.state.closed).toBe(true)
	await expect(page.locator('[data-voice-preview]')).toBeHidden()
	await expect(prompt).toHaveValue('Keep this draft')
	expect(live.state.commands.some(command => command.action === 'stop')).toBe(false)
	expect(state.requests).toEqual([])
	expect(state.writes).toEqual([])
})

test('hiding the floating live recorder releases capture without stopping its existing background task', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page, {
		protocol: 'dashscope-asr',
		cleanup: false,
		running: true,
	})
	const live = await liveServer(page)
	await open(page)
	await page.goto('/')
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	const panel = page.getByRole('region', {name: 'Arona', exact: true})
	await expect(panel.getByText('Existing background work', {exact: true})).toBeVisible()
	await panel.locator('.composer textarea').fill('A draft to retain')
	await panel.locator('.speech-input-control__mic').click()
	await expect.poll(() => live.state.pcmBytes).toBeGreaterThan(0)
	live.transcript('hidden-sentence', TRANSCRIPT, true)
	await expect(panel.locator('[data-voice-preview]')).toContainText(TRANSCRIPT)
	await panel.getByRole('button', {name: 'Minimize Arona (keep working)', exact: true}).click()
	await expect(panel).toBeHidden()
	await released(page)
	await expect.poll(() => live.state.closed).toBe(true)
	await page.getByRole('button', {name: 'Open floating Arona', exact: true}).click()
	await expect(panel.locator('.composer textarea')).toHaveValue('A draft to retain')
	await expect(panel.locator('[data-voice-preview]')).toBeHidden()
	await expect(panel.getByText('Existing background work', {exact: true})).toBeVisible()
	expect(state.requests).toEqual([])
	expect(state.writes).toEqual([])
})

test('a live recording finalized after a conversation switch cannot overwrite the new conversation draft', async ({authenticatedPage: page}) => {
	await microphone(page)
	const state = await server(page, {
		protocol: 'qwen-asr-realtime',
		cleanup: false,
	})
	const live = await liveServer(page)
	await open(page)
	await page.locator('.composer textarea').fill('First conversation draft')
	await page.locator('.speech-input-control__mic').click()
	await expect.poll(() => live.state.pcmBytes).toBeGreaterThan(0)
	live.transcript('first-chat-sentence', TRANSCRIPT, true)
	await expect(page.locator('[data-voice-preview]')).toContainText(TRANSCRIPT)
	await page.locator('.speech-input-control__mic').click()
	await expect.poll(() => live.state.commands.some(command => command.action === 'stop')).toBe(true)
	await released(page)
	// Browser history is a real same-document route change and remains possible while provider finalization waits.
	await page.evaluate(id => {
		const target = new URL(location.href)
		target.searchParams.set('chat', id)
		history.pushState({}, '', target)
		dispatchEvent(new PopStateEvent('popstate', {state: history.state}))
	}, OTHER_CHAT_ID)
	await expect(page).toHaveURL(new RegExp(`chat=${OTHER_CHAT_ID}`))
	await expect(page.locator(`[data-chat-id="${OTHER_CHAT_ID}"] .history-link`))
		.toHaveAttribute('aria-current', 'true')
	await page.locator('.composer textarea').fill('Second conversation draft')
	// A queued provider callback must be fenced even when the browser has not delivered close yet.
	if (!live.state.closed) live.done()
	await expect.poll(() => live.state.closed).toBe(true)
	await expect(page.locator('.composer textarea')).toHaveValue('Second conversation draft')
	await expect(page.locator('[data-voice-preview]')).toBeHidden()
	expect(state.requests).toEqual([])
	expect(state.writes).toEqual([])
})
