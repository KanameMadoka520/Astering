import type {Page} from '@playwright/test'
import {test, expect} from '../../support/fixtures'
import {updateUserSettings} from '../../support/updateUserSettings'

type MicrophoneState = {
	mode: 'normal' | 'pending' | 'denied' | 'silent'
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
			const volume = context.createGain()
			volume.gain.value = state.mode === 'silent' ? 0 : 0.5
			const output = context.createMediaStreamDestination()
			oscillator.connect(volume).connect(output)
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
							request_id: 'da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a',
						}))
					} else if (command.action === 'stop') {
						stopReceived = true
						const final = await apiContext.post(`/api/v2/notes/${note.id}/segments`, {headers, data: {
							client_id: crypto.randomUUID(), text: 'Final thought saved after stop.', start_ms: 1000, end_ms: 1600,
						}})
						expect(final.ok(), await final.text()).toBe(true)
						const finalStats = await apiContext.get(`/api/v2/notes/${note.id}`, {headers})
						wire.send(JSON.stringify({type: 'segment', id: 'last', segment: await final.json(), stats: await finalStats.json()}))
						wire.send(JSON.stringify({
							type: 'done',
							request_id: 'da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a',
							diagnostics: {
								elapsed_ms: 2500,
								received_bytes: pcmBytes,
								audio_duration_ms: pcmBytes / 32,
								last_audio_ms: 2000,
								partial_updates: 1,
								saved_segments: 2,
								first_text_ms: 200,
								last_text_ms: 2400,
							},
						}))
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
		const background = recorder.getByRole('checkbox', {name: viewport.language === 'en' ? 'Continue after switching tabs, when supported' : '浏览器支持时，切换标签页后继续录音', exact: true})
		const awake = recorder.getByRole('checkbox', {name: viewport.language === 'en' ? 'Try to keep the screen awake while recording' : '录音时尽量保持屏幕常亮', exact: true})
		const start = recorder.getByRole('button', {name: viewport.language === 'en' ? 'Start recording' : '开始记录', exact: true})
		// Initial navigation still loads the article; measure only after the recorder is ready.
		await expect(start).toBeVisible()
		await recorder.locator('summary').click()
		await background.check()
		await expect.poll(async () => {
			const account = await (await apiContext.get('/api/v2/user', {headers})).json()
			return account.settings.frontend_settings.live_notes_allow_background
		}).toBe(true)
		await awake.check()
		await expect.poll(async () => {
			const account = await (await apiContext.get('/api/v2/user', {headers})).json()
			return account.settings.frontend_settings.live_notes_keep_awake
		}).toBe(true)
		await page.reload()
		if (viewport.width < 901) await page.getByRole('tab', {name: /^原始转录/}).click()
		await recorder.locator('summary').click()
		await expect(background).toBeChecked()
		await expect(awake).toBeChecked()
		expect(await page.evaluate(() => (window as VoiceWindow).liveNoteMic.requests)).toBe(0)
		recordingStarted = true
		await start.click()
		await expect(page.locator('.note-transcript__content p')).toContainText('An idea saved while still recording.')
		expect(stopReceived).toBe(false)
		expect(pcmBytes).toBeGreaterThanOrEqual(6400)
		const meter = recorder.getByRole('meter', {name: viewport.language === 'en' ? 'Microphone input' : '麦克风输入电平'})
		await expect(meter).toBeVisible()
		await expect.poll(async () => Number(await meter.getAttribute('value'))).toBeGreaterThan(-55)
		await expect(recorder.locator('.live-voice__signal')).toContainText(viewport.language === 'en' ? 'Browser sent' : '浏览器已发送')
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
		await expect(recorder.locator('.live-voice__diagnostics')).toContainText('da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a')
		await expect(recorder.locator('.live-voice__diagnostics')).toContainText(
			viewport.language === 'en' ? '1 interim updates · 2 segments saved' : '1 次临时字幕 · 2 段已保存',
		)
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
		await recorder.locator('summary').click()
		await expect(background).toBeChecked()
		await expect(awake).toBeChecked()
		await background.uncheck()
		await expect.poll(async () => {
			const account = await (await apiContext.get('/api/v2/user', {headers})).json()
			return account.settings.frontend_settings.live_notes_allow_background
		}).toBe(false)
		await awake.uncheck()
		await expect.poll(async () => {
			const account = await (await apiContext.get('/api/v2/user', {headers})).json()
			return account.settings.frontend_settings.live_notes_keep_awake
		}).toBe(false)
		await page.reload()
		if (viewport.width < 901) await page.getByRole('tab', {name: /^原始转录/}).click()
		await recorder.locator('summary').click()
		await expect(background).not.toBeChecked()
		await expect(awake).not.toBeChecked()
		expect(await page.evaluate(() => (window as VoiceWindow).liveNoteMic.requests)).toBe(0)
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

for (const scenario of [
	{mode: 'normal' as const, width: 1440, language: 'en', warning: 'recognizer_waiting'},
	{mode: 'silent' as const, width: 320, language: 'zh-CN', warning: 'input_quiet'},
]) {
	test(`live notes explain ${scenario.warning} and retain safe provider diagnostics`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}, info) => {
		await page.setViewportSize({width: scenario.width, height: 900})
		await updateUserSettings(apiContext, userToken, {language: scenario.language})
		await microphone(page, scenario.mode)
		await page.route('**/api/v2/notes/live-connections', route => route.fulfill({json: [{
			id: 'live',
			name: 'Fixture',
			model: 'fixture',
			protocol: 'dashscope-asr',
			endpoint: 'wss://speech.invalid',
			sample_rate: 16000,
			default: true,
		}]}))
		const creation = await apiContext.post('/api/v2/notes', {
			headers: {Authorization: `Bearer ${userToken}`},
			data: {title: 'Browser audio diagnostics', content: 'Keep this saved article.'},
		})
		expect(creation.ok()).toBe(true)
		const note = await creation.json()
		let pcmBytes = 0
		let wire: {send: (message: string) => void} | undefined
		await page.routeWebSocket('**/api/v2/notes/live', socket => {
			wire = socket
			socket.onMessage(message => {
				if (typeof message !== 'string') {
					pcmBytes += message.byteLength
					return
				}
				if (JSON.parse(message).action === 'start') socket.send(JSON.stringify({
					type: 'ready',
					sample_rate: 16000,
					offset_ms: 0,
					rotate_seconds: 420,
					model: 'fixture',
					endpoint: 'wss://speech.invalid',
					request_id: 'da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a',
				}))
			})
		})
		await page.goto(`/notes/${note.id}`)
		if (scenario.width < 901) await page.getByRole('tab', {name: /^原始转录/}).click()
		const recorder = page.locator('.live-voice')
		await recorder.getByRole('button', {
			name: scenario.language === 'en' ? 'Start recording' : '开始记录',
			exact: true,
		}).click()
		const meter = recorder.getByRole('meter')
		await expect(meter).toBeVisible()
		await expect(recorder.locator('.live-voice__signal-warning')).toContainText(
			scenario.mode === 'normal' ? 'the recognizer has not returned new text' : '当前采音接近静音',
			{timeout: 18000},
		)
		expect(pcmBytes).toBeGreaterThan(32000 * 8)
		await expect(recorder.locator('.live-voice__error')).toHaveCount(0)
		if (scenario.mode === 'silent') expect(Number(await meter.getAttribute('value'))).toBe(-60)
		else {
			await expect.poll(async () => Number(await meter.getAttribute('value'))).toBeGreaterThan(-55)
			wire!.send(JSON.stringify({type: 'partial', id: 'one', text: 'A delayed but real interim response.'}))
			await expect(recorder.locator('.live-voice__partial')).toContainText('A delayed but real interim response.')
			await expect(recorder.locator('.live-voice__signal-warning')).toHaveCount(0)
		}
		await page.screenshot({path: info.outputPath(`live-notes-${scenario.warning}-${scenario.width}.png`), fullPage: true})
		wire!.send(JSON.stringify({
			type: 'error',
			code: 'invalid_audio',
			request_id: 'da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a',
			provider_code: 'CLIENT_ERROR',
			provider_request_id: '44bfcfc3c54143879fdaff0be709c81b',
			provider_task_id: '3d274ab62ed34584a8aca2e1746db8ac',
			diagnostics: {
				elapsed_ms: 15000,
				received_bytes: 32000,
				audio_duration_ms: 1000,
				last_audio_ms: 1000,
				partial_updates: 0,
				saved_segments: 0,
				first_text_ms: 0,
				last_text_ms: 0,
			},
		}))
		await expect(recorder.locator('.live-voice__error')).toContainText('da4b1ac7-f23c-42c3-a69a-b8d0ce7d0e6a')
		await recorder.locator('summary').click()
		await expect(recorder.locator('.live-voice__diagnostics')).toContainText('CLIENT_ERROR')
		await expect(recorder.locator('.live-voice__diagnostics')).toContainText('44bfcfc3c54143879fdaff0be709c81b')
		await expect(recorder.locator('.live-voice__diagnostics')).toContainText('31.3 KiB')
		await expect.poll(() => page.evaluate(() => (window as VoiceWindow).liveNoteMic.tracks
			.every(track => track.readyState === 'ended'))).toBe(true)
		const stored = await (await apiContext.get(`/api/v2/notes/${note.id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})).json()
		expect(stored.content).toBe('Keep this saved article.')
		expect(stored.segment_count).toBe(0)
		expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false)
		await page.screenshot({path: info.outputPath(`live-notes-provider-error-${scenario.width}.png`), fullPage: true})
	})
}
