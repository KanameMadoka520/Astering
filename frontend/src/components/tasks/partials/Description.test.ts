import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {taskKeys, normalizeTask} from '@/client/queries/tasks'
import {failTaskDetails} from '@/client/queries/taskCache'
import {removeToken, saveToken} from '@/helpers/auth'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {scopedEditorDraftKey} from '@/helpers/editorDraftStorage'
import {clearAccountDrafts} from '@/helpers/localDrafts'
import {success} from '@/message'
import type {Task} from '@/client/generated'

const sdk = vi.hoisted(() => ({patchTasksRead: vi.fn(), tasksRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn(), getErrorText: (e: Error) => e.message}))
vi.mock('vue-router', async original => ({
	...await original<typeof import('vue-router')>(),
	onBeforeRouteLeave: vi.fn(),
	onBeforeRouteUpdate: vi.fn(),
	useRouter: () => ({currentRoute: {value: {fullPath: '/tasks/1'}}, push: vi.fn()}),
}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/components/input/AsyncEditor', async () => {
 const {defineComponent} = await import('vue')
 return {default: defineComponent({
 props: ['modelValue'], emits: ['update:modelValue', 'save', 'discard'],
 template: '<div><textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/><button @click="$emit(\'save\')">Save</button><button class="discard" @click="$emit(\'discard\')">Discard</button></div>',
})}
})
import Description from './Description.vue'

let wrapper: VueWrapper | undefined
let client: QueryClient
const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
const draftKey = (taskId: number) => `editorDraft-${scopedEditorDraftKey(editorDraftNamespace(), `task-description-${taskId}`)}`
function setup(signedIn = true, changes: Partial<Task> = {}) {
 if (signedIn) saveToken(token(1), false)
 client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
 const task = normalizeTask({id: 1, project_id: 1, title: 'Test', description: 'old', attachments: [], ...changes})
 client.setQueryData(taskKeys.detail(1), task)
 sdk.tasksRead.mockResolvedValue({data: task})
 wrapper = mount(Description, {props: {modelValue: task, canWrite: true}, global: {plugins: [createPinia(), [VueQueryPlugin, {queryClient: client}]], stubs: {Icon: true, CustomTransition: true}, mocks: {$t: (key: string) => key}}})
 return wrapper
}
afterEach(async () => {wrapper?.unmount(); await flushPromises(); vi.clearAllMocks(); vi.useRealTimers(); removeToken(); localStorage.clear(); window.API_URL = ''})
const saveButton = (view: VueWrapper) => view.find('.tiptap__task-description button:not(.discard)')

