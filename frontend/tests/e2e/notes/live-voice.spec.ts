import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'

type MicrophoneState = {
	mode: 'normal' | 'pending' | 'denied'
	tracks: MediaStreamTrack[]
	requests: number
	release?: () => void
}
type VoiceWindow = Window & {liveNoteMic: MicrophoneState}

async function microphone(page: Page, mode: MicrophoneState['mode'] = 'normal') {
	await page.addInitScript(mode => {
		const state: MicrophoneState = {mode, tracks: [], requests: 0}
		;(window as VoiceWindow).liveNoteMic = state
		Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => {
			state.requests++
			if (state.mode === 'denied') throw new DOMException('Fixture denied', 'NotAllowedError')
			if (state.mode === 'pending') await new Promise<void>(resolve => { state.release = resolve })
			const context = new AudioContext()
			const oscillator = context.createOscillator()
			const output = context.createMediaStreamDestination()
			oscillator.connect(output)
			oscillator.start()
			for (const track of output.stream.getTracks()) {
				state.tracks.push(track)
				const stop = track.stop.bind(track)
				track.stop = () => { stop(); void context.close() }
			}
			return output.stream
		}})
	}, mode)
}

for (const viewport of [
	{width: 1440, height: 1000, language: 'en'},
	{width: 320, height: 740, language: 'zh-CN'},
]) {
	test(`live PCM saves before stop, flushes the last sentence and survives reload at ${viewport.width}px`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		await page.setViewportSize(viewport)
		await updateUserSettings(apiContext, userToken, {language: viewport.language})
		await microphone(page)
		const headers = {Authorization: `Bearer ${userToken}`}
		const settings = await apiContext.post('/api/v2/ai/settings', {headers, data: {
			connections: [{
				id: 'live-fixture',
				name: 'Live speech fixture',
				kind: 'transcription',
				protocol: 'dashscope-asr',
				base_url: 'https://speech.invalid/api-ws/v1/inference',
				model: 'fun-asr-realtime',
				api_key: 'fixture-key-only',
			}],
			transcription: 'live-fixture',
			assistant: '',
			cleanup: '',
		}})
		expect(settings.ok(), await settings.text()).toBe(true)
		const creation = await apiContext.post('/api/v2/notes', {headers, data: {
			title: 'A continuous idea record', content: 'Keep my edited article intact.', pinned: false,
		}})
		expect(creation.ok(), await creation.text()).toBe(true)
		const note = await creation.json()
		let pcmBytes = 0
		let saved = false
		let stopReceived = false
		let attachmentRequests = 0
		let recordingStarted = false
		let articleReadsDuringRecording = 0
		page.on('request', request => {
			if (recordingStarted && request.method() === 'GET' && new URL(request.url()).pathname === `/api/v2/notes/${note.id}`) articleReadsDuringRecording++
			if (request.method() === 'POST' && /attachments|\/transcribe$/.test(new URL(request.url()).pathname)) attachmentRequests++
		})
		await page.routeWebSocket('**/api/v2/notes/live', wire => {
			wire.onMessage(async message => {
				if (typeof message === 'string') {
					const command = JSON.parse(message)
					if (command.action === 'start') {
						expect(command.note_id).toBe(note.id)
						expect(command.connection_id).toBe('live-fixture')
						wire.send(JSON.stringify({
							type: 'ready', sample_rate: 16000, offset_ms: 0,
							rotate_seconds: 420, model: 'fun-asr-realtime', endpoint: 'wss://speech.invalid/api-ws/v1/inference',
						}))
					} else if (command.action === 'stop') {
						stopReceived = true
						const final = await apiContext.post(`/api/v2/notes/${note.id}/segments`, {headers, data: {
							client_id: crypto.randomUUID(), text: 'Final thought saved after stop.', start_ms: 1000, end_ms: 1600,
						}})
						expect(final.ok(), await final.text()).toBe(true)
						const finalStats = await apiContext.get(`/api/v2/notes/${note.id}`, {headers})
						wire.send(JSON.stringify({type: 'segment', id: 'last', segment: await final.json(), stats: await finalStats.json()}))
						wire.send(JSON.stringify({type: 'done'}))
					}
					return
				}
				pcmBytes += message.byteLength
				if (saved || pcmBytes < 6400) return
				saved = true
				wire.send(JSON.stringify({type: 'partial', id: 'first', text: 'An idea is becoming…'}))
				const first = await apiContext.post(`/api/v2/notes/${note.id}/segments`, {headers, data: {
					client_id: crypto.randomUUID(), text: 'An idea saved while still recording.', start_ms: 0, end_ms: 1000,
				}})
				expect(first.ok(), await first.text()).toBe(true)
				const firstStats = await apiContext.get(`/api/v2/notes/${note.id}`, {headers})
				wire.send(JSON.stringify({type: 'segment', id: 'first', segment: await first.json(), stats: await firstStats.json()}))
			})
		})
		await page.goto(`/notes/${note.id}`)
		if (viewport.width < 901) await page.getByRole('tab', {name: /^原始转录/}).click()
		const recorder = page.locator('.live-voice')
		const start = recorder.getByRole('button', {name: viewport.language === 'en' ? 'Start recording' : '开始记录', exact: true})
		// Initial navigation still loads the article; measure only after the recorder is ready.
		await expect(start).toBeVisible()
		recordingStarted = true
		await start.click()
		await expect(page.locator('.note-transcript__content p')).toContainText('An idea saved while still recording.')
		expect(stopReceived).toBe(false)
		expect(pcmBytes).toBeGreaterThanOrEqual(6400)
		await expect(recorder).toContainText(viewport.language === 'en' ? 'Recording and transcribing' : '正在录音并识别')
		if (viewport.width < 901) {
			await page.getByRole('tab', {name: '文章', exact: true}).click()
			const indicator = page.getByRole('button', {name: /正在录音.*查看/})
			await expect(indicator).toBeVisible()
			await indicator.click()
			await expect(page.getByRole('tab', {name: /^原始转录/})).toHaveAttribute('aria-selected', 'true')
		}
		await page.screenshot({path: info.outputPath(`live-notes-recording-${viewport.width}.png`), fullPage: true, animations: 'disabled'})
		await recorder.getByRole('button', {name: viewport.language === 'en' ? 'Stop and save' : '停止并保存', exact: true}).click()
		await expect(page.locator('.note-transcript__content p')).toHaveCount(2)
		await expect(recorder).toContainText(viewport.language === 'en' ? 'Recording finished' : '记录已结束')
		await expect.poll(() => page.evaluate(() => (window as VoiceWindow).liveNoteMic.tracks.every(track => track.readyState === 'ended'))).toBe(true)
		const stored = await (await apiContext.get(`/api/v2/notes/${note.id}`, {headers})).json()
		expect(stored.content).toBe('Keep my edited article intact.')
		expect(stored.segment_count).toBe(2)
		expect(stored.revision).toBe(note.revision)
		expect(attachmentRequests).toBe(0)
		expect(articleReadsDuringRecording).toBe(0)
		recordingStarted = false
		await page.reload()
		if (viewport.width < 901) await page.getByRole('tab', {name: /^原始转录/}).click()
		await expect(page.locator('.note-transcript__content p')).toHaveText([
			'An idea saved while still recording.', 'Final thought saved after stop.',
		])
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
		expect(overflow).toBe(false)
		await page.screenshot({path: info.outputPath(`live-notes-${viewport.width}.png`), fullPage: true, animations: 'disabled'})
	})
}

