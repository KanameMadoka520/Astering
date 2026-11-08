/* global AudioWorkletProcessor, sampleRate, registerProcessor */
/* AudioWorklet runs on the audio thread; only one short PCM frame is retained. */
class LivePcmCapture extends AudioWorkletProcessor {
	constructor(options) {
		super()
		this.rate = options.processorOptions.rate
		this.ratio = sampleRate / this.rate
		this.frame = new Int16Array(Math.round(this.rate / 10))
		this.position = 0
		this.sum = 0
		this.weight = 0
		this.running = true
		this.outstanding = 0
		this.port.onmessage = event => {
			if (event.data === 'ack') {
				this.outstanding = Math.max(0, this.outstanding - 1)
				return
			}
			if (event.data !== 'flush') return
			this.running = false
			// The last render quantum may end before a complete resampling interval.
			if (this.weight > 1e-8) {
				this.appendSample(this.sum / this.weight)
				this.weight = 0
				this.sum = 0
			}
			this.emitFrame()
			this.port.postMessage('flushed')
		}
	}
	appendSample(sample) {
		const value = Math.max(-1, Math.min(1, sample))
		this.frame[this.position++] = Math.round(value * (value < 0 ? 32768 : 32767))
		if (this.position === this.frame.length) this.emitFrame()
	}
	emitFrame() {
		if (!this.position) return
		// A suspended main thread cannot drain MessagePort; stop instead of building an unbounded audio queue there.
		if (this.outstanding >= 3) {
			this.position = 0
			this.running = false
			this.port.postMessage('overflow')
			return
		}
		const bytes = new ArrayBuffer(this.position * 2)
		const view = new DataView(bytes)
		for (let index = 0; index < this.position; index++) view.setInt16(index * 2, this.frame[index], true)
		this.port.postMessage(bytes, [bytes])
		this.outstanding++
		this.position = 0
	}
	process(inputs) {
		const channels = inputs[0]
		if (!this.running || !channels?.length) return true
		for (let index = 0; index < channels[0].length; index++) {
			let sample = 0
			for (const channel of channels) sample += channel[index] / channels.length
			let remaining = 1
			while (remaining > 1e-8) {
				const take = Math.min(remaining, this.ratio - this.weight)
				this.sum += sample * take
				this.weight += take
				remaining -= take
				if (this.weight + 1e-8 >= this.ratio) {
					this.appendSample(this.sum / this.ratio)
					this.sum = 0
					this.weight = 0
					if (!this.running) return true
				}
			}
		}
		return true
	}
}

registerProcessor('astering-live-pcm', LivePcmCapture)
