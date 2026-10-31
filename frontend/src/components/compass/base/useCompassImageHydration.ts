import {onBeforeUnmount, watch, type Ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {
	COMPASS_IMAGE_STATE,
	fetchCompassImageUrl,
	releaseCompassImageUrl,
	type CompassImageState,
} from '@/helpers/compass/imageUrls'
import {COMPASS_IMAGE_ATTRIBUTE, readCompassImage, type CompassImageRef} from '@/helpers/compass/images'

/**
 * Fills the src of every body image rendered under `root` from the space's authorized image route.
 * The markup itself never carries a URL. Each render gets fresh blob: urls, released when the markup
 * changes or the view goes away. A failed image keeps its frame and says why it is missing.
 */
export function useCompassImageHydration(
	root: Ref<HTMLElement | null | undefined>,
	spaceId: () => number,
	html: () => string,
) {
	const {t} = useI18n({useScope: 'global'})
	let urls: string[] = []
	let generation = 0

	function releaseAll() {
		generation++
		urls.forEach(releaseCompassImageUrl)
		urls = []
	}

	function setState(image: HTMLImageElement, state: CompassImageState) {
		image.setAttribute(COMPASS_IMAGE_STATE, state)
	}

	// `alt` is the stored text, not the generic label an unnamed image is read out with.
	function markMissing(image: HTMLImageElement, alt: string) {
		setState(image, 'failed')
		image.removeAttribute('src')
		const frame = image.parentElement
		if (!frame || frame.querySelector('.compass-figure__missing')) return
		const note = document.createElement('span')
		note.className = 'compass-figure__missing'
		note.textContent = alt
			? t('compass.images.unavailableNamed', {alt})
			: t('compass.images.unavailable')
		frame.insertBefore(note, image.nextSibling)
	}

	async function load(image: HTMLImageElement, space: number, ref: CompassImageRef, current: number) {
		let url: string
		try {
			url = await fetchCompassImageUrl(space, ref.fileId)
		} catch {
			if (current === generation && image.isConnected) markMissing(image, ref.alt)
			return
		}
		if (current !== generation || !image.isConnected) {
			releaseCompassImageUrl(url)
			return
		}
		urls.push(url)
		image.addEventListener('load', () => setState(image, 'ready'), {once: true})
		image.addEventListener('error', () => markMissing(image, ref.alt), {once: true})
		image.src = url
	}

	function hydrate() {
		releaseAll()
		const element = root.value
		const space = spaceId()
		if (!element) return
		const current = generation
		element.querySelectorAll<HTMLImageElement>(`img[${COMPASS_IMAGE_ATTRIBUTE}]`).forEach(image => {
			const ref = readCompassImage(image)
			if (ref === null) return
			// The frame takes its final size before the bytes arrive, so the text below never jumps.
			if (ref.width && ref.height) {
				image.style.aspectRatio = `${ref.width} / ${ref.height}`
				image.style.inlineSize = `min(100%, ${ref.width}px)`
			}
			image.decoding = 'async'
			// A caption already names the picture; without either, the reader still hears that one is there.
			if (!image.hasAttribute('alt')) image.alt = ref.title ? '' : t('compass.images.unnamed')
			if (space <= 0) {
				markMissing(image, ref.alt)
				return
			}
			setState(image, 'loading')
			void load(image, space, ref, current)
		})
	}

	// Post-flush: v-html has replaced the markup by then.
	watch([html, spaceId, root], hydrate, {flush: 'post', immediate: true})
	onBeforeUnmount(releaseAll)
}
