import {describe, expect, it} from 'vitest'

import {
	clipCompassImageText,
	compassImageAttributes,
	compassImageExtension,
	compassImageIds,
	compassUploadedSize,
	isCompassImageType,
	isUploadableCompassImage,
	parseCompassImageId,
	readCompassImage,
} from './images'

const WEBP = {mode: 'webp', quality: 0.85, maxSide: 2560} as const
const ORIGINAL = {mode: 'original', quality: 1, maxSide: 0} as const

describe('parseCompassImageId', () => {
	it('accepts positive decimal ids only', () => {
		expect(parseCompassImageId('12')).toBe(12)
		expect(parseCompassImageId('0')).toBeNull()
		expect(parseCompassImageId('012')).toBeNull()
		expect(parseCompassImageId('-1')).toBeNull()
		expect(parseCompassImageId('1e3')).toBeNull()
		expect(parseCompassImageId(' 12')).toBeNull()
		expect(parseCompassImageId(12)).toBeNull()
		expect(parseCompassImageId(null)).toBeNull()
	})

	it('refuses ids beyond the safe integer range instead of rounding them to another file', () => {
		expect(parseCompassImageId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
		expect(parseCompassImageId('9007199254740993')).toBeNull()
	})
})

describe('clipCompassImageText', () => {
	it('collapses whitespace and keeps surrogate pairs whole at the limit', () => {
		expect(clipCompassImageText('  a \n b  ')).toBe('a b')
		const clipped = clipCompassImageText('😀'.repeat(501))
		expect(Array.from(clipped)).toHaveLength(500)
		expect(clipped.endsWith('😀')).toBe(true)
		expect(clipCompassImageText(undefined)).toBe('')
	})
})

describe('image types', () => {
	it('allows only raster types a browser draws safely', () => {
		expect(isCompassImageType('image/webp')).toBe(true)
		expect(isCompassImageType('IMAGE/PNG; charset=binary')).toBe(true)
		expect(isCompassImageType('image/svg+xml')).toBe(false)
		expect(isCompassImageType('image/bmp')).toBe(false)
		expect(isCompassImageType(undefined)).toBe(false)
	})

	it('lets the WebP choice bring in formats it converts, but not SVG', () => {
		expect(isUploadableCompassImage({type: 'image/bmp'}, WEBP)).toBe(true)
		expect(isUploadableCompassImage({type: 'image/bmp'}, ORIGINAL)).toBe(false)
		expect(isUploadableCompassImage({type: 'image/svg+xml'}, WEBP)).toBe(false)
		expect(isUploadableCompassImage({type: 'image/gif'}, null)).toBe(true)
	})

	it('scales the stored size like the WebP conversion does', () => {
		expect(compassUploadedSize(5120, 2560, {type: 'image/jpeg'}, WEBP)).toEqual({width: 2560, height: 1280})
		expect(compassUploadedSize(5120, 2560, {type: 'image/gif'}, WEBP)).toEqual({width: 5120, height: 2560})
		expect(compassUploadedSize(5120, 2560, {type: 'image/jpeg'}, ORIGINAL)).toEqual({width: 5120, height: 2560})
		expect(compassUploadedSize(0, 10, {type: 'image/png'}, WEBP)).toEqual({width: 0, height: 0})
	})

	it('names exported files after their type', () => {
		expect(compassImageExtension('image/jpeg')).toBe('jpg')
		expect(compassImageExtension('image/webp')).toBe('webp')
		expect(compassImageExtension('application/octet-stream')).toBe('bin')
	})
})

describe('compassImageIds', () => {
	it('lists distinct ids in reading order', () => {
		expect(compassImageIds(
			'<img data-compass-image="7"><p>x</p><img data-compass-image="3" alt="a"><img data-compass-image="7">',
		)).toEqual([7, 3])
		expect(compassImageIds('<p>no images</p>')).toEqual([])
		expect(compassImageIds('<img data-compass-image="0">')).toEqual([])
	})
})

describe('canonical attributes', () => {
	it('writes the id first and leaves empty or one-sided values out', () => {
		expect(compassImageAttributes({fileId: 5, alt: ' A  cat ', title: '', width: 640, height: 0})).toEqual({
			'data-compass-image': '5',
			alt: 'A cat',
		})
		expect(compassImageAttributes({fileId: 5, width: 640.4, height: 480})).toEqual({
			'data-compass-image': '5',
			width: '640',
			height: '480',
		})
		expect(compassImageAttributes({fileId: 5, width: 100_000, height: 10})).toEqual({'data-compass-image': '5'})
	})

	it('reads an element back and needs both sides for a size', () => {
		const element = document.createElement('img')
		element.setAttribute('data-compass-image', '42')
		element.setAttribute('alt', 'Map')
		element.setAttribute('title', 'Route')
		element.setAttribute('width', '800')
		expect(readCompassImage(element)).toEqual({fileId: 42, alt: 'Map', title: 'Route', width: 0, height: 0})
		element.setAttribute('height', '600')
		expect(readCompassImage(element)).toMatchObject({width: 800, height: 600})
		element.setAttribute('data-compass-image', 'x')
		expect(readCompassImage(element)).toBeNull()
	})
})
