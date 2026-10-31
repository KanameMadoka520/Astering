import {beforeEach, describe, expect, it, vi} from 'vitest'

const images = vi.hoisted(() => ({fetchCompassImage: vi.fn()}))
vi.mock('@/client/queries/compass', () => images)

import {buildCompassBundle, COMPASS_BUNDLE_MAX_BYTES, compassBodiesImageIds} from './exportBundle'
import type {MarkdownImageOptions} from './htmlToMarkdown'
import {ZipTooLargeError} from '@/helpers/zipStore'

const decoder = new TextDecoder()

// File names from the central directory, in archive order.
async function zipNames(blob: Blob): Promise<string[]> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	const view = new DataView(bytes.buffer)
	const end = bytes.length - 22
	let at = view.getUint32(end + 16, true)
	const names: string[] = []
	for (let i = 0; i < view.getUint16(end + 10, true); i++) {
		const length = view.getUint16(at + 28, true)
		names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + length)))
		at += 46 + length
	}
	return names
}

function picture(type: string) {
	return new Blob([new Uint8Array([1, 2, 3])], {type})
}

// Writes each image as the markdown would, so the test sees which ones made it in.
function markdown(ids: number[]) {
	return (options: MarkdownImageOptions) => ids
		.map(id => options.src(id) ?? options.missing({fileId: id, alt: `alt ${id}`, title: '', width: 0, height: 0}))
		.join('\n')
}

beforeEach(() => {
	images.fetchCompassImage.mockReset()
})

describe('compassBodiesImageIds', () => {
	it('lists each image of several bodies once, in reading order', () => {
		expect(compassBodiesImageIds([
			'<img data-compass-image="4"><img data-compass-image="2">',
			'<p>none</p>',
			'<img data-compass-image="2"><img data-compass-image="9">',
		])).toEqual([4, 2, 9])
	})
})

describe('buildCompassBundle', () => {
	it('puts the Markdown first and every readable image after it, describing the rest', async () => {
		images.fetchCompassImage.mockImplementation(async (_space: number, id: number) => {
			if (id === 5) throw new Error('gone')
			return picture(id === 4 ? 'image/png' : 'image/webp')
		})
		const progress: [number, number][] = []

		const bundle = await buildCompassBundle({
			spaceId: 3,
			baseName: '星图',
			imageIds: [4, 5, 6],
			markdown: markdown([4, 5, 6]),
			missing: image => `missing ${image.alt}`,
			signal: new AbortController().signal,
			onProgress: (done, total) => progress.push([done, total]),
		})

		expect(bundle.filename).toBe('星图.zip')
		expect(bundle.images).toBe(2)
		expect(bundle.missing).toBe(1)
		expect(await zipNames(bundle.blob)).toEqual(['星图.md', 'images/4.png', 'images/6.webp'])
		expect(images.fetchCompassImage.mock.calls.map(call => call.slice(0, 2))).toEqual([[3, 4], [3, 5], [3, 6]])
		expect(progress[0]).toEqual([0, 3])
		expect(progress.at(-1)).toEqual([3, 3])
	})

	it('stops when cancelled instead of saving a partial archive', async () => {
		const controller = new AbortController()
		images.fetchCompassImage.mockImplementation((_space: number, _id: number, signal: AbortSignal) =>
			new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))

		const bundle = buildCompassBundle({
			spaceId: 3,
			baseName: 'North',
			imageIds: [1, 2],
			markdown: markdown([1, 2]),
			missing: () => '',
			signal: controller.signal,
		})
		controller.abort()

		await expect(bundle).rejects.toMatchObject({name: 'AbortError'})
	})

	it('stops reading once the pictures pass the memory bound', async () => {
		const half = COMPASS_BUNDLE_MAX_BYTES / 2 + 1
		const signals: AbortSignal[] = []
		images.fetchCompassImage.mockImplementation((_space: number, id: number, signal: AbortSignal) => {
			signals.push(signal)
			if (id === 3) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
			// Only the size is looked at before the bytes are copied.
			return Promise.resolve({size: half, type: 'image/webp', arrayBuffer: async () => new ArrayBuffer(1)})
		})

		await expect(buildCompassBundle({
			spaceId: 3,
			baseName: 'North',
			imageIds: [1, 2, 3],
			markdown: markdown([1, 2, 3]),
			missing: () => '',
			signal: new AbortController().signal,
		})).rejects.toBeInstanceOf(ZipTooLargeError)
		expect(signals.every(signal => signal.aborted)).toBe(true)
	})
})
