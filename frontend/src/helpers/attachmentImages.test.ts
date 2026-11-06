import {afterEach, describe, it, expect} from 'vitest'
import {hasRemovedAttachmentImages, removeAttachmentImages} from './attachmentImages'

afterEach(() => { window.API_URL = '' })

describe('inline attachment cleanup', () => {
 it('preserves text, links, other attachments and external images', () => {
  window.API_URL = 'https://task.test'
  const keep = '<p>notes</p><a href="/api/v2/tasks/7/attachments/5">download</a><img src="https://external.test/api/v2/tasks/7/attachments/5"><img src="/api/v2/tasks/7/attachments/50">'
  expect(removeAttachmentImages(keep + '<img data-src="https://task.test/api/v2/tasks/7/attachments/5" src="#">', 7, [5])).toBe(keep)
  expect(removeAttachmentImages(keep, 7, [5])).toBe(keep)
 })
 it('supports mounted base paths and version one links', () => {
  window.API_URL = 'https://task.test/sub/api/v2'
  expect(removeAttachmentImages('<img src="https://task.test/sub/api/v1/tasks/7/attachments/5/preview?size=medium">', 7, [5])).toBe('')
 })
})

describe('removed description images with retained attachments', () => {
 it('compares attachment identity across old, preview and authenticated editor URLs', () => {
  window.API_URL = 'https://task.test/sub/api/v2'
  const before = '<img data-src="https://task.test/sub/api/v1/tasks/7/attachments/5/preview?size=medium" src="blob:temporary"><img src="/sub/api/v2/tasks/7/attachments/6">'
  const moved = '<p>reordered</p><img src="/sub/api/v2/tasks/7/attachments/6"><img src="https://task.test/sub/api/v2/tasks/7/attachments/5" alt="updated">'
  expect(hasRemovedAttachmentImages(before, moved, 7, [5, 6])).toBe(false)
  expect(hasRemovedAttachmentImages(before, '<img src="/sub/api/v2/tasks/7/attachments/6">', 7, [5, 6])).toBe(true)
 })
 it('detects fewer image nodes for a retained attachment without confusing a move with removal', () => {
  const image = '<img src="/api/v2/tasks/7/attachments/5">'
  expect(hasRemovedAttachmentImages(image + image, image, 7, [5])).toBe(true)
  expect(hasRemovedAttachmentImages(image + '<p>text</p>', '<p>text</p>' + image, 7, [5])).toBe(false)
  expect(hasRemovedAttachmentImages(image, '', 7, [])).toBe(false)
  expect(hasRemovedAttachmentImages(image, '', 7, [6])).toBe(false)
  expect(hasRemovedAttachmentImages(image, '', 7, [5])).toBe(true)
 })
 it('ignores remote images, other tasks, download links and Compass images', () => {
  const otherImages = '<img src="https://external.test/api/v2/tasks/7/attachments/5"><img src="/api/v2/tasks/8/attachments/5"><a href="/api/v2/tasks/7/attachments/5">download</a><img src="/api/v2/compass/media/5">'
  expect(hasRemovedAttachmentImages(otherImages, '', 7, [5])).toBe(false)
 })
})
