import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {test} from 'node:test'
import {keepLargestAlphaComponent} from './brand-alpha.mjs'

test('removes only disconnected alpha fragments and preserves the master, holes and soft edges', () => {
	const width = 9
	const height = 9
	const master = Buffer.alloc(width * height * 4)
	const set = (x, y, alpha) => master.set([221, 173, 61, alpha], (y * width + x) * 4)
	for (let y = 2; y <= 6; y++) {
		for (let x = 2; x <= 6; x++) set(x, y, 255)
	}
	set(4, 4, 0) // An eye/negative space stays transparent.
	set(1, 1, 1) // A diagonal antialias pixel belongs to the star.
	set(0, 8, 255) // A distant opaque fragment is noise too.
	set(8, 0, 2)
	const original = Buffer.from(master)
	const normalized = keepLargestAlphaComponent(master, width, height)
	assert.equal(normalized.removedPixels, 2)
	assert.deepEqual(master, original)
	for (let pixel = 0; pixel < width * height; pixel++) {
		const offset = pixel * 4
		assert.deepEqual(normalized.data.subarray(offset, offset + 3), master.subarray(offset, offset + 3))
		if (pixel === 8 * width || pixel === 8) assert.equal(normalized.data[offset + 3], 0)
		else assert.equal(normalized.data[offset + 3], master[offset + 3])
	}
})

test('transparent masters remain unchanged and oversized/invalid inputs fail before allocation', () => {
	const empty = Buffer.alloc(16)
	assert.deepEqual(keepLargestAlphaComponent(empty, 2, 2), {
		data: empty,
		removedPixels: 0,
	})
	assert.throws(() => keepLargestAlphaComponent(Buffer.alloc(0), 2049, 2049), RangeError)
	assert.throws(() => keepLargestAlphaComponent(Buffer.alloc(3), 1, 1), RangeError)
})