describe('description save races', () => {
 it('announces retained images only after the server confirms a successful description removal', async () => {
  const attachment = {id: 5, task_id: 1, file: {id: 12}}
  const image = '<img src="/api/v2/tasks/1/attachments/5">'
  let reject!: (error: Error) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
   .mockResolvedValue({data: {id: 1, description: '<p>Kept text</p>', attachments: [attachment]}})
  const view = setup(true, {description: image + '<p>Kept text</p>', attachments: [attachment]})
  await view.find('textarea').setValue('<p>Kept text</p>')
  expect(success).not.toHaveBeenCalled()
  await saveButton(view).trigger('click')
  await flushPromises()
  expect(success).not.toHaveBeenCalled()
  reject(new Error('offline'))
  await flushPromises()
  expect(success).not.toHaveBeenCalled()
  await saveButton(view).trigger('click')
  await flushPromises()
  expect(success).toHaveBeenCalledExactlyOnceWith({message: 'tcy.chatImages.receiptRemoved'})
  expect(sdk.patchTasksRead.mock.calls[1][0].body).toEqual([
   {op: 'add', path: '/description', value: '<p>Kept text</p>'},
  ])
 })
 it('does not announce an image removal that the user undoes while its save is pending', async () => {
  const attachment = {id: 5, task_id: 1, file: {id: 12}}
  const image = '<img src="/api/v2/tasks/1/attachments/5">'
  let resolve!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
   .mockResolvedValue({data: {id: 1, description: image, attachments: [attachment]}})
  const view = setup(true, {description: image, attachments: [attachment]})
  await view.find('textarea').setValue('')
  await saveButton(view).trigger('click')
  await flushPromises()
  await view.find('textarea').setValue(image)
  resolve({data: {id: 1, description: '', attachments: [attachment]}})
  await flushPromises()
  expect(success).not.toHaveBeenCalled()
  expect(view.find('textarea').element.value).toBe(image)
 })
 it('does not claim retained files when the attachment itself disappeared in the server response', async () => {
  const attachment = {id: 5, task_id: 1, file: {id: 12}}
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: '', attachments: []}})
  const view = setup(true, {
   description: '<img src="/api/v2/tasks/1/attachments/5">',
   attachments: [attachment],
  })
  await view.find('textarea').setValue('')
  await saveButton(view).trigger('click')
  await flushPromises()
  expect(success).not.toHaveBeenCalled()
 })
 it('retains newer typing while an earlier save is pending and writes only the description', async () => {
  let resolve!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done})).mockResolvedValue({data: {id: 1, description: 'newer'}})
  const view = setup()
  await view.find('textarea').setValue('first')
  await view.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  await view.find('textarea').setValue('newer')
  resolve({data: {id: 1, description: 'first'}})
  await flushPromises()
  expect(view.find('textarea').element.value).toBe('newer')
  await view.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(2)
  expect(sdk.patchTasksRead.mock.calls[0][0].body).toEqual([{op: 'add', path: '/description', value: 'first'}])
  expect(sdk.patchTasksRead.mock.calls[1][0].body).toEqual([{op: 'add', path: '/description', value: 'newer'}])
 })
 it('keeps failed text available for retry', async () => {
  sdk.patchTasksRead.mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue({data: {id: 1, description: 'keep me'}})
  const view = setup()
  await view.find('textarea').setValue('keep me')
  await view.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  expect(view.find('[role="alert"]').text()).toContain('Save failed')
  expect(view.find('textarea').element.value).toBe('keep me')
  await view.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)
 })
 it('does not save a draft of a task deleted elsewhere when it unmounts', async () => {
  const view = setup()
  await view.find('textarea').setValue('unsaved draft')
  failTaskDetails(client, 1)
  view.unmount()
  wrapper = undefined
  await flushPromises()
  expect(sdk.patchTasksRead).not.toHaveBeenCalled()
 })
 it('saves a task with a deleted id again after another login on the same client', async () => {
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: 'other server'}})
  const first = setup()
  failTaskDetails(client, 1)
  first.unmount()
  removeToken()
  saveToken(token(2), false)
  const sharedClient = client
  wrapper = mount(Description, {props: {modelValue: normalizeTask({id: 1, project_id: 1, title: 'Test', description: 'old', attachments: []}), canWrite: true}, global: {plugins: [createPinia(), [VueQueryPlugin, {queryClient: sharedClient}]], stubs: {Icon: true, CustomTransition: true}, mocks: {$t: (key: string) => key}}})
  await wrapper.find('textarea').setValue('other server')
  await wrapper.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
 })
})

describe('unsaved description text', () => {
 it('saves what was typed for a task when the view switches to another task', async () => {
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: 'typed for one'}})
  const view = setup()
  await view.find('textarea').setValue('typed for one')
  const next = normalizeTask({id: 2, project_id: 1, title: 'Next', description: 'two', attachments: []})
  await view.setProps({modelValue: next})
  await flushPromises()
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
  expect(sdk.patchTasksRead.mock.calls[0][0].path).toEqual({task: 1})
  expect(sdk.patchTasksRead.mock.calls[0][0].body).toEqual([{op: 'add', path: '/description', value: 'typed for one'}])
  expect(view.find('textarea').element.value).toBe('two')
 })
 it('keeps the text of a task that was left on this device when its save fails', async () => {
  sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
  const view = setup()
  await view.find('textarea').setValue('typed for one')
  await view.setProps({modelValue: normalizeTask({id: 2, project_id: 1, title: 'Next', description: '', attachments: []})})
  await flushPromises()
  expect(localStorage.getItem(draftKey(1))).toBe('typed for one')
 })
 it('does not send text discarded with Esc', async () => {
  vi.useFakeTimers()
  const view = setup()
  await view.find('textarea').setValue('discard me')
  await view.find('.discard').trigger('click')
  await vi.advanceTimersByTimeAsync(6000)
  expect(sdk.patchTasksRead).not.toHaveBeenCalled()
  expect(view.find('textarea').element.value).toBe('old')
 })
 it('flushes pending text at once and reports when there was nothing to send', async () => {
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: 'flushed'}})
  const view = setup()
  const vm = view.vm as unknown as {flush: () => Promise<string>}
  expect(await vm.flush()).toBe('none')
  await view.find('textarea').setValue('flushed')
  expect(await vm.flush()).toBe('saved')
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
 })
 it('keeps the draft on this device when a save fails', async () => {
  sdk.patchTasksRead.mockRejectedValue(new Error('Save failed'))
  const view = setup()
  await view.find('textarea').setValue('keep me')
  await saveButton(view).trigger('click')
  await flushPromises()
  expect(localStorage.getItem(draftKey(1))).toBe('keep me')
 })
 it('offers an unsaved version left on this device and saves it on request', async () => {
  saveToken(token(1), false)
  localStorage.setItem(draftKey(1), '<p>from last time</p>')
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: '<p>from last time</p>'}})
  const view = setup()
  await flushPromises()
  expect(view.text()).toContain('task.description.draftFound')
  const restore = view.findAll('button').find(button => button.text() === 'task.description.restoreDraft')
  await restore!.trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead.mock.calls[0][0].body).toEqual([{op: 'add', path: '/description', value: '<p>from last time</p>'}])
  expect(view.text()).not.toContain('task.description.draftFound')
 })
 it('does not offer a stored copy that equals the saved description', async () => {
  saveToken(token(1), false)
  localStorage.setItem(draftKey(1), 'old')
  const view = setup()
  await flushPromises()
  expect(view.text()).not.toContain('task.description.draftFound')
  expect(localStorage.getItem(draftKey(1))).toBeNull()
 })
})

