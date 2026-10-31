import type {ImageChoice} from '@/helpers/uploadTransport'

/**
 * Body images are stored as `<img data-compass-image="{drive file id}" alt title width height>`, never with a
 * src: the reader fetches the bytes through the space's own authorized route. The server applies the same
 * rules (v33 contract A2); these mirror them so the editor never produces something a save would reject.
 */
export const COMPASS_IMAGE_ATTRIBUTE = 'data-compass-image'

// The server only mounts these; SVG and formats a browser cannot draw never reach a reader.
export const COMPASS_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

// The WebP choice converts these in the browser (helpers/uploadTransport.ts convertImage).
const CONVERTIBLE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp']

export const COMPASS_IMAGE_LIMITS = {
	// Distinct images per entry body.
	perEntry: 100,
	// Characters of alt text and of a caption.
	text: 500,
	// Width and height are layout hints only.
	dimension: 99_999,
} as const

const FILE_ID = /^[1-9][0-9]{0,18}$/
const DIMENSION = /^[1-9][0-9]{0,4}$/

export type CompassImageRef = {
	fileId: number
	alt: string
	// Shown as the caption.
	title: string
	width: number
	height: number
}

/** A drive file id from an attribute value, or null. Ids beyond the safe integer range cannot be addressed. */
export function parseCompassImageId(value: unknown): number | null {
	if (typeof value !== 'string' || !FILE_ID.test(value)) return null
	const id = Number(value)
	return Number.isSafeInteger(id) ? id : null
}

export function parseCompassImageDimension(value: unknown): number {
	return typeof value === 'string' && DIMENSION.test(value) ? Number(value) : 0
}

/** Cuts at a character boundary, so a surrogate pair is never split. */
export function clipCompassImageText(value: unknown): string {
	if (typeof value !== 'string') return ''
	const characters = Array.from(value.replace(/\s+/g, ' ').trim())
	return characters.length > COMPASS_IMAGE_LIMITS.text
		? characters.slice(0, COMPASS_IMAGE_LIMITS.text).join('')
		: characters.join('')
}

export function isCompassImageType(mime: string | null | undefined): boolean {
	const type = (mime ?? '').split(';')[0].trim().toLowerCase()
	return (COMPASS_IMAGE_TYPES as readonly string[]).includes(type)
}

/** Whether a picked file will arrive as a supported image after the chosen upload format. */
export function isUploadableCompassImage(file: Pick<File, 'type'>, choice: ImageChoice | null): boolean {
	const type = file.type.toLowerCase()
	if (choice?.mode === 'webp' && CONVERTIBLE_TYPES.includes(type)) return true
	return isCompassImageType(type)
}

/** The size an image will have after the upload choice, scaled the same way convertImage does. */
export function compassUploadedSize(width: number, height: number, file: Pick<File, 'type'>, choice: ImageChoice | null): {width: number, height: number} {
	if (width <= 0 || height <= 0) return {width: 0, height: 0}
	const converted = choice?.mode === 'webp' && CONVERTIBLE_TYPES.includes(file.type.toLowerCase())
	const scale = converted && choice.maxSide ? Math.min(1, choice.maxSide / Math.max(width, height)) : 1
	return {
		width: Math.min(COMPASS_IMAGE_LIMITS.dimension, Math.max(1, Math.round(width * scale))),
		height: Math.min(COMPASS_IMAGE_LIMITS.dimension, Math.max(1, Math.round(height * scale))),
	}
}

const ID_IN_HTML = /data-compass-image="([1-9][0-9]{0,18})"/g

/**
 * Distinct image ids of a stored or editor body, in order. Bodies come from the editor or the server, both in
 * canonical form, so a scan is enough; it runs while typing, where parsing megabytes would not be.
 */
export function compassImageIds(html: string): number[] {
	if (!html.includes(COMPASS_IMAGE_ATTRIBUTE)) return []
	const ids: number[] = []
	const seen = new Set<number>()
	for (const match of html.matchAll(ID_IN_HTML)) {
		const id = parseCompassImageId(match[1])
		if (id === null || seen.has(id)) continue
		seen.add(id)
		ids.push(id)
	}
	return ids
}

export function hasCompassImages(html: string): boolean {
	return compassImageIds(html).length > 0
}

/** The canonical attributes of one image, in a stable order; empty values are left out. */
export function compassImageAttributes(image: Partial<CompassImageRef> & {fileId: number}): Record<string, string> {
	const attributes: Record<string, string> = {[COMPASS_IMAGE_ATTRIBUTE]: String(image.fileId)}
	const alt = clipCompassImageText(image.alt)
	const title = clipCompassImageText(image.title)
	if (alt !== '') attributes.alt = alt
	if (title !== '') attributes.title = title
	if (image.width && image.height && image.width <= COMPASS_IMAGE_LIMITS.dimension && image.height <= COMPASS_IMAGE_LIMITS.dimension) {
		attributes.width = String(Math.round(image.width))
		attributes.height = String(Math.round(image.height))
	}
	return attributes
}

/** Reads a canonical image element back; null when it carries no usable id. */
export function readCompassImage(element: Element): CompassImageRef | null {
	const fileId = parseCompassImageId(element.getAttribute(COMPASS_IMAGE_ATTRIBUTE))
	if (fileId === null) return null
	const width = parseCompassImageDimension(element.getAttribute('width'))
	const height = parseCompassImageDimension(element.getAttribute('height'))
	return {
		fileId,
		alt: clipCompassImageText(element.getAttribute('alt')),
		title: clipCompassImageText(element.getAttribute('title')),
		// A ratio needs both sides.
		width: width && height ? width : 0,
		height: width && height ? height : 0,
	}
}

/** File extension for an exported image, from its type. */
export function compassImageExtension(mime: string): string {
	switch (mime.split(';')[0].trim().toLowerCase()) {
		case 'image/jpeg':
			return 'jpg'
		case 'image/png':
			return 'png'
		case 'image/gif':
			return 'gif'
		case 'image/webp':
			return 'webp'
		default:
			return 'bin'
	}
}
