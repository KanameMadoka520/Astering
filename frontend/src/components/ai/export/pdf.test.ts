import {describe, it, expect, vi} from 'vitest'
import {conversationPDF, markdownPDF} from './pdf'
import {chatBytes} from './files'
const pdf = vi.hoisted(() => ({
 addFonts: vi.fn(),
 createPdf: vi.fn(() => ({getBlob: async () => new Blob(['pdf fixture'])})),
}))
vi.mock('pdfmake/build/pdfmake', () => ({default: pdf}))
describe('portable chat exports', () => {
 it('preserves headings, code and tables as selectable PDF content', () => {
  const content = markdownPDF('# 标题\n\n```js\nconst x = 1\n```\n\n| 姓名 | 状态 |\n|---|---|\n| 测试 | 完成 |')
  expect(content).toEqual(expect.arrayContaining([expect.objectContaining({text: [expect.objectContaining({text: '标题'})], bold: true}), expect.objectContaining({text: 'const x = 1'})]))
  expect(content.some(part => typeof part === 'object' && part && 'table' in part)).toBe(true)
 })
 it('does not turn arbitrary Markdown URLs into image fetches', () => {
  const text = JSON.stringify(markdownPDF('![private](https://tracking.example/pixel)\n\n<script>alert(1)</script>'))
  expect(text).not.toContain('"image":')
  expect(text).not.toContain('"link":')
 })
 it('formats actual byte sizes rather than estimating from text length', () => {
  expect(chatBytes(0)).toBe('0 B'); expect(chatBytes(1536)).toBe('1.5 KiB')
 })
 it('exports the original task, added instructions and actual reply time in GMT+8', async () => {
  const blob = await conversationPDF({id: 'c1', turns: [{
   id: 't1', prompt: 'Original task', status: 'completed',
   started: '2026-11-01T20:30:00Z', finished: '2026-11-01T20:31:09Z',
   steering: [{message: 'Also verify the dates', created: '2026-11-01T20:30:45Z', status: 'applied'}],
   result: {reply: 'Dates verified'},
  }, {id: 'legacy', prompt: 'Older task', status: 'completed', started: '0001-01-01T00:00:00Z'}]}, {
   you: 'You', assistant: 'Arona', missing: 'Missing', unreadable: 'File', drafts: 'Drafts',
   summary: 'Summary', generated: 'Generated', status: 'Status', model: 'Model', duration: 'Duration',
   steps: 'Tools', addition: 'Added', pending: 'Pending', applied: 'Incorporated into context',
  }, vi.fn(), new AbortController().signal)
  expect(blob).toBeInstanceOf(Blob)
  const document = JSON.stringify(pdf.createPdf.mock.calls.at(-1))
  expect(document).toContain('Original task')
  expect(document).toContain('Also verify the dates')
  expect(document).toContain('Incorporated into context')
  expect(document).toContain('2026-11-02 04:30:00 GMT+8')
  expect(document).toContain('Arona · 2026-11-02 04:31:09 GMT+8')
  expect(document).not.toContain('Invalid Date')
  expect(document).not.toContain('0001-01-01')
 })
})
