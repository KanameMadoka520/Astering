import type {CDPSession, Locator, Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'

const CHAT_ID = '2b8d6024-4d76-4a20-8e55-b077b16dd63b'
const TRANSCRIPT = 'Voice fixture: review the plan tomorrow.'
type MicrophoneFixture = {
	mode: 'normal' | 'pending' | 'denied'
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
		const fixture = (window as FixtureWindow).voiceFixture
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
		;(window as FixtureWindow).voiceFixture = state
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

async function server(page: Page, options: {configured?: boolean, running?: boolean, chinese?: boolean} = {}) {
	const requests: {filename: string, audio: string, cleanup: boolean}[] = []
	const writes: string[] = []
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
			protocol: 'openai-transcription',
			base_url: 'https://fixture.invalid/v1',
			model: 'whisper-1',
			has_key: true,
		}],
		assistant: 'chat',
		transcription: options.configured === false ? '' : 'speech',
		cleanup: 'chat',
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
		if (request.method() !== 'GET') {
			writes.push(new URL(request.url()).pathname)
			return route.fulfill({status: 400, json: {message: 'Unexpected conversation write'}})
		}
		const suffix = new URL(request.url()).pathname.split('/ai/conversations')[1]
		if (!suffix) return route.fulfill({json: {
			items: [{id: CHAT_ID, title: conversation.title, turn_count: turns.length, running: Boolean(options.running)}],
			total: 1,
			total_pages: 1,
		}})
		if (suffix.endsWith('/events')) return route.fulfill({
			contentType: 'text/event-stream',
			body: `event: activity\ndata: ${JSON.stringify({turn: turns.at(-1), compacting: false, compactions: []})}\n\n`,
		})
		return route.fulfill({json: conversation})
	})
	return {requests, writes}
}

async function open(page: Page) {
	await page.goto(`/ai?chat=${CHAT_ID}`)
	await expect(page.locator('.speech-input-control__mic')).toBeVisible()
	await expect(page.locator('.speech-input-control__mic')).not.toHaveAttribute('aria-disabled', 'true')
}

async function released(page: Page, requestCount = 1) {
	await expect.poll(() => page.evaluate(() => {
		const fixture = (window as FixtureWindow).voiceFixture
		return fixture.tracks.length >= 1 && fixture.tracks.every(track => track.readyState === 'ended')
	})).toBe(true)
	expect(await page.evaluate(() => (window as FixtureWindow).voiceFixture.requests)).toBe(requestCount)
}

async function captureReady(page: Page) {
	await expect.poll(() => page.evaluate(() => {
		const fixture = (window as FixtureWindow).voiceFixture
		return fixture.tracks.some(track => track.readyState === 'live')
	})).toBe(true)
	// A real encoder needs an audio frame; this waits on the audio clock, not a guessed network delay.
	await expect.poll(() => page.evaluate(() => (window as FixtureWindow).voiceFixture.contexts.at(-1)?.currentTime ?? 0)).toBeGreaterThan(.1)
}

async function point(locator: Locator) {
	// CDP coordinates lack locator actionability; wait for visibility and stable layout without clicking.
	await locator.click({trial: true})
	const bounds = await locator.boundingBox()
	expect(bounds).not.toBeNull()
	const position = {x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2, id: 1}
	await locator.evaluate((element, location) => {
		const target = document.elementFromPoint(location.x, location.y)
		;(window as FixtureWindow).voiceFixture.events.push({
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
		expect(state.requests[0].cleanup).toBe(true)
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
	expect(await page.evaluate(() => (window as FixtureWindow).voiceFixture.requests)).toBe(0)
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
	expect(await page.evaluate(() => (window as FixtureWindow).voiceFixture.requests)).toBe(0)
	expect(state.requests).toEqual([])
})

test('denied microphone permission leaves a usable retry', async ({authenticatedPage: page}) => {
	await microphone(page, 'denied')
	const state = await server(page)
	await open(page)
	await page.locator('.speech-input-control__mic').click()
	await expect(page.getByText(/Cannot access the microphone/i)).toBeVisible()
	await page.evaluate(() => { (window as FixtureWindow).voiceFixture.mode = 'normal' })
	await page.locator('.speech-input-control__mic').click()
	await captureReady(page)
	await page.locator('.speech-input-control__mic').click()
	await expect(page.locator('.composer textarea')).toHaveValue(TRANSCRIPT)
	await released(page, 2)
	expect(state.requests).toHaveLength(1)
})

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
				else await expect.poll(() => page.evaluate(() => (window as FixtureWindow).voiceFixture.requests)).toBe(1)
				if (action === 'swipe') await touch(cdp, 'touchMove', [{...start, x: start.x - 100}])
				if (action === 'multitouch') await touch(cdp, 'touchStart', [start, {x: start.x + 60, y: start.y - 10, id: 2}])
				await touch(cdp, 'touchEnd', [])
				if (action === 'late-permission') await page.evaluate(() => (window as FixtureWindow).voiceFixture.release?.())
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
	await expect(page.getByText('You edited the draft while cleanup was running. Your edits are kept; run cleanup again if needed.', {exact: true})).toBeVisible()
	await expect(prompt).toHaveValue('My newer draft')
	expect(state.writes).toEqual([])
})
