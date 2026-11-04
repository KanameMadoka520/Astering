import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mount, flushPromises, type VueWrapper} from '@vue/test-utils'
import {nextTick, reactive} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {createI18n} from 'vue-i18n'
import NetworkActivity from './NetworkActivity.vue'
import en from '@/i18n/lang/en.json'
import {beginNetworkDownload, clearNetworkDownloads, networkDownloads} from '@/client/networkActivity'
import {captureClientRequestContext} from '@/client/requestContext'

const credentials = vi.hoisted(() => ({id: 1, epoch: 1, token: 'token'}))
const auth = reactive({authUser: true, identityKey: '1:1', session: {id: 1, type: 1}})
vi.mock('@/stores/auth', () => ({useAuthStore: () => auth}))
vi.mock('@/helpers/auth', () => ({
	getToken: () => credentials.token,
	getTokenIdentity: () => ({id: credentials.id, type: 1}),
	getAuthSessionEpoch: () => credentials.epoch,
}))

function deferred() {
	let resolve!: (value: string[]) => void
	const promise = new Promise<string[]>(done => { resolve = done })
	return {promise, resolve}
}

describe('NetworkActivity shared request lifecycle', () => {
	let client: QueryClient
	let wrapper: VueWrapper
	beforeEach(() => {
		vi.useFakeTimers()
		credentials.id = 1
		credentials.epoch = 1
		auth.authUser = true
		auth.identityKey = '1:1'
		auth.session = {id: 1, type: 1}
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		wrapper = mount(NetworkActivity, {
			global: {
				plugins: [
					[VueQueryPlugin, {queryClient: client}],
					createI18n({legacy: false, locale: 'en', messages: {en}}),
				],
				stubs: {Icon: true, Teleport: true},
			},
		})
	})
	afterEach(() => {
		wrapper.unmount()
		client.clear()
		clearNetworkDownloads()
		vi.useRealTimers()
	})

	it('expands real overlapping cold reads, preserves the remaining task, and never invents list progress', async () => {
		const first = deferred()
		const second = deferred()
		const a = client.fetchQuery({queryKey: ['projects', 'list'], queryFn: () => first.promise})
		void a.catch(() => undefined)
		const b = client.fetchQuery({queryKey: ['tasks', 'list', 17, 'secret search'], queryFn: () => second.promise})
		void b.catch(() => undefined)
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
		await vi.advanceTimersByTimeAsync(1300)
		expect(wrapper.get('[role="status"]').text()).toBe('Loading Project list + 1 more…')
		await wrapper.get('.activity-toggle').trigger('click')
		expect(wrapper.get('.activity-toggle').attributes('aria-expanded')).toBe('true')
		expect(wrapper.text()).toContain('Project list')
		expect(wrapper.text()).toContain('Project tasks #17')
		expect(wrapper.text()).toContain('Waiting for the server · 1s elapsed')
		expect(wrapper.text()).not.toContain('secret search')
		expect(wrapper.text()).not.toContain('/s')
		expect(wrapper.find('progress').exists()).toBe(false)
		first.resolve(['project'])
		await a
		await nextTick()
		expect(wrapper.findAll('.activity-task')).toHaveLength(1)
		expect(wrapper.get('[role="status"]').text()).toContain('Project tasks #17')
		second.resolve(['task'])
		await b
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
	})

	it('ignores cached background refreshes, routine polls and explicit silent query metadata', async () => {
		const wait = deferred()
		client.setQueryData(['projects', 'list'], ['cached'])
		const requests = [
			client.fetchQuery({queryKey: ['projects', 'list'], queryFn: () => wait.promise}),
			client.fetchQuery({queryKey: ['notifications'], queryFn: () => wait.promise}),
			client.fetchQuery({queryKey: ['silent'], queryFn: () => wait.promise, meta: {networkActivity: false}}),
		]
		await vi.advanceTimersByTimeAsync(2000)
		expect(wrapper.find('aside').exists()).toBe(false)
		wait.resolve([])
		await Promise.all(requests)
	})

	it('keeps a failed cold read visible with its actual retry stage', async () => {
		const wait = deferred()
		let calls = 0
		const request = client.fetchQuery({
			queryKey: ['projects', 'list'],
			queryFn: () => ++calls === 1 ? Promise.reject(new Error('temporary outage')) : wait.promise,
			retry: 1,
			retryDelay: 2000,
		})
		void request.catch(() => undefined)
		await vi.advanceTimersByTimeAsync(1300)
		await wrapper.get('.activity-toggle').trigger('click')
		expect(wrapper.text()).toContain('Retrying · 1s elapsed')
		await vi.advanceTimersByTimeAsync(800)
		expect(calls).toBe(2)
		wait.resolve([])
		await request
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
	})

	it('removes a cancelled query, resets a dismissed batch, and shows a new cold read', async () => {
		const first = deferred()
		const request = client.fetchQuery({
			queryKey: ['projects', 'detail', 8],
			queryFn: ({signal}) => { void signal; return first.promise },
		}).catch(() => undefined)
		await vi.advanceTimersByTimeAsync(1300)
		await wrapper.get('.activity-dismiss').trigger('click')
		expect(wrapper.find('aside').exists()).toBe(false)
		await client.cancelQueries({queryKey: ['projects', 'detail', 8]})
		await request
		await nextTick()
		const second = deferred()
		const next = client.fetchQuery({queryKey: ['drive', 'list', {}], queryFn: () => second.promise})
		await vi.advanceTimersByTimeAsync(1300)
		expect(wrapper.get('[role="status"]').text()).toBe('Loading Drive list…')
		first.resolve(['late'])
		second.resolve([])
		await next
	})

	it('clears old query and download tasks on identity change without treating token refresh as logout', async () => {
		const wait = deferred()
		const request = client.fetchQuery({queryKey: ['projects', 'list'], queryFn: () => wait.promise})
		void request.catch(() => undefined)
		const download = beginNetworkDownload({resource: 'file', resourceId: 32}, captureClientRequestContext(), new AbortController().signal)
		await vi.advanceTimersByTimeAsync(1300)
		expect(wrapper.get('[role="status"]').text()).toBe('Loading Project list + 1 more…')
		credentials.token = 'refreshed-token'
		auth.session = {id: 1, type: 1}
		await nextTick()
		expect(wrapper.get('[role="status"]').text()).toBe('Loading Project list + 1 more…')
		// The auth store clears shared queries before publishing the new identity.
		client.clear()
		credentials.id = 2
		auth.session = {id: 2, type: 1}
		auth.identityKey = '2:1'
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
		expect(networkDownloads.value).toHaveLength(0)
		wait.resolve(['late private result'])
		await request.catch(() => undefined)
		download?.finish()
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
	})

	it('shows actual byte progress only after chunks arrive, and hides a stale speed sample', async () => {
		const download = beginNetworkDownload({resource: 'file', resourceId: 19}, captureClientRequestContext(), new AbortController().signal)!
		let body!: ReadableStreamDefaultController<Uint8Array>
		const response = download.observe(new Response(new ReadableStream<Uint8Array>({
			start(controller) { body = controller },
		}), {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': '4096'}}))
		const read = response.blob()
		await vi.advanceTimersByTimeAsync(1300)
		await wrapper.get('.activity-toggle').trigger('click')
		expect(wrapper.text()).toContain('Reading response')
		expect(wrapper.find('progress').exists()).toBe(false)
		expect(wrapper.text()).not.toContain('/s')
		body.enqueue(new Uint8Array(1024))
		await flushPromises()
		expect(wrapper.get('progress').attributes('value')).toBe('1024')
		expect(wrapper.get('progress').attributes('max')).toBe('4096')
		expect(wrapper.text()).toContain('1.0 KiB of 4.0 KiB read')
		expect(wrapper.text()).not.toContain('/s')
		await vi.advanceTimersByTimeAsync(1000)
		body.enqueue(new Uint8Array(1024))
		await flushPromises()
		expect(wrapper.text()).toContain('1.0 KiB/s')
		await vi.advanceTimersByTimeAsync(2500)
		expect(wrapper.text()).not.toContain('/s')
		body.close()
		await read
		download.finish()
		await nextTick()
		expect(wrapper.find('aside').exists()).toBe(false)
	})

	it('shows measured progress while collapsed and releases it when the real response finishes', async () => {
		const download = beginNetworkDownload(
			{resource: 'file', resourceId: 21},
			captureClientRequestContext(),
			new AbortController().signal,
		)!
		let body!: ReadableStreamDefaultController<Uint8Array>
		const response = download.observe(new Response(new ReadableStream<Uint8Array>({
			start(controller) { body = controller },
		}), {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': '4096'}}))
		const read = response.blob()
		await vi.advanceTimersByTimeAsync(1300)
		expect(wrapper.get('.activity-toggle').attributes('aria-expanded')).toBe('false')
		expect(wrapper.get('[role="status"]').text()).toBe('Loading File #21…')
		expect(wrapper.get('.activity-secondary').text()).toBe('Reading response · 1s elapsed')
		body.enqueue(new Uint8Array(1024))
		await flushPromises()
		expect(wrapper.get('.activity-secondary').text()).toContain('1.0 KiB of 4.0 KiB read · 25%')
		expect(wrapper.get('.activity-secondary').text()).not.toContain('/s')
		await vi.advanceTimersByTimeAsync(1000)
		body.enqueue(new Uint8Array(1024))
		await flushPromises()
		expect(wrapper.get('.activity-secondary').text()).toContain('2.0 KiB of 4.0 KiB read · 50% · 1.0 KiB/s')
		expect(wrapper.get('.activity-toggle').attributes('aria-expanded')).toBe('false')
		expect(wrapper.get('[role="status"]').text()).toBe('Loading File #21…')
		body.close()
		await read
		download.finish()
		await nextTick()
		expect(networkDownloads.value).toHaveLength(0)
		expect(wrapper.find('aside').exists()).toBe(false)
	})
})