test('cancelled pending microphone permission cannot start a late recording', async ({authenticatedPage: page, apiContext, userToken}) => {
	await microphone(page, 'pending')
	await page.route('**/api/v2/notes/live-connections', route => route.fulfill({json: [{
		id: 'live', name: 'Fixture', model: 'fixture', protocol: 'dashscope-asr', endpoint: 'wss://speech.invalid', sample_rate: 16000, default: true,
	}]}))
	const creation = await apiContext.post('/api/v2/notes', {
		headers: {Authorization: `Bearer ${userToken}`}, data: {title: 'Pending permission', content: ''},
	})
	expect(creation.ok()).toBe(true)
	const note = await creation.json()
	let connected = 0
	await page.routeWebSocket('**/api/v2/notes/live', () => { connected++ })
	await page.goto(`/notes/${note.id}`)
	const recorder = page.locator('.live-voice')
	await recorder.getByRole('button', {name: 'Start recording', exact: true}).click()
	await expect(recorder).toContainText('Waiting for microphone permission')
	await recorder.getByRole('button', {name: 'Stop and save', exact: true}).click()
	await page.evaluate(() => (window as VoiceWindow).liveNoteMic.release?.())
	await expect.poll(() => page.evaluate(() => (window as VoiceWindow).liveNoteMic.tracks.length)).toBe(1)
	await expect.poll(() => page.evaluate(() => (window as VoiceWindow).liveNoteMic.tracks.every(track => track.readyState === 'ended'))).toBe(true)
	expect(connected).toBe(0)
	await expect(recorder.getByRole('button', {name: 'Start recording', exact: true})).toBeVisible()
})
