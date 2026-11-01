import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {commentKeys, normalizeComment} from '@/client/queries/comments'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {scopedEditorDraftKey} from '@/helpers/editorDraftStorage'
import {useAuthStore} from '@/stores/auth'
import {removeToken, saveToken} from '@/helpers/auth'

const sdk = vi.hoisted(() => ({
 taskCommentsList: vi.fn(),
 taskCommentsCreate: vi.fn(),
 taskCommentsUpdate: vi.fn(),
}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/components/input/Reactions.vue', () => ({default: {template: '<div />'}}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/components/input/AsyncEditor', async () => {
 const {defineComponent} = await import('vue')
 return {default: defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue', 'save', 'discard'],
  template: '<div><textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"/><button class="save" @click="$emit(\'save\')">Save</button><button class="discard" @click="$emit(\'discard\')">Discard</button></div>',
 })}
})
import Comments from './Comments.vue'

const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
const draftKey = () => `editorDraft-${scopedEditorDraftKey(editorDraftNamespace(), 'task-comment-1-edit-7')}`
const clients: QueryClient[] = []
let wrapper: VueWrapper | undefined
const original = normalizeComment({id: 7, comment: 'original comment', author: {id: 1, username: 'writer'}})
function setup(id = 1) {
 saveToken(token(id), false)
 const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
 const page = {items: [original], total: 1, total_pages: 1, per_page: 50, page: 1}
 client.setQueryData(commentKeys.page(1, 'asc', 1), page)
 sdk.taskCommentsList.mockResolvedValue({data: page})
 clients.push(client)
 const pinia = createPinia()
 wrapper = mount(Comments, {
  props: {taskId: 1, projectId: 1, canWrite: true},
  global: {
   plugins: [pinia, [VueQueryPlugin, {queryClient: client}]],
   mocks: {$t: (key: string) => key},
   stubs: {UserAvatar: true, Reactions: true, Icon: true, CustomTransition: true, PaginationEmit: true, Modal: true, XButton: true},
   directives: {tooltip: {}},
  },
 })
 useAuthStore(pinia).setSession({id, type: 1, exp: 9999999999, username: 'writer'})
 return wrapper
}
afterEach(async () => {
 wrapper?.unmount()
 wrapper = undefined
 await flushPromises()
 clients.splice(0).forEach(client => client.clear())
 removeToken()
 localStorage.clear()
 vi.resetAllMocks()
})

describe('existing comment draft recovery', () => {
 it('keeps an edit synchronously and recovers it after the session expires before autosave', async () => {
  const first = setup()
  await first.find('#comment-7 textarea').setValue('unsent comment edit')
  const key = draftKey()
  expect(localStorage.getItem(key)).toBe('unsent comment edit')
  removeToken()
  first.unmount()
  wrapper = undefined
  await flushPromises()
  expect(sdk.taskCommentsUpdate).not.toHaveBeenCalled()

  const next = setup()
  await flushPromises()
  expect(next.text()).toContain('task.comment.draftFound')
  sdk.taskCommentsUpdate.mockImplementation(async () => {
   sdk.taskCommentsList.mockResolvedValue({data: {items: [{...original, comment: 'unsent comment edit'}], total: 1, total_pages: 1, per_page: 50, page: 1}})
   return {data: {id: 7, comment: 'unsent comment edit'}}
  })
  await next.findAll('button').find(button => button.text() === 'task.comment.restoreDraft')!.trigger('click')
  await flushPromises()
  expect(sdk.taskCommentsUpdate.mock.calls[0][0]).toMatchObject({
   path: {task: 1, commentid: 7}, body: {comment: 'unsent comment edit'},
  })
  expect(localStorage.getItem(key)).toBeNull()
  expect(next.find<HTMLTextAreaElement>('#comment-7 textarea').element.value).toBe('unsent comment edit')
 })

 it('keeps a failed submitted edit and offers it after remount', async () => {
  sdk.taskCommentsUpdate.mockRejectedValue(new Error('offline'))
  const first = setup()
  await first.find('#comment-7 textarea').setValue('failed edit')
  await first.find('#comment-7 .save').trigger('click')
  await flushPromises()
  expect(localStorage.getItem(draftKey())).toBe('failed edit')
  expect(first.find('#comment-7 .comment-edit-failed').text()).toContain('task.comment.editNotSaved')
  first.unmount()
  wrapper = undefined
  await flushPromises()
  const next = setup()
  await flushPromises()
  expect(next.text()).toContain('task.comment.draftFound')
  expect(next.find<HTMLTextAreaElement>('#comment-7 textarea').element.value).toBe('original comment')
 })

 it('does not offer another account’s edit with the same task/comment ids', async () => {
  const first = setup()
  await first.find('#comment-7 textarea').setValue('private draft')
  const oldKey = draftKey()
  removeToken()
  first.unmount()
  wrapper = undefined
  await flushPromises()
  const next = setup(2)
  await flushPromises()
  expect(next.text()).not.toContain('task.comment.draftFound')
  expect(localStorage.getItem(oldKey)).toBe('private draft')
  expect(localStorage.getItem(draftKey())).toBeNull()
 })

 it('retries a visible failed edit without losing the retained text', async () => {
  sdk.taskCommentsUpdate.mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => {
   sdk.taskCommentsList.mockResolvedValue({data: {items: [{...original, comment: 'retry this edit'}], total: 1, total_pages: 1, per_page: 50, page: 1}})
   return {data: {id: 7, comment: 'retry this edit'}}
  })
  const view = setup()
  await view.find('#comment-7 textarea').setValue('retry this edit')
  await view.find('#comment-7 .save').trigger('click')
  await flushPromises()
  expect(view.find('#comment-7 .comment-edit-failed').text()).toContain('task.comment.editNotSaved')
  expect(localStorage.getItem(draftKey())).toBe('retry this edit')
  await view.find('#comment-7 .comment-edit-failed button').trigger('click')
  await flushPromises()
  expect(sdk.taskCommentsUpdate).toHaveBeenCalledTimes(2)
  expect(sdk.taskCommentsUpdate.mock.calls[1][0]).toMatchObject({path: {task: 1, commentid: 7}, body: {comment: 'retry this edit'}})
  expect(view.find('#comment-7 .comment-edit-failed').exists()).toBe(false)
  expect(localStorage.getItem(draftKey())).toBeNull()
  expect(view.find<HTMLTextAreaElement>('#comment-7 textarea').element.value).toBe('retry this edit')
 })

 it('keeps an aborted edit recoverable without showing a server-save error', async () => {
  sdk.taskCommentsUpdate.mockRejectedValue(new DOMException('context changed', 'AbortError'))
  const view = setup()
  await view.find('#comment-7 textarea').setValue('aborted edit')
  await view.find('#comment-7 .save').trigger('click')
  await flushPromises()
  expect(localStorage.getItem(draftKey())).toBe('aborted edit')
  expect(view.find('#comment-7 .comment-edit-failed').exists()).toBe(false)
 })
})
