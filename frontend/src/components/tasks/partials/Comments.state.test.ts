import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {commentKeys, normalizeComment, type CommentPage} from '@/client/queries/comments'
import {useAuthStore} from '@/stores/auth'
import {removeToken, saveToken} from '@/helpers/auth'
import XButton from '@/components/input/Button.vue'

const sdk = vi.hoisted(() => ({
	taskCommentsList: vi.fn(),
	taskCommentsDelete: vi.fn(),
}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/components/input/Reactions.vue', () => ({default: {template: '<div />'}}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/components/input/AsyncEditor', () => ({default: {
	props: ['modelValue', 'bottomActions'],
	template: '<div><span>{{ modelValue }}</span><button v-for="action in bottomActions" :key="action.title" @click="action.action()">{{ action.title }}</button></div>',
}}))
import Comments from './Comments.vue'

const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
const original = normalizeComment({id: 7, comment: 'original comment', author: {id: 1, username: 'writer'}})
const page = (items = [original]): CommentPage => ({items, total: items.length, total_pages: 1, per_page: 50, page: 1})
let client: QueryClient
let wrapper: VueWrapper | undefined

function setup(seed?: CommentPage) {
	saveToken(token(1), false)
	client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	if (seed) client.setQueryData(commentKeys.page(1, 'asc', 1), seed)
	const pinia = createPinia()
	useAuthStore(pinia).setSession({id: 1, type: 1, exp: 9999999999, username: 'writer'})
	wrapper = mount(Comments, {
		props: {taskId: 1, projectId: 1, canWrite: true},
		global: {
			plugins: [pinia, [VueQueryPlugin, {queryClient: client}]],
			components: {XButton},
			mocks: {$t: (key: string) => key},
			stubs: {
				UserAvatar: true, Reactions: true, Icon: true, CustomTransition: true, PaginationEmit: true, RouterLink: true,
				Modal: {
					name: 'Modal',
					props: {enabled: Boolean, loading: Boolean},
					emits: ['submit', 'close'],
					template: '<div v-if="enabled"><slot name="header"/><slot name="text"/></div>',
				},
			},
			directives: {tooltip: {}},
		},
	})
	return wrapper
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {resolve = done})
	return {promise, resolve}
}

async function openDelete(view: VueWrapper) {
	await view.findAll('button').find(button => button.text() === 'misc.delete')!.trigger('click')
	return view.findComponent({name: 'Modal'})
}

afterEach(async () => {
	wrapper?.unmount()
	wrapper = undefined
	await flushPromises()
	client?.clear()
	removeToken()
	localStorage.clear()
	vi.resetAllMocks()
})

describe('comment delete request boundaries', () => {
	it('guards duplicate submits synchronously and exposes pending state', async () => {
		const pending = deferred<{data: undefined}>()
		sdk.taskCommentsDelete.mockReturnValue(pending.promise)
		sdk.taskCommentsList.mockResolvedValue({data: page([])})
		const view = setup(page())
		const modal = await openDelete(view)
		modal.vm.$emit('submit')
		modal.vm.$emit('submit')
		await flushPromises()
		expect(sdk.taskCommentsDelete).toHaveBeenCalledTimes(1)
		expect(modal.props('loading')).toBe(true)
		pending.resolve({data: undefined})
		await flushPromises()
		expect(modal.props('enabled')).toBe(false)
	})

	it('keeps a failed delete visible and allows one retry for the same target', async () => {
		sdk.taskCommentsDelete.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({data: undefined})
		sdk.taskCommentsList.mockResolvedValue({data: page()})
		const view = setup(page())
		const modal = await openDelete(view)
		modal.vm.$emit('submit')
		await flushPromises()
		expect(modal.props('enabled')).toBe(true)
		expect(modal.props('loading')).toBe(false)
		expect(modal.find('[role="alert"]').text()).toContain('task.comment.deleteFailed')
		sdk.taskCommentsList.mockResolvedValue({data: page([])})
		modal.vm.$emit('submit')
		await flushPromises()
		expect(sdk.taskCommentsDelete).toHaveBeenCalledTimes(2)
		expect(sdk.taskCommentsDelete.mock.calls[1][0].path).toEqual({task: 1, commentid: 7})
		expect(modal.props('enabled')).toBe(false)
	})

	it('does not let an old failed delete appear on the next task', async () => {
		let reject!: (cause: Error) => void
		sdk.taskCommentsDelete.mockReturnValue(new Promise((_resolve, fail) => {reject = fail}))
		sdk.taskCommentsList.mockResolvedValue({data: page()})
		const view = setup(page())
		const modal = await openDelete(view)
		modal.vm.$emit('submit')
		await flushPromises()
		await view.setProps({taskId: 2})
		reject(new Error('old task failed'))
		await flushPromises()
		expect(modal.props('enabled')).toBe(false)
		expect(view.text()).not.toContain('task.comment.deleteFailed')
	})

	it('does not submit a confirmation retained across a login change', async () => {
		const view = setup(page())
		const modal = await openDelete(view)
		removeToken()
		saveToken(token(2), false)
		modal.vm.$emit('submit')
		await flushPromises()
		expect(sdk.taskCommentsDelete).not.toHaveBeenCalled()
	})
})

describe('comment reading state', () => {
	it('distinguishes first loading, failure and a successful empty response', async () => {
		let reject!: (cause: Error) => void
		sdk.taskCommentsList.mockReturnValueOnce(new Promise((_resolve, fail) => {reject = fail}))
		const view = setup()
		await vi.waitFor(() => expect(view.find('.comments-loading').exists()).toBe(true))
		expect(view.text()).not.toContain('task.comment.empty')
		reject(new Error('read failed'))
		await flushPromises()
		expect(view.find('.load-error').exists()).toBe(true)
		expect(view.text()).not.toContain('task.comment.empty')
		sdk.taskCommentsList.mockResolvedValue({data: page([])})
		await view.find('.load-error button').trigger('click')
		await flushPromises()
		expect(view.find('.load-error').exists()).toBe(false)
		expect(view.text()).toContain('task.comment.empty')
	})

	it.each([true, false])('keeps cached rows and reports a failed refresh (has rows: %s)', async hasRows => {
		sdk.taskCommentsList.mockRejectedValue(new Error('refresh failed'))
		const view = setup(page(hasRows ? [original] : []))
		await client.refetchQueries({queryKey: commentKeys.task(1)})
		await flushPromises()
		expect(view.find('.load-error').exists()).toBe(true)
		expect(view.text()).not.toContain('task.comment.empty')
		if (hasRows) expect(view.text()).toContain('original comment')
	})
})
