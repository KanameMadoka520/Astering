import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises} from '@vue/test-utils'
import {chooseImageBatch, chooseImageUpload, clearUploads, convertImage, imagePrompt, uploadAwareFetch, uploads, UPLOAD_CHOICE_HEADER, UPLOAD_RECORD_HEADER} from './uploadTransport'

afterEach(() => clearUploads())
describe('image upload choices', () => {
  it('retains the exact original File when original was selected', async () => {
    const file = new File(['original bytes'], 'example.png', {type: 'image/png'})
    expect(await convertImage(file, {mode: 'original', quality: .85, maxSide: 2560})).toBe(file)
  })
  it('preserves animation and scriptable image formats rather than silently flattening them', async () => {
    for (const type of ['image/gif', 'image/svg+xml', 'image/tiff']) {
      const file = new File(['fixture'], 'image', {type})
      expect(await convertImage(file, {mode: 'webp', quality: .85, maxSide: 2560})).toBe(file)
    }
  })
  it('discards queued files when the account changes', async () => {
    const signal = new AbortController().signal
    const first = chooseImageUpload([new File([], 'private.png')], signal)
    const second = chooseImageUpload([new File([], 'queued-private.png')], signal)
    await Promise.resolve()
    clearUploads()
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(imagePrompt.value).toBeNull()
  })
  it('serializes concurrent choices and allows cancellation before any upload', async () => {
    const a = new AbortController(), b = new AbortController()
    const first = chooseImageUpload([new File([], 'first.png')], a.signal)
    const second = chooseImageUpload([new File([], 'second.png')], b.signal)
    await Promise.resolve()
    expect(imagePrompt.value?.files[0].name).toBe('first.png')
    imagePrompt.value!.resolve({mode: 'original', quality: .85, maxSide: 2560})
    expect((await first)?.mode).toBe('original')
    await Promise.resolve()
    expect(imagePrompt.value?.files[0].name).toBe('second.png')
    b.abort()
    expect(await second).toBeNull()
    expect(imagePrompt.value).toBeNull()
  })
})

describe('image batch presets', () => {
  const sent: Record<string, string>[] = []
  class BatchXHR {
    static current: BatchXHR
    upload = {}
    onload?: () => void
    onerror?: () => void
    onabort?: () => void
    status = 200
    statusText = 'OK'
    response = new TextEncoder().encode('{}').buffer
    headers: Record<string, string> = {}
    constructor() {BatchXHR.current = this; sent.push(this.headers)}
    open() {}
    setRequestHeader(key: string, value: string) {this.headers[key.toLowerCase()] = value}
    send() {}
    getAllResponseHeaders() {return 'Content-Type: application/json\r\n'}
    abort() {this.onabort?.()}
  }
  beforeEach(() => {
    sent.length = 0
    vi.stubGlobal('XMLHttpRequest', BatchXHR)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {callback(0); return 0})
  })
  afterEach(() => vi.unstubAllGlobals())
  function upload(name: string, headers: Record<string, string>) {
    const form = new FormData()
    form.append('file', new File(['image bytes'], name, {type: 'image/png'}))
    return uploadAwareFetch(new Request('http://localhost/api/v2/ai/conversations/c1/attachments', {method: 'POST', body: form, headers}))
  }
  async function choose(...names: string[]) {
    const batch = chooseImageBatch(names.map(name => new File(['image bytes'], name, {type: 'image/png'})), new AbortController().signal)
    await flushPromises()
    expect(imagePrompt.value?.files.map(file => file.name)).toEqual(names)
    imagePrompt.value!.resolve({mode: 'original', quality: .85, maxSide: 2560})
    return (await batch)!
  }

  it('asks once for a selection and keeps the client-only headers off the wire', async () => {
    const batch = await choose('first.png', 'second.png')
    for (const [index, name] of ['first.png', 'second.png'].entries()) {
      const request = upload(name, batch.headers(`record-${index}`))
      await flushPromises()
      expect(imagePrompt.value).toBeNull()
      BatchXHR.current.onload!()
      await request
    }
    expect(sent).toHaveLength(2)
    for (const headers of sent) {
      expect(headers['x-vikunja-image-mode']).toBe('original')
      expect(headers).not.toHaveProperty(UPLOAD_CHOICE_HEADER.toLowerCase())
      expect(headers).not.toHaveProperty(UPLOAD_RECORD_HEADER.toLowerCase())
    }
    expect(uploads.value.map(row => [row.id, row.stage])).toEqual([['record-1', 'done'], ['record-0', 'done']])
  })
  it('asks again for a released or unknown preset instead of failing', async () => {
    const batch = await choose('photo.png')
    batch.release()
    for (const headers of [batch.headers(), {[UPLOAD_CHOICE_HEADER]: 'unknown'}]) {
      const request = upload('photo.png', headers)
      const rejected = expect(request).rejects.toMatchObject({name: 'AbortError'})
      await flushPromises()
      expect(imagePrompt.value?.files[0].name).toBe('photo.png')
      imagePrompt.value!.resolve(null)
      await rejected
    }
    expect(sent).toHaveLength(0)
  })
})