describe('drafts and saves belong to the account that typed them', () => {
 it('keeps the text under the first account and sends nothing after another account signs in', async () => {
  const view = setup()
  const firstAccountKey = draftKey(1)
  await view.find('textarea').setValue('written by account one')
  removeToken()
  saveToken(token(2), false)
  await view.find('.tiptap__task-description button').trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead).not.toHaveBeenCalled()
  expect(localStorage.getItem(firstAccountKey)).toBe('written by account one')
  expect(localStorage.getItem(draftKey(1))).toBeNull()
 })
 it('does not send the text of a task being left once the session ended', async () => {
  const view = setup()
  const firstAccountKey = draftKey(1)
  await view.find('textarea').setValue('typed before the session expired')
  removeToken()
  await view.setProps({modelValue: normalizeTask({id: 2, project_id: 1, title: 'Next', description: '', attachments: []})})
  await flushPromises()
  expect(sdk.patchTasksRead).not.toHaveBeenCalled()
  expect(localStorage.getItem(firstAccountKey)).toBe('typed before the session expired')
 })
 it('keeps the text when a save that started before logging out and back in finishes afterwards', async () => {
  let resolve!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
  const view = setup()
  const key = draftKey(1)
  await view.find('textarea').setValue('typed before logging out')
  await saveButton(view).trigger('click')
  await flushPromises()
  removeToken()
  saveToken(token(1), false)
  resolve({data: {id: 1, description: 'typed before logging out'}})
  await flushPromises()
  expect(localStorage.getItem(key)).toBe('typed before logging out')
  expect(view.find('[role="alert"]').exists()).toBe(false)
 })
 it('does not offer a draft written for another API server', async () => {
  const configured = window.API_URL
  try {
   saveToken(token(1), false)
   window.API_URL = 'https://first.example.com'
   const firstServerKey = draftKey(1)
   localStorage.setItem(firstServerKey, 'written on the first server')
   window.API_URL = 'https://second.example.com'
   const view = setup()
   await flushPromises()
   expect(draftKey(1)).not.toBe(firstServerKey)
   expect(view.text()).not.toContain('task.description.draftFound')
   expect(localStorage.getItem(firstServerKey)).toBe('written on the first server')
  } finally {
   window.API_URL = configured
  }
 })
 it('keeps no draft without a signed-in account', async () => {
  const view = setup(false)
  await view.find('textarea').setValue('nobody owns this')
  await flushPromises()
  expect(Object.keys(localStorage).filter(key => key.startsWith('editorDraft'))).toEqual([])
 })
})


