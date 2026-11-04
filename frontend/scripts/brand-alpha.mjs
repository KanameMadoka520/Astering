import {Buffer} from 'node:buffer'

const MAX_PIXELS = 2048 * 2048

// Asset-export normalization only: retain every original RGBA value in the largest
// 8-connected nonzero-alpha component, including soft edges and transparent holes.
// The source master is never modified. Limit work and scratch memory for offline builds.
export function keepLargestAlphaComponent(input, width, height) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
		|| width * height > MAX_PIXELS || input.length !== width * height * 4) {
		throw new RangeError('Brand master must be RGBA and contain at most 2048 × 2048 pixels')
	}
	const pixelCount = width * height
	const labels = new Uint32Array(pixelCount)
	const queue = new Uint32Array(pixelCount)
	let nextLabel = 0
	let largestLabel = 0
	let largestSize = 0
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		if (input[pixel * 4 + 3] === 0 || labels[pixel] !== 0) continue
		const label = ++nextLabel
		let head = 0
		let tail = 1
		queue[0] = pixel
		labels[pixel] = label
		while (head < tail) {
			const current = queue[head++]
			const x = current % width
			const y = Math.floor(current / width)
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy
				if (ny < 0 || ny >= height) continue
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx
					if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue
					const neighbor = ny * width + nx
					if (labels[neighbor] !== 0 || input[neighbor * 4 + 3] === 0) continue
					labels[neighbor] = label
					queue[tail++] = neighbor
				}
			}
		}
		if (tail > largestSize) {
			largestSize = tail
			largestLabel = label
		}
	}
	const data = Buffer.from(input)
	let removedPixels = 0
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		if (input[pixel * 4 + 3] !== 0 && labels[pixel] !== largestLabel) {
			data[pixel * 4 + 3] = 0
			removedPixels++
		}
	}
	return {
		data,
		removedPixels,
	}
}
