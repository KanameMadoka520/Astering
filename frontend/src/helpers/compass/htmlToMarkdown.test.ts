// @vitest-environment jsdom
// happy-dom breaks DOMPurify (empty nodeName via Node.prototype)
import {describe, expect, it} from 'vitest'

import {htmlToMarkdown} from './htmlToMarkdown'

describe('htmlToMarkdown', () => {
	it('returns nothing for an empty or emptied body', () => {
		expect(htmlToMarkdown('')).toBe('')
		expect(htmlToMarkdown('  \n ')).toBe('')
		expect(htmlToMarkdown('<p></p><p>&nbsp;</p>')).toBe('')
	})

	it('converts headings and inline formatting', () => {
		expect(htmlToMarkdown(
			'<h1>Title</h1><h3>Sub</h3><h6>Six</h6><p><strong>bold</strong>, <em>italic</em>, <s>gone</s>, ' +
			'<u>under</u>, <mark>hi</mark>, H<sub>2</sub>O, x<sup>2</sup> and <code>a*b</code></p>',
		)).toBe(
			'# Title\n\n### Sub\n\n###### Six\n\n' +
			'**bold**, *italic*, ~~gone~~, <u>under</u>, <mark>hi</mark>, H<sub>2</sub>O, x<sup>2</sup> and `a*b`\n',
		)
	})

	it('keeps emphasis markers against the text they wrap', () => {
		expect(htmlToMarkdown('<p>a<strong> b </strong>c</p>')).toBe('a **b** c\n')
	})

	it('fences inline code around its own backticks and keeps its spacing', () => {
		expect(htmlToMarkdown('<p><code>a`b</code> and <code>`x</code> and <code>two  spaces</code></p>'))
			.toBe('``a`b`` and `` `x `` and `two  spaces`\n')
	})

	it('escapes authored text that Markdown would read as syntax or HTML', () => {
		expect(htmlToMarkdown(
			'<p># not a heading</p><p>1. not a list</p><p>- not a bullet</p>' +
			'<p>a *star* _under_ [x] `tick` back\\slash ~strike~ a|b</p>' +
			'<p>&lt;b&gt;bold&lt;/b&gt; &amp;amp; AT&amp;T</p>',
		)).toBe(
			'\\# not a heading\n\n1\\. not a list\n\n\\- not a bullet\n\n' +
			'a \\*star\\* \\_under\\_ \\[x\\] \\`tick\\` back\\\\slash \\~strike\\~ a\\|b\n\n' +
			'\\<b\\>bold\\</b\\> \\&amp; AT&T\n',
		)
	})

	it('writes links, wraps awkward destinations and keeps the text of unsafe ones', () => {
		expect(htmlToMarkdown(
			'<p><a href="https://example.com/a_b">the *site*</a>, ' +
			'<a href="https://en.wikipedia.org/wiki/Star_(disambiguation)">star</a>, ' +
			'<a href="mailto:me@example.com">mail</a>, <a href="https://example.com/x"></a> and ' +
			'<a href="javascript:alert(1)">bad</a></p>',
		)).toBe(
			'[the \\*site\\*](https://example.com/a_b), ' +
			'[star](<https://en.wikipedia.org/wiki/Star_(disambiguation)>), ' +
			'[mail](mailto:me@example.com), [https://example.com/x](https://example.com/x) and bad\n',
		)
	})

	it('does not turn an exclamation mark before a link into an image', () => {
		expect(htmlToMarkdown('<p>Wow!<a href="https://example.com/">see</a> Fine! Done!</p>'))
			.toBe('Wow\\![see](https://example.com/) Fine! Done!\n')
	})

	it('nests lists by the width of their marker', () => {
		expect(htmlToMarkdown(
			'<ul><li><p>One</p><ul><li><p>Nested</p></li></ul></li><li><p>Two</p></li></ul>' +
			'<ol><li><p>First</p></li><li><p>Second</p><ol><li><p>Deep</p></li></ol></li></ol>',
		)).toBe('- One\n  - Nested\n- Two\n\n1. First\n2. Second\n   1. Deep\n')
	})

	it('keeps several paragraphs in one item and escapes item text', () => {
		expect(htmlToMarkdown('<ul><li><p>Para one</p><p>Para two</p></li><li><p>1. not nested</p></li></ul>'))
			.toBe('- Para one\n\n  Para two\n- 1\\. not nested\n')
	})

	it('quotes blocks, nested quotes included', () => {
		expect(htmlToMarkdown('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>'))
			.toBe('> outer\n>\n> > inner\n')
	})

	it('keeps the blank lines of code blocks, also inside list items', () => {
		expect(htmlToMarkdown(
			'<blockquote><p>Line one</p><p>Line two</p></blockquote>' +
			'<pre><code>def a():\n    pass\n\n\ndef b():\n    return `x`\n</code></pre><hr><p>after</p>',
		)).toBe(
			'> Line one\n>\n> Line two\n\n' +
			'```\ndef a():\n    pass\n\n\ndef b():\n    return `x`\n```\n\n---\n\nafter\n',
		)
		expect(htmlToMarkdown('<ul><li><p>Example</p><pre><code>a\n\n\nb</code></pre></li></ul>'))
			.toBe('- Example\n\n  ```\n  a\n\n\n  b\n  ```\n')
	})

	it('fences code with more backticks than it contains', () => {
		expect(htmlToMarkdown('<pre><code>```js\nx\n```</code></pre>')).toBe('````\n```js\nx\n```\n````\n')
	})

	it('writes tables with a header row, escaped pipes and padded rows', () => {
		expect(htmlToMarkdown(
			'<table><tbody><tr><th><p>Name</p></th><th><p>Note</p></th></tr>' +
			'<tr><td><p>a|b <strong>bold</strong> <a href="https://example.com/">link</a></p></td>' +
			'<td><p>one</p><p>two</p></td></tr><tr><td><p>solo</p></td></tr></tbody></table>',
		)).toBe(
			'| Name | Note |\n| --- | --- |\n' +
			'| a\\\\|b **bold** [link](https://example.com/) | one<br>two |\n' +
			'| solo |  |\n',
		)
	})

	it('writes line breaks as hard breaks and escapes the line after one', () => {
		expect(htmlToMarkdown('<p>one<br>two</p><p>a<br>- b</p>')).toBe('one\\\ntwo\n\na\\\n\\- b\n')
	})

	it('drops a hard break where Markdown has none, instead of printing its backslash', () => {
		expect(htmlToMarkdown('<p>end<br></p><p>next</p>')).toBe('end\n\nnext\n')
		expect(htmlToMarkdown('<h2>a<br>b</h2>')).toBe('## a b\n')
		expect(htmlToMarkdown('<table><tbody><tr><td><p>a<br>b<br></p></td></tr></tbody></table>'))
			.toBe('| a<br>b |\n| --- |\n')
		// An escaped backslash before the break stays text.
		expect(htmlToMarkdown('<p>path\\<br></p>')).toBe('path\\\\\n')
	})

	it('turns stray inline content into a paragraph', () => {
		expect(htmlToMarkdown('loose <strong>text</strong><p>para</p>')).toBe('loose **text**\n\npara\n')
	})

	it('only converts what the reader would show', () => {
		expect(htmlToMarkdown(
			'<p>safe</p><script>alert(1)</script><img src="https://tracker.example/p.png">' +
			'<p onclick="steal()">still</p><style>p{}</style>',
		)).toBe('safe\n\nstill\n')
	})
})

// A fence can share its first line with a list marker; preserve the text inside it.
it('preserves consecutive blank lines in a code block at the start of a list item', () => {
	expect(htmlToMarkdown('<ul><li><pre><code>first\n\n\nlast</code></pre></li></ul>'))
		.toBe('- ```\n  first\n\n\n  last\n  ```\n')
})
