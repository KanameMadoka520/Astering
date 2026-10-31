import {queryClient} from '@/client/queryClient'
import {compassImageQuery} from '@/client/queries/compass'
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'

export const COMPASS_IMAGE_STATE = 'data-compass-state'
export type CompassImageState = 'loading' | 'ready' | 'failed'

/**
 * A blob: url for one image, owned by the caller and nobody else: release it with releaseCompassImageUrl.
 * The bytes are cached per space and file, so a body and its editor share one download.
 */
export async function fetchCompassImageUrl(spaceId: number, fileId: number): Promise<string> {
	const context = captureClientRequestContext()
	const blob = await queryClient.fetchQuery(compassImageQuery(spaceId, fileId))
	// The account may have changed while the bytes arrived; they must not show under the new one.
	assertClientRequestContext(context)
	return URL.createObjectURL(blob)
}

/** The bytes themselves, from the same cache; for measuring a picture before it goes into a body. */
export async function fetchCompassImageBlob(spaceId: number, fileId: number): Promise<Blob> {
	const context = captureClientRequestContext()
	const blob = await queryClient.fetchQuery(compassImageQuery(spaceId, fileId))
	assertClientRequestContext(context)
	return blob
}

export function releaseCompassImageUrl(url: string | null | undefined) {
	if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** Pixel size of an image; zeros when the browser cannot decode it (the image is then shown without a ratio). */
export async function measureCompassImage(blob: Blob): Promise<{width: number, height: number}> {
	if (typeof createImageBitmap !== 'function') return {width: 0, height: 0}
	try {
		const bitmap = await createImageBitmap(blob)
		try {
			return {
				width: bitmap.width,
				height: bitmap.height,
			}
		} finally {
			bitmap.close()
		}
	} catch {
		return {width: 0, height: 0}
	}
}

/** Body images under `root` still on their way. */
export function pendingCompassImages(root: ParentNode = document): number {
	return root.querySelectorAll(`img[${COMPASS_IMAGE_STATE}="loading"]`).length
}

/**
 * Resolves once every body image under `root` has loaded or failed, or after `timeout` ms. True when
 * nothing is still loading; printing waits for this so paper never shows empty frames.
 */
export function waitForCompassImages(root: ParentNode = document, timeout = 15_000): Promise<boolean> {
	if (pendingCompassImages(root) === 0) return Promise.resolve(true)
	return new Promise(resolve => {
		const observer = new MutationObserver(() => {
			if (pendingCompassImages(root) > 0) return
			finish(true)
		})
		const timer = setTimeout(() => finish(pendingCompassImages(root) === 0), timeout)
		function finish(done: boolean) {
			observer.disconnect()
			clearTimeout(timer)
			resolve(done)
		}
		observer.observe(root instanceof Document ? root.documentElement : root as Node, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [COMPASS_IMAGE_STATE],
		})
	})
}
