import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {noteKeys, normalizeNote} from '@/client/queries/notes'
import {removeToken, saveToken} from '@/helpers/auth'
import type {NativeAndroidEvent, NativeOfflineStatus} from '@/helpers/nativeAndroid'
import {useOfflineNoteSync} from './useOfflineNoteSync'

const native = vi.hoisted(() => ({
	request: vi.fn(),
	listeners: new Set<(event: NativeAndroidEvent) => void>(),
}))
vi.mock('@/helpers/nativeAndroid', () => ({
	requestNativeAndroid: native.request,
	isNativeAndroid: () => true,
	nativeAndroidSession: vi.fn(),
	onNativeAndroidEvent: (listener: (event: NativeAndroidEvent) => void) => {
		native.listeners.add(listener)
		return () => { native.listeners.delete(listener) }
	},
}))

function login(id = 1) {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1, sid: `sid-${id}`}))}.fixture`, true)
}

function status(user = 1): NativeOfflineStatus {
	return {
		user_id: user,
		available: true,
		ready: true,
		engine: 'local',
		model_id: 'sensevoice-test',
		model: 'SenseVoiceSmall int8',
		bytes: 240193589,
		sample_rate: 16000,
		pending_count: 1,
		pending_bytes: 100,
		max_pending_count: 2000,
		max_pending_bytes: 8388608,
		audio_persisted: false,
	}
}

describe('account-bound native transcript synchronization', () => {
	let client: QueryClient
	let wrapper: VueWrapper
	let sync: ReturnType<typeof useOfflineNoteSync>
	beforeEach(async () => {
		vi.clearAllMocks()
		window.API_URL = 'https://task.tcymc.space/api/v2'
		removeToken()
		login()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		native.request.mockImplementation(async (action: string) => {
			if (action === 'session') return {}
			return status()
		})
		wrapper = mount(defineComponent({
			setup() {
				sync = useOfflineNoteSync()
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		await flushPromises()
	})
	afterEach(() => {
		wrapper.unmount()
		client.clear()
		removeToken()
	})

	it('only reads capability on mount; an event for another account cannot update its private note', () => {
		expect(native.request.mock.calls.map(([name]) => name)).toEqual(['session', 'offlineStatus'])
		expect(sync.available.value).toBe(true)
		client.setQueryData(noteKeys.detail(4), normalizeNote({id: 4, title: 'private', revision: 1}))
		for (const listener of native.listeners) listener({event: 'offline', user_id: 2, status: status(2), receipt: {
			segment: {id: 9, note_id: 4, text: 'other account'},
			stats: {segment_count: 8, transcript_bytes: 123, updated: '2026-11-09T00:00:00Z'},
		}})
		expect(sync.status.value?.user_id).toBe(1)
		expect(client.getQueryData(noteKeys.detail(4))).toMatchObject({segment_count: 0})
	})

	it('ignores a late decrypted page after an identity change', async () => {
		let resolve!: (value: unknown) => void
		native.request.mockReturnValueOnce(new Promise(done => { resolve = done }))
		const pending = sync.loadPage('opaque-cursor')
		login(2)
		resolve({entries: [{client_id: 'one', note_id: 4, text: 'old private text'}], status: status(), has_more: false})
		await pending
		expect(sync.page.value).toBeUndefined()
		expect(sync.available.value).toBe(false)
	})

	it('uses opaque paging and only sends destructive confirmation after the explicit clear action', async () => {
		native.request.mockResolvedValueOnce({entries: [], status: status(), has_more: false, next_cursor: ''})
		await sync.loadPage('fixed-cursor')
		expect(native.request).toHaveBeenCalledWith('listOffline', {cursor: 'fixed-cursor', limit: 20})
		expect(native.request.mock.calls.some(([name]) => name === 'clearOffline')).toBe(false)
		await sync.clear()
		expect(native.request).toHaveBeenCalledWith('clearOffline', {confirm: true})
	})

	it('distinguishes a bundled model from a verified account and rechecks only on an explicit sync', async () => {
		const unverified = {
			...status(),
			ready: false,
			pending_count: 0,
			pending_bytes: 0,
			sync_error: 'network',
		}
		for (const listener of native.listeners) listener({
			event: 'offline',
			user_id: 1,
			status: unverified,
		})
		expect(sync.builtIn.value).toBe(true)
		expect(sync.available.value).toBe(false)
		native.request.mockImplementation(async (action: string) => {
			if (action === 'session') return {}
			return unverified
		})
		native.request.mockClear()
		await sync.sync()
		expect(native.request.mock.calls.map(([name]) => name)).toEqual(['session', 'syncOffline'])
		expect(sync.available.value).toBe(false)
		for (const listener of native.listeners) listener({
			event: 'offline',
			user_id: 1,
			status: status(),
		})
		expect(sync.available.value).toBe(true)
	})

	it('keeps old APK capability discovery quiet instead of reporting a broken recording feature', async () => {
		native.request.mockImplementation(async (action: string) => {
			if (action === 'session') return {}
			throw new Error('unsupported_action')
		})
		await sync.reload()
		expect(sync.unsupported.value).toBe(true)
		expect(sync.builtIn.value).toBe(false)
		expect(sync.available.value).toBe(false)
		expect(sync.failed.value).toBe(false)
	})

	it('does not treat a wrong-owner clear receipt as a completed action', async () => {
		native.request.mockImplementation(async (action: string) => {
			if (action === 'session') return {}
			return status(2)
		})
		await sync.clear()
		expect(sync.failed.value).toBe(true)
		expect(sync.status.value?.user_id).toBe(1)
		expect(sync.status.value?.pending_count).toBe(1)
	})

	it('rejects a decrypted page belonging to another account before exposing its text', async () => {
		native.request.mockResolvedValueOnce({
			entries: [{client_id: '8092b580-e221-4ac4-bb4b-f2a2962da93d', note_id: 4, text: 'another owner'}],
			status: status(2),
			has_more: false,
			next_cursor: '',
		})
		await sync.loadPage()
		expect(sync.page.value).toBeUndefined()
		expect(sync.pageFailed.value).toBe(true)
		expect(sync.status.value?.user_id).toBe(1)
	})
})
