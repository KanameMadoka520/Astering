import {runInNewContext} from 'node:vm'
import {describe, expect, it} from 'vitest'
import workletSource from './livePcmCapture.js?raw'

type PCMProcessor = {
	port: {onmessage: (event: {data: string}) => void},
	process: (inputs: Float32Array[][]) => boolean,
}
function processor(inputRate: number, outputRate = 16000) {
	const messages: Array<ArrayBuffer | string> = []
	const transfers: Array<ArrayBuffer[] | undefined> = []
	let Processor!: new (options: {processorOptions: {rate: number}}) => PCMProcessor
	let registered = ''
	runInNewContext(workletSource, {
		sampleRate: inputRate,
		ArrayBuffer,
		DataView,
		Int16Array,
		AudioWorkletProcessor: class {
			port = {
				onmessage: undefined,
				postMessage: (message: ArrayBuffer | string, transfer?: ArrayBuffer[]) => {
					messages.push(message)
					transfers.push(transfer)
				},
			}
		},
		registerProcessor: (name: string, constructor: typeof Processor) => { registered = name; Processor = constructor },
	})
	expect(registered).toBe('astering-live-pcm')
	const instance = new Processor({processorOptions: {rate: outputRate}})
	const samples = () => messages.filter((message): message is ArrayBuffer => message instanceof ArrayBuffer)
		.flatMap(bytes => Array.from({length: bytes.byteLength / 2}, (_, index) => new DataView(bytes).getInt16(index * 2, true)))
	return {instance, messages, samples, transfers}
}

describe('live PCM AudioWorklet', () => {
	it('streams bounded little-endian 100 ms frames before flush and averages stereo channels', () => {
		const h = processor(48000)
		h.instance.process([[new Float32Array(4800).fill(1), new Float32Array(4800).fill(0)]])
		expect(h.messages).toHaveLength(1)
		expect((h.messages[0] as ArrayBuffer).byteLength).toBe(3200)
		expect(h.samples()).toHaveLength(1600)
		expect(new Set(h.samples())).toEqual(new Set([16384]))
		h.instance.port.onmessage({data: 'flush'})
		expect(h.messages.at(-1)).toBe('flushed')
		expect(h.samples()).toHaveLength(1600)
	})

	it('retains the fractional tail across process calls and flushes it before acknowledging stop', () => {
		const h = processor(48000)
		h.instance.process([[new Float32Array([0.25, 0.25])]])
		expect(h.messages).toHaveLength(0)
		h.instance.port.onmessage({data: 'flush'})
		expect(h.samples()).toEqual([8192])
		expect(h.messages.at(-1)).toBe('flushed')
		h.instance.process([[new Float32Array(4800).fill(1)]])
		h.instance.port.onmessage({data: 'flush'})
		expect(h.samples()).toEqual([8192])
	})

	it('resamples a non-integer 44.1 kHz ratio without losing samples across render quanta', () => {
		const h = processor(44100)
		const input = new Float32Array(4410).fill(-0.5)
		for (let offset = 0; offset < input.length; offset += 128) h.instance.process([[input.subarray(offset, offset + 128)]])
		h.instance.port.onmessage({data: 'flush'})
		expect(h.samples()).toHaveLength(1600)
		expect(new Set(h.samples())).toEqual(new Set([-16384]))
		expect(h.messages.filter(message => message instanceof ArrayBuffer).every(message => (message as ArrayBuffer).byteLength <= 3200)).toBe(true)
	})

	it('stops at three unacknowledged frames instead of accumulating audio in MessagePort', () => {
		const h = processor(16000)
		for (let index = 0; index < 3; index++) h.instance.process([[new Float32Array(1600).fill(0.25)]])
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
		expect(h.messages).not.toContain('overflow')
		h.instance.process([[new Float32Array(1600).fill(0.25)]])
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
		expect(h.messages.filter(message => message === 'overflow')).toHaveLength(1)
		for (let index = 0; index < 100; index++) h.instance.process([[new Float32Array(128)]])
		expect(h.messages).toHaveLength(4)
		h.instance.port.onmessage({data: 'ack'})
		h.instance.process([[new Float32Array(1600)]])
		expect(h.messages).toHaveLength(4)
		h.instance.port.onmessage({data: 'flush'})
		expect(h.messages.at(-1)).toBe('flushed')
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
	})

	it('allows acknowledged frames indefinitely while transferring each PCM buffer once', () => {
		const h = processor(16000)
		for (let index = 0; index < 100; index++) {
			h.instance.process([[new Float32Array(1600).fill(0.5)]])
			expect(h.messages).toHaveLength(index + 1)
			expect(h.messages.at(-1)).toBeInstanceOf(ArrayBuffer)
			expect(h.transfers.at(-1)).toEqual([h.messages.at(-1)])
			h.instance.port.onmessage({data: 'ack'})
		}
		h.instance.port.onmessage({data: 'flush'})
		expect(h.messages.at(-1)).toBe('flushed')
		expect(h.messages).not.toContain('overflow')
		expect(h.samples()).toHaveLength(160000)
	})

	it('does not turn stray acknowledgements into credit for an unbounded queue', () => {
		const h = processor(16000)
		for (let index = 0; index < 10; index++) h.instance.port.onmessage({data: 'ack'})
		for (let index = 0; index < 4; index++) h.instance.process([[new Float32Array(1600)]])
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
		expect(h.messages.filter(message => message === 'overflow')).toHaveLength(1)
	})

	it('bounds overflow control messages inside a large render input as well as across calls', () => {
		const h = processor(16000)
		h.instance.process([[new Float32Array(1600 * 50)]])
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
		expect(h.messages.filter(message => message === 'overflow')).toHaveLength(1)
		h.instance.process([[new Float32Array(1600 * 50)]])
		h.instance.port.onmessage({data: 'ack'})
		h.instance.port.onmessage({data: 'flush'})
		expect(h.messages.filter(message => message instanceof ArrayBuffer)).toHaveLength(3)
		expect(h.messages.filter(message => message === 'overflow')).toHaveLength(1)
		expect(h.messages.at(-1)).toBe('flushed')
	})

	it('clips PCM at both signs and keeps silence silent', () => {
		const h = processor(16000)
		h.instance.process([[new Float32Array([-2, -1, 0, 1, 2])]])
		h.instance.port.onmessage({data: 'flush'})
		expect(h.samples()).toEqual([-32768, -32768, 0, 32767, 32767])
	})
})