describe('description acknowledgement and recovery', () => {
 it('keeps an intentional empty edit after failure and offers it after the same account returns', async () => {
  sdk.patchTasksRead.mockRejectedValue(new Error('offline'))
  const first = setup()
  await first.find('textarea').setValue('')
  await saveButton(first).trigger('click')
  await flushPromises()
  expect(localStorage.getItem(draftKey(1))).toBe('')
  first.unmount()
  wrapper = undefined
  await flushPromises()
  removeToken()
  saveToken(token(1), false)
  const next = setup()
  await flushPromises()
  expect(next.text()).toContain('task.description.draftFound')
  sdk.patchTasksRead.mockResolvedValue({data: {id: 1, description: ''}})
  await next.findAll('button').find(button => button.text() === 'task.description.restoreDraft')!.trigger('click')
  await flushPromises()
  expect(sdk.patchTasksRead.mock.lastCall![0].body).toEqual([{op: 'add', path: '/description', value: ''}])
  expect(next.find('textarea').element.value).toBe('')
  expect(localStorage.getItem(draftKey(1))).toBeNull()
 })

 it('preserves and ultimately saves A when B is pending and the writer changes back to A', async () => {
  let resolveB!: (value: unknown) => void
  let resolveA!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolveB = done}))
   .mockImplementationOnce(() => new Promise(done => {resolveA = done}))
  const view = setup()
  await view.find('textarea').setValue('B')
  await saveButton(view).trigger('click')
  await flushPromises()
  await view.find('textarea').setValue('old')
  resolveB({data: {id: 1, description: 'B'}})
  await flushPromises()
  const firstAck = view.emitted('update:modelValue')![0][0]
  await view.setProps({modelValue: firstAck})
  expect(view.find('textarea').element.value).toBe('old')
  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(2)
  expect(sdk.patchTasksRead.mock.calls[1][0].body).toEqual([{op: 'add', path: '/description', value: 'old'}])
  resolveA({data: {id: 1, description: 'old'}})
  await flushPromises()
  await view.setProps({modelValue: view.emitted('update:modelValue')![1][0]})
  expect(view.find('textarea').element.value).toBe('old')
 })

 it('synchronously keeps a submitted copy until the server acknowledges it', async () => {
  let resolve!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
  const view = setup()
  await view.find('textarea').setValue('pending copy')
  await saveButton(view).trigger('click')
  await flushPromises()
  expect(localStorage.getItem(draftKey(1))).toBe('pending copy')
  resolve({data: {id: 1, description: 'pending copy'}})
  await flushPromises()
  expect(localStorage.getItem(draftKey(1))).toBeNull()
 })
})


it('a late old save after explicit clear cannot overwrite the next same-account editor draft', async () => {
 let resolve!: (value: unknown) => void
 sdk.patchTasksRead.mockImplementationOnce(() => new Promise(done => {resolve = done}))
 const first = setup()
 await first.find('textarea').setValue('old pending text')
 await saveButton(first).trigger('click')
 await flushPromises()
 const key = draftKey(1)
 clearAccountDrafts({editor: editorDraftNamespace(), compass: ''})
 removeToken()
 first.unmount()
 wrapper = undefined
 const current = setup()
 await current.find('textarea').setValue('new session draft')
 resolve({data: {id: 1, description: 'old pending text'}})
 await flushPromises()
 expect(localStorage.getItem(key)).toBe('new session draft')
 expect(current.find('textarea').element.value).toBe('new session draft')
 expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
})

it('does not send the old API’s text to a new API with the same account and task id', async () => {
 const view = setup()
 const key = draftKey(1)
 await view.find('textarea').setValue('belongs to original API')
 window.API_URL = 'https://different.example'
 await saveButton(view).trigger('click')
 await flushPromises()
 expect(sdk.patchTasksRead).not.toHaveBeenCalled()
 expect(localStorage.getItem(key)).toBe('belongs to original API')
 expect(localStorage.getItem(draftKey(1))).toBeNull()
})


describe('late description failure after switching tasks', () => {
 it.each(['newer C', ''])('does not replace newer text %j after both writes fail', async newer => {
  let rejectFirst!: (reason: unknown) => void
  sdk.patchTasksRead
   .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
   .mockRejectedValueOnce(new Error('departing write failed'))
  const view = setup()
  const key = draftKey(1)
  await view.find('textarea').setValue('submitted B')
  await saveButton(view).trigger('click')
  await flushPromises()
  await view.find('textarea').setValue(newer)
  await view.setProps({modelValue: normalizeTask({
   id: 2,
   project_id: 1,
   title: 'Next',
   description: 'task two',
   attachments: [],
  })})
  expect(localStorage.getItem(key)).toBe(newer)

  rejectFirst(new Error('first write failed'))
  await flushPromises()

  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(2)
  expect(sdk.patchTasksRead.mock.calls.map(([request]) => request.path)).toEqual([{task: 1}, {task: 1}])
  expect(sdk.patchTasksRead.mock.calls[1][0].body).toEqual([{op: 'add', path: '/description', value: newer}])
  expect(localStorage.getItem(key)).toBe(newer)
  expect(view.find('textarea').element.value).toBe('task two')
 })

 it.each(['newer C', ''])('keeps newer text %j when the old request aborts after switching and logout', async newer => {
  let resolveFirst!: (value: unknown) => void
  sdk.patchTasksRead.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
  const view = setup()
  const key = draftKey(1)
  await view.find('textarea').setValue('submitted B')
  await saveButton(view).trigger('click')
  await flushPromises()
  await view.find('textarea').setValue(newer)
  await view.setProps({modelValue: normalizeTask({
   id: 2,
   project_id: 1,
   title: 'Next',
   description: 'task two',
   attachments: [],
  })})
  removeToken()
  resolveFirst({data: {id: 1, description: 'submitted B'}})
  await flushPromises()

  expect(sdk.patchTasksRead).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(key)).toBe(newer)
  expect(view.find('textarea').element.value).toBe('task two')
 })
})
