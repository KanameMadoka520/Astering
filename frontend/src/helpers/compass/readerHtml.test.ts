// @vitest-environment jsdom
// happy-dom breaks DOMPurify (empty nodeName via Node.prototype)
import {describe, expect, it} from 'vitest'

import {
	compassPlainText,
	estimateCompassReadingMinutes,
	prepareCompassHtml,
} from './readerHtml'

describe('prepareCompassHtml', () => {
	it('anchors h1 to h4 in reading order and skips empty headings', () => {
		const prepared = prepareCompassHtml(
			'<h2>Plan</h2><p>Text</p><h3> Deep \n  dive </h3><h5>Small</h5><h1></h1><h4>Last <em>step</em></h4>',
		)

		expect(prepared.headings).toEqual([
			{id: 'compass-section-1', level: 2, text: 'Plan'},
			{id: 'compass-section-2', level: 3, text: 'Deep dive'},
			{id: 'compass-section-3', level: 4, text: 'Last step'},
		])
		expect(prepared.html).toBe(
			'<h2 id="compass-section-1">Plan</h2><p>Text</p><h3 id="compass-section-2"> Deep \n  dive </h3>' +
			'<h5>Small</h5><h1></h1><h4 id="compass-section-3">Last <em>step</em></h4>',
		)
	})

	it('drops authored ids, so only our anchors exist', () => {
		const prepared = prepareCompassHtml('<h2 id="compass-section-2">A</h2><p id="compass-section-1">b</p>')

		expect(prepared.html).toBe('<h2 id="compass-section-1">A</h2><p>b</p>')
	})

	it('uses the given prefix, so two bodies on one page cannot share ids', () => {
		expect(prepareCompassHtml('<h2>A</h2>', 'revision-3').headings[0].id).toBe('revision-3-1')
	})

	it('renders only the announcement allow-list', () => {
		const prepared = prepareCompassHtml(
			'<p onclick="steal()">safe</p><script>steal()</script><img src="https://tracker.example/p.png">' +
			'<p style="position:fixed" class="button">styled</p><a href="javascript:steal()">bad</a>',
		)

		expect(prepared.html).toBe('<p>safe</p><p>styled</p><a>bad</a>')
		expect(prepared.headings).toEqual([])
	})

	it('opens links in a new tab without opener', () => {
		const prepared = prepareCompassHtml('<p><a href="https://example.com/">site</a></p>')

		expect(prepared.html).toBe(
			'<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow">site</a></p>',
		)
	})
})

describe('compassPlainText', () => {
	it('gives one line per block and drops empty ones', () => {
		expect(compassPlainText(
			'<h2>Title</h2><p>a <strong>b</strong></p><p>&nbsp;</p><ul><li><p>x</p></li></ul><script>hidden()</script>',
		)).toBe('Title\na b\nx')
		expect(compassPlainText('<p></p>')).toBe('')
		expect(compassPlainText('')).toBe('')
	})
})

describe('estimateCompassReadingMinutes', () => {
	it('gives no estimate for a text without words', () => {
		expect(estimateCompassReadingMinutes('')).toBe(0)
		expect(estimateCompassReadingMinutes(' \n ')).toBe(0)
		expect(estimateCompassReadingMinutes('。，—— !?')).toBe(0)
	})

	it('rounds a short text up to one minute', () => {
		expect(estimateCompassReadingMinutes('Hi')).toBe(1)
		expect(estimateCompassReadingMinutes('星')).toBe(1)
	})

	it('reads about 220 words a minute', () => {
		expect(estimateCompassReadingMinutes('word '.repeat(220))).toBe(1)
		expect(estimateCompassReadingMinutes('word '.repeat(221))).toBe(2)
	})

	it('reads about 400 CJK characters a minute, kana and hangul included', () => {
		expect(estimateCompassReadingMinutes('星'.repeat(400))).toBe(1)
		expect(estimateCompassReadingMinutes('星'.repeat(401))).toBe(2)
		// Unspaced kana would count as a single word if it were not counted per character.
		expect(estimateCompassReadingMinutes('あ'.repeat(401))).toBe(2)
		expect(estimateCompassReadingMinutes('한'.repeat(401))).toBe(2)
	})

	it('adds both rates up in mixed text', () => {
		expect(estimateCompassReadingMinutes(`${'星'.repeat(200)} ${'word '.repeat(110)}`)).toBe(1)
		expect(estimateCompassReadingMinutes(`${'星'.repeat(201)} ${'word '.repeat(110)}`)).toBe(2)
		expect(estimateCompassReadingMinutes(`${'星'.repeat(200)}word`.repeat(4))).toBe(3)
	})
})
