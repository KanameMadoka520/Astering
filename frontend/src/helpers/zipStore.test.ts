import {Blob as NodeBlob} from 'node:buffer'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

import {crc32, createStoredZip, dosDateTime, ZipTooLargeError} from './zipStore'

// Keep the browser test setup; Node's Blob supplies arrayBuffer for independent ZIP decoding.
beforeAll(() => vi.stubGlobal('Blob', NodeBlob))
afterAll(() => vi.unstubAllGlobals())

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Entry = {name: string, flags: number, method: number, crc: number, data: Uint8Array}

/** Reads an archive the way an unzip tool does: from the end record through the central directory. */
async function readZip(blob: Blob): Promise<Entry[]> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	const view = new DataView(bytes.buffer)
	const end = bytes.length - 22
	expect(view.getUint32(end, true)).toBe(0x0605_4B50)
	const count = view.getUint16(end + 10, true)
	const centralSize = view.getUint32(end + 12, true)
	let at = view.getUint32(end + 16, true)
	expect(at + centralSize).toBe(end)
	const entries: Entry[] = []
	for (let i = 0; i < count; i++) {
		expect(view.getUint32(at, true)).toBe(0x0201_4B50)
		const nameLength = view.getUint16(at + 28, true)
		const local = view.getUint32(at + 42, true)
		const size = view.getUint32(at + 20, true)
		const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
		// The local header repeats what the directory says.
		expect(view.getUint32(local, true)).toBe(0x0403_4B50)
		expect(view.getUint32(local + 14, true)).toBe(view.getUint32(at + 16, true))
		expect(view.getUint32(local + 18, true)).toBe(size)
		expect(decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength))).toBe(name)
		const start = local + 30 + nameLength + view.getUint16(local + 28, true)
		entries.push({
			name,
			flags: view.getUint16(at + 8, true),
			method: view.getUint16(at + 10, true),
			crc: view.getUint32(at + 16, true),
			data: bytes.slice(start, start + size),
		})
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
	}
	return entries
}

describe('crc32', () => {
	it('matches the standard check value', () => {
		expect(crc32(encoder.encode('123456789'))).toBe(0xCBF4_3926)
		expect(crc32(new Uint8Array(0))).toBe(0)
	})
})

describe('dosDateTime', () => {
	it('packs local time with two-second precision and clamps to 1980', () => {
		expect(dosDateTime(new Date(2026, 10, 1, 13, 45, 31))).toEqual({
			time: (13 << 11) | (45 << 5) | 15,
			date: (46 << 9) | (11 << 5) | 1,
		})
		expect(dosDateTime(new Date(1975, 0, 1))).toEqual({time: 0, date: (1 << 5) | 1})
	})
})

describe('createStoredZip', () => {
	it('stores UTF-8 names and the exact bytes of every file', async () => {
		const markdown = encoder.encode('# 星图\n\n![Map](images/7.webp)\n')
		const picture = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 255, 1, 2])
		const blob = createStoredZip([
			{name: '星图.md', data: markdown},
			{name: 'images/7.webp', data: picture},
		], new Date(2026, 10, 1))

		expect(blob.type).toBe('application/zip')
		const entries = await readZip(blob)
		expect(entries.map(entry => entry.name)).toEqual(['星图.md', 'images/7.webp'])
		for (const entry of entries) {
			expect(entry.flags).toBe(0x0800)
			expect(entry.method).toBe(0)
			expect(entry.crc).toBe(crc32(entry.data))
		}
		expect(decoder.decode(entries[0].data)).toBe('# 星图\n\n![Map](images/7.webp)\n')
		expect(Array.from(entries[1].data)).toEqual(Array.from(picture))
	})

	it('writes a valid empty archive', async () => {
		expect(await readZip(createStoredZip([]))).toEqual([])
	})

	it('refuses names that would leave the folder it is unpacked into', () => {
		for (const name of ['', '/etc/passwd', '../up.md', 'images/../../up.md', 'images//7.webp']) {
			expect(() => createStoredZip([{name, data: new Uint8Array(0)}])).toThrow('Invalid file name')
		}
		expect(() => createStoredZip([{name: 'images\\7.webp', data: new Uint8Array(0)}])).not.toThrow()
	})

	it('refuses more files than the classic format can count', () => {
		const files = Array.from({length: 0x1_0000}, (_, index) => ({name: `${index}.md`, data: new Uint8Array(0)}))
		expect(() => createStoredZip(files)).toThrow(ZipTooLargeError)
	})
})
