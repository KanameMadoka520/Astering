// Audio Chat accepts WAV/MP3; browser MediaRecorder usually produces WebM or M4A.
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
	const buffer = new ArrayBuffer(44 + samples.length * 2)
	const view = new DataView(buffer)
	const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
	text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
	view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
	view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
	view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true)
	for (let i = 0; i < samples.length; i++) {
		const value = Math.max(-1, Math.min(1, samples[i]))
		view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true)
	}
	return new Blob([buffer], {type: 'audio/wav'})
}

export async function audioChatFile(file: Blob, filename: string): Promise<{file: Blob, filename: string}> {
	if (/\.(wav|mp3)$/i.test(filename)) return {file, filename}
	return convertSpeechAudio(file, 16000, 180)
}

export function speechSampleRate(protocol: string): number {
	if (protocol === 'openai-realtime') return 24000
	return ['dashscope-asr', 'qwen-asr-realtime', 'volcengine-asr', 'elevenlabs-realtime', 'soniox-realtime']
		.includes(protocol) ? 16000 : 0
}

export async function prepareSpeechFile(
	file: Blob,
	filename: string,
	protocol: string,
): Promise<{file: Blob, filename: string}> {
	const rate = speechSampleRate(protocol)
	if (rate) return convertSpeechAudio(file, rate, 600)
	if (['openai-audio', 'mimo-asr', 'dashscope-file-asr', 'sensevoice'].includes(protocol)) {
		return audioChatFile(file, filename)
	}
	return {file, filename}
}

async function convertSpeechAudio(file: Blob, sampleRate: number, maxDuration: number) {
	const decoder = new OfflineAudioContext(1, 1, sampleRate)
	const decoded = await decoder.decodeAudioData(await file.arrayBuffer())
	if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > maxDuration) {
		throw new Error('audio-duration')
	}
	const samples = Math.ceil(decoded.duration * sampleRate)
	if (44 + samples * 2 > 16 * 1024 * 1024) throw new Error('audio-size')
	const renderer = new OfflineAudioContext(1, samples, sampleRate)
	const source = renderer.createBufferSource()
	source.buffer = decoded
	source.connect(renderer.destination)
	source.start()
	const converted = await renderer.startRendering()
	return {
		file: encodeWav(converted.getChannelData(0), sampleRate),
		filename: 'recording.wav',
	}
}
