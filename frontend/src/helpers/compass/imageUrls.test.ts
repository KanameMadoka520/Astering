import {describe, expect, it, vi} from 'vitest'
import {COMPASS_IMAGE_STATE, deferCompassImage, loadDeferredCompassImages, pendingCompassImages} from './imageUrls'

function waitingImage(parent: Element) {
	const image = document.createElement('img')
	image.setAttribute(COMPASS_IMAGE_STATE, 'deferred')
	parent.append(image)
	return image
}

describe('deferred compass images', () => {
	it('starts the waiting images under a root once, and leaves the others', () => {
		const printed = document.createElement('article')
		const other = document.createElement('aside')
		document.body.append(printed, other)
		const inside = vi.fn()
		const outside = vi.fn()
		deferCompassImage(waitingImage(printed), inside)
		deferCompassImage(waitingImage(other), outside)

		expect(pendingCompassImages(printed)).toBe(1)
		loadDeferredCompassImages(printed)
		loadDeferredCompassImages(printed)

		expect(inside).toHaveBeenCalledTimes(1)
		expect(outside).not.toHaveBeenCalled()
		document.body.innerHTML = ''
	})

	it('forgets an image whose view went away', () => {
		const body = document.createElement('article')
		document.body.append(body)
		const start = vi.fn()
		const forget = deferCompassImage(waitingImage(body), start)

		forget()
		loadDeferredCompassImages(body)

		expect(start).not.toHaveBeenCalled()
		document.body.innerHTML = ''
	})
})
