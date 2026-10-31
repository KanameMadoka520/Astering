// @vitest-environment jsdom
// happy-dom breaks DOMPurify (empty nodeName via Node.prototype)
import {describe, expect, it} from 'vitest'

import {sanitizeCompass} from './sanitizeCompass'
import {sanitizeAnnouncement} from '@/helpers/sanitizeAnnouncement'

describe('sanitizeCompass', () => {
	it('keeps a body image in canonical form only', () => {
		expect(sanitizeCompass(
			'<img src="https://tracker.example/p.gif" srcset="a.png 2x" style="width:1px" class="x" ' +
			'onerror="alert(1)" data-compass-image="12" alt=" A   map " title="Route" width="800" height="600" loading="lazy">',
		)).toBe('<img data-compass-image="12" alt="A map" title="Route" width="800" height="600">')
	})

	it('drops images that do not name a drive file', () => {
		expect(sanitizeCompass('<p>a<img src="https://example.com/x.png">b</p>')).toBe('<p>ab</p>')
		expect(sanitizeCompass('<img data-compass-image="0"><img data-compass-image="abc">')).toBe('')
		expect(sanitizeCompass('<img src="data:image/png;base64,AAAA" data-compass-image="javascript:1">')).toBe('')
	})

	it('keeps a size only when both sides are valid', () => {
		expect(sanitizeCompass('<img data-compass-image="3" width="800" height="-1">')).toBe('<img data-compass-image="3">')
		expect(sanitizeCompass('<img data-compass-image="3" width="800px" height="600">')).toBe('<img data-compass-image="3">')
	})

	it('keeps text formatting and safe links like the announcement policy', () => {
		expect(sanitizeCompass('<h2>T</h2><p><strong>b</strong> <a href="https://example.com">l</a></p><script>x</script>'))
			.toBe('<h2>T</h2><p><strong>b</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">l</a></p>')
		expect(sanitizeCompass('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
	})

	it('keeps image attributes on images only and leaves the announcement policy without images', () => {
		expect(sanitizeCompass('<p data-compass-image="5" data-x="1" title="t" width="3" height="3">t</p>')).toBe('<p>t</p>')
		expect(sanitizeAnnouncement('<img data-compass-image="5" alt="a">')).toBe('')
	})
})
