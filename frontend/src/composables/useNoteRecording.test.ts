import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useNoteRecording} from './useNoteRecording'

const recorders = vi.hoisted(() => ({
	native: vi.fn(() => 'native'),
	web: vi.fn(() => 'web'),
}))

vi.mock('./useNativeNoteRecording', () => ({useNativeNoteRecording: recorders.native}))
vi.mock('./useLiveNoteRecording', () => ({useLiveNoteRecording: recorders.web}))

describe('note recorder transport for a selected server', () => {
	const originalLocation = window.location
	const options = {
		noteID: () => 4,
		connectionID: () => 'speech-connection',
		sampleRate: () => 16000,
		language: () => 'zh-CN',
		onSegment: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: new URL('https://personal.example:8443/notes/4'),
		})
		window.API_URL = ''
		window.AsteringNative = {postMessage: vi.fn()}
	})

	afterEach(() => {
		delete window.AsteringNative
		window.API_URL = ''
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		})
	})

	it('uses native capture on another selected HTTPS server with its local API', () => {
		expect(useNoteRecording(options)).toBe('native')
		expect(recorders.native).toHaveBeenCalledWith(options)
		expect(recorders.web).not.toHaveBeenCalled()
	})

	it.each(['https://other.example', 'https://personal.example'])('keeps browser recording for API %s outside the selected origin', api => {
		window.API_URL = api
		expect(useNoteRecording(options)).toBe('web')
		expect(recorders.web).toHaveBeenCalledWith(options)
		expect(recorders.native).not.toHaveBeenCalled()
	})

	it('keeps browser recording when native injection is absent', () => {
		delete window.AsteringNative
		expect(useNoteRecording(options)).toBe('web')
		expect(recorders.native).not.toHaveBeenCalled()
	})
})
