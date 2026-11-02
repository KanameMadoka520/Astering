import {afterEach, describe, expect, it, vi} from 'vitest'
import {encodeWav, audioChatFile, prepareSpeechFile} from './tcyAudio'

describe('browser recordings for OpenAI Chat Audio', () => {
	it('writes a mono 16-bit PCM WAV with clipped samples and correct sizes', async () => {
		const blob = encodeWav(new Float32Array([-2, -1, 0, .5, 1, 2]), 16000)
		const data = new DataView(await blob.arrayBuffer())
		expect(blob.type).toBe('audio/wav')
		expect(new TextDecoder().decode(new Uint8Array(data.buffer, 0, 4))).toBe('RIFF')
		expect(new TextDecoder().decode(new Uint8Array(data.buffer, 8, 4))).toBe('WAVE')
		expect(data.getUint32(4, true)).toBe(48)
		expect(data.getUint32(40, true)).toBe(12)
		expect(data.getUint16(20, true)).toBe(1)
		expect(data.getUint16(22, true)).toBe(1)
		expect(data.getUint32(24, true)).toBe(16000)
		expect([0, 1, 2, 3, 4, 5].map(i => data.getInt16(44 + 2 * i, true))).toEqual([-32768, -32768, 0, 16383, 32767, 32767])
	})
	it('preserves already supported audio without trying to decode it', async () => {
		const file = new Blob(['mp3 data'], {type: 'audio/mpeg'})
		expect(await audioChatFile(file, 'voice.MP3')).toEqual({file, filename: 'voice.MP3'})
	})
})


afterEach(() => vi.unstubAllGlobals())

describe('native speech audio preparation', () => {
	function audioContext(duration: number) {
		class AudioContext {
			constructor(_: number, public length: number, public sampleRate: number) {}
			async decodeAudioData() { return {duration} }
			createBufferSource() { return {buffer: undefined, connect() {}, start() {}} }
			get destination() { return {} }
			async startRendering() { return {getChannelData: () => new Float32Array(this.length)} }
		}
		vi.stubGlobal('OfflineAudioContext', AudioContext)
	}
	it('normalizes WAV uploads too, converting stereo or wrong-rate files for the selected wire protocol', async () => {
		audioContext(.5)
		const input = new Blob(['source audio'], {type: 'audio/wav'})
		for (const [protocol, rate] of [['openai-realtime', 24000], ['dashscope-asr', 16000]] as const) {
			const result = await prepareSpeechFile(input, 'original.wav', protocol)
			const data = new DataView(await result.file.arrayBuffer())
			expect(result.filename).toBe('recording.wav')
			expect(data.getUint32(24, true)).toBe(rate)
			expect(data.getUint16(22, true)).toBe(1)
			expect(data.getUint32(40, true)).toBe(rate)
		}
	})
	it('rejects long decoded recordings before allocating their rendered PCM output', async () => {
		audioContext(601)
		await expect(prepareSpeechFile(new Blob(['compressed']), 'audio.webm', 'dashscope-asr')).rejects.toThrow('audio-duration')
	})
})
