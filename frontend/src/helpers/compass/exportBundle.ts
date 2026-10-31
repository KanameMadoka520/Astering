import {fetchCompassImage} from '@/client/queries/compass'
import {isRequestContextAbort} from '@/client/requestContext'
import {createStoredZip, ZipTooLargeError, type ZipFile} from '@/helpers/zipStore'
import {compassImageExtension, compassImageIds, type CompassImageRef} from './images'
import type {MarkdownImageOptions} from './htmlToMarkdown'

export type CompassBundle = {
	blob: Blob
	filename: string
	images: number
	// Images that could not be read and are described in the text instead.
	missing: number
}

/**
 * The pictures of one archive, together. The browser holds them and then the archive in memory, so an export
 * past this stops early and suggests Markdown without pictures instead.
 */
export const COMPASS_BUNDLE_MAX_BYTES = 512 * 1024 * 1024

/** Distinct images of several bodies, in reading order. */
export function compassBodiesImageIds(bodies: readonly string[]): number[] {
	const ids: number[] = []
	const seen = new Set<number>()
	for (const body of bodies) {
		for (const id of compassImageIds(body)) {
			if (seen.has(id)) continue
			seen.add(id)
			ids.push(id)
		}
	}
	return ids
}

/**
 * Reads every image once through the space and builds a ZIP with the Markdown and an `images/` folder.
 * An image that cannot be read (removed, or no longer shared with you) is described in the text; the export
 * still completes. Aborting the signal stops it. Throws ZipTooLargeError as soon as the pictures read so far
 * pass COMPASS_BUNDLE_MAX_BYTES, and cancels the reads still running.
 */
export async function buildCompassBundle(options: {
	spaceId: number
	baseName: string
	imageIds: readonly number[]
	markdown: (images: MarkdownImageOptions) => string
	missing: (image: CompassImageRef) => string
	signal: AbortSignal
	onProgress?: (done: number, total: number) => void
}): Promise<CompassBundle> {
	const {spaceId, imageIds, signal} = options
	const paths = new Map<number, string>()
	const files: ZipFile[] = []
	let done = 0
	let bytes = 0
	// Stops the other reads once the archive is known to be too large, as well as when the caller cancels.
	const reads = new AbortController()
	const stop = () => reads.abort(signal.reason)
	signal.throwIfAborted()
	signal.addEventListener('abort', stop, {once: true})
	options.onProgress?.(0, imageIds.length)
	let results: {id: number, data: Uint8Array<ArrayBuffer> | null, type: string}[]
	try {
		// The space's image reads are limited to a few at a time already; order in the archive follows the text.
		results = await Promise.all(imageIds.map(async id => {
			try {
				const blob = await fetchCompassImage(spaceId, id, reads.signal)
				bytes += blob.size
				if (bytes > COMPASS_BUNDLE_MAX_BYTES) throw new ZipTooLargeError()
				const data = new Uint8Array(await blob.arrayBuffer())
				return {id, data, type: blob.type}
			} catch (cause) {
				if (cause instanceof ZipTooLargeError) {
					reads.abort(cause)
					throw cause
				}
				if (reads.signal.aborted || isRequestContextAbort(cause)) throw cause
				return {id, data: null, type: ''}
			} finally {
				done++
				if (!reads.signal.aborted) options.onProgress?.(done, imageIds.length)
			}
		}))
	} finally {
		signal.removeEventListener('abort', stop)
	}
	signal.throwIfAborted()
	for (const {id, data, type} of results) {
		if (data === null) continue
		const name = `images/${id}.${compassImageExtension(type)}`
		paths.set(id, name)
		files.push({name, data})
	}
	const markdown = options.markdown({
		src: fileId => paths.get(fileId) ?? null,
		missing: options.missing,
	})
	const encoded = new TextEncoder().encode(markdown)
	const blob = createStoredZip([{name: `${options.baseName}.md`, data: encoded}, ...files])
	return {
		blob,
		filename: `${options.baseName}.zip`,
		images: files.length,
		missing: imageIds.length - files.length,
	}
}
