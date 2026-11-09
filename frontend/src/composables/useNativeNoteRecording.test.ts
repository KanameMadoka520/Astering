import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, ref} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import type {NativeAndroidEvent, NativeRecordingSnapshot} from '@/helpers/nativeAndroid'
import {removeToken, saveToken} from '@/helpers/auth'
import {useNativeNoteRecording} from './useNativeNoteRecording'

const native = vi.hoisted(() => ({
	request: vi.fn(),
	listeners: new Set<(event: NativeAndroidEvent) => void>(),
}))
vi.mock('@/helpers/nativeAndroid', () => ({
	requestNativeAndroid: native.request,
	isNativeAndroid: () => false,
	nativeAndroidSession: vi.fn(),
	onNativeAndroidEvent: (listener: (event: NativeAndroidEvent) => void) => {
		native.listeners.add(listener)
		return () => { native.listeners.delete(listener) }
	},
}))

function login(id = 1, sid = 'sid-1') {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1, sid}))}.fixture`, false)
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => { resolve = done })
	return {promise, resolve}
}

function snapshot(changes: Partial<NativeRecordingSnapshot> = {}): NativeRecordingSnapshot {
	return {
		user_id: 1,
		sid: 'sid-1',
		note_id: 4,
		sequence: 1,
		allow_background: false,
		state: 'idle',
		...changes,
	}
}

function emit(changes: Partial<NativeRecordingSnapshot>) {
	const event: NativeAndroidEvent = {event: 'recording', snapshot: snapshot(changes)}
	for (const listener of native.listeners) listener(event)
}

function receipt() {
	return {
		segment: {
			id: 9,
			note_id: 4,
			client_id: '28f978b8-32ae-435e-aa3e-e4a1ab39f43c',
			text: 'A committed sentence',
			start_ms: 0,
			end_ms: 1000,
			created: '2026-11-09T12:00:00Z',
		},
		stats: {segment_count: 1, transcript_bytes: 20, updated: '2026-11-09T12:00:00Z'},
	}
}

describe('native note recording lifecycle', () => {
	let client: QueryClient
	let wrappers: VueWrapper[]
	let sequence: number

	function harness(background = false, awake = false) {
		const noteID = ref(4)
		const onSegment = vi.fn()
		let recorder!: ReturnType<typeof useNativeNoteRecording>
		const wrapper = mount(defineComponent({
			setup() {
				recorder = useNativeNoteRecording({
					noteID: () => noteID.value,
					connectionID: () => 'speech-connection',
					sampleRate: () => 16000,
					language: () => 'zh-CN',
					allowBackground: () => background,
					keepAwake: () => awake,
					onSegment,
				})
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		wrappers.push(wrapper)
		return {recorder, wrapper, onSegment, noteID}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		window.API_URL = 'https://task.tcymc.space/api/v2'
		removeToken()
		login()
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		wrappers = []
		sequence = 0
		native.request.mockImplementation(async (action: string, data?: Record<string, unknown>) => {
			if (action === 'session') return {}
			if (action === 'recordingStatus') return snapshot({sequence: ++sequence})
			if (action === 'startRecording') return snapshot({
				sequence: ++sequence,
				state: 'recording',
				allow_background: data?.allow_background === true,
			})
			if (action === 'stopRecording') return snapshot({sequence: ++sequence, state: 'idle'})
			throw new Error(`Unexpected native action: ${action}`)
		})
	})

	afterEach(() => {
		wrappers.forEach(wrapper => wrapper.unmount())
		client.clear()
		removeToken()
		vi.restoreAllMocks()
	})

	it('only restores status on mount and starts capture after an explicit action', async () => {
		const h = harness(true, true)
		await flushPromises()
		expect(native.request.mock.calls.map(([action]) => action)).toEqual(['session', 'recordingStatus'])
		expect(h.recorder.active.value).toBe(false)
		await h.recorder.start()
		expect(native.request).toHaveBeenCalledWith('startRecording', expect.objectContaining({
			note_id: 4,
			connection_id: 'speech-connection',
			sample_rate: 16000,
			allow_background: true,
			keep_awake: true,
		}), 120_000)
		expect(h.recorder.state.value).toBe('recording')
	})

	it('ignores a late mount status after a newer native event', async () => {
		const status = deferred<NativeRecordingSnapshot>()
		native.request.mockImplementation(async (action: string) => action === 'recordingStatus' ? status.promise : {})
		const h = harness()
		await flushPromises()
		emit({sequence: 2, state: 'recording', partial: 'newer native progress', allow_background: true})
		status.resolve(snapshot({sequence: 1, state: 'idle'}))
		await flushPromises()
		expect(h.recorder.state.value).toBe('recording')
		expect(h.recorder.partial.value).toBe('newer native progress')
	})

	it('does not let a mount status or older start reply undo a pending manual start', async () => {
		const status = deferred<NativeRecordingSnapshot>()
		const started = deferred<NativeRecordingSnapshot>()
		native.request.mockImplementation(async (action: string) => {
			if (action === 'recordingStatus') return status.promise
			if (action === 'startRecording') return started.promise
			return {}
		})
		const h = harness(true)
		await flushPromises()
		const starting = h.recorder.start()
		await flushPromises()
		status.resolve(snapshot({sequence: 1}))
		await flushPromises()
		expect(h.recorder.state.value).toBe('permission')
		emit({sequence: 3, state: 'recording', partial: 'live text', allow_background: true})
		started.resolve(snapshot({sequence: 2, state: 'connecting', allow_background: true}))
		await starting
		expect(h.recorder.state.value).toBe('recording')
		expect(h.recorder.partial.value).toBe('live text')
	})

	it('restores the active run background choice when remounting without stopping the microphone', async () => {
		native.request.mockImplementation(async (action: string) => action === 'recordingStatus'
			? snapshot({sequence: ++sequence, state: 'recording', allow_background: true})
			: {})
		const first = harness(false)
		await flushPromises()
		expect(first.recorder.active.value).toBe(true)
		first.wrapper.unmount()
		const reopened = harness(false)
		await flushPromises()
		expect(reopened.recorder.active.value).toBe(true)
		reopened.wrapper.unmount()
		expect(native.request.mock.calls.filter(([action]) => action === 'stopRecording')).toHaveLength(0)
		expect(native.request.mock.calls.filter(([action]) => action === 'startRecording')).toHaveLength(0)
	})

	it.each([false, true])('cancels pending permission on detach with the original note and sid (background=%s)', async background => {
		const started = deferred<NativeRecordingSnapshot>()
		native.request.mockImplementation(async (action: string) => {
			if (action === 'startRecording') return started.promise
			if (action === 'session') return {}
			return snapshot({sequence: ++sequence})
		})
		const h = harness(background)
		await flushPromises()
		const starting = h.recorder.start()
		await flushPromises()
		expect(h.recorder.state.value).toBe('permission')
		h.wrapper.unmount()
		await flushPromises()
		expect(native.request).toHaveBeenCalledWith('stopRecording', {note_id: 4, sid: 'sid-1'}, 45_000)
		started.resolve(snapshot({sequence: ++sequence, state: 'recording'}))
		await starting
		expect(h.onSegment).not.toHaveBeenCalled()
	})

	it('validates identity, session and note before accepting a sequence or a committed segment', async () => {
		const h = harness(true)
		await flushPromises()
		const saved = receipt()
		emit({...saved, sequence: 100, user_id: 2, state: 'recording'})
		emit({...saved, sequence: 100, sid: 'other-session', state: 'recording'})
		emit({...saved, sequence: 100, note_id: 5, state: 'recording'})
		emit({...saved, sequence: 100, state: 'unknown-native-state'})
		expect(h.onSegment).not.toHaveBeenCalled()
		emit({...saved, sequence: 2, state: 'recording', allow_background: true})
		emit({...saved, sequence: 3, state: 'recording', allow_background: true})
		expect(h.onSegment).toHaveBeenCalledExactlyOnceWith(saved)
		emit({sequence: 4, state: 'recording', segment: {...saved.segment, id: 10, note_id: 5}, stats: saved.stats})
		expect(h.onSegment).toHaveBeenCalledTimes(1)
	})

	it.each(['account', 'sid', 'epoch', 'api'])('ignores late events and results after the %s changes', async change => {
		const status = deferred<NativeRecordingSnapshot>()
		native.request.mockImplementation(async (action: string) => action === 'recordingStatus' ? status.promise : {})
		const h = harness()
		await flushPromises()
		if (change === 'account') login(2, 'sid-2')
		else if (change === 'sid') login(1, 'sid-2')
		else if (change === 'epoch') { removeToken(); login() }
		else window.API_URL = 'https://other.example/api/v2'
		emit({...receipt(), sequence: 3, state: 'recording'})
		status.resolve(snapshot({...receipt(), sequence: 4, state: 'recording'}))
		await flushPromises()
		await h.recorder.start()
		await h.recorder.stop()
		expect(h.recorder.state.value).toBe('idle')
		expect(h.onSegment).not.toHaveBeenCalled()
		expect(native.request.mock.calls.map(([action]) => action)).toEqual(['session', 'recordingStatus'])
	})

	it('coalesces stop and targets the admitted recording after the page note changes', async () => {
		const stopped = deferred<NativeRecordingSnapshot>()
		const h = harness(true)
		await flushPromises()
		await h.recorder.start()
		h.noteID.value = 8
		native.request.mockImplementationOnce(() => stopped.promise)
		const first = h.recorder.stop()
		const duplicate = h.recorder.stop()
		expect(h.recorder.state.value).toBe('stopping')
		expect(native.request.mock.calls.filter(([action]) => action === 'stopRecording')).toEqual([
			['stopRecording', {note_id: 4, sid: 'sid-1'}, 45_000],
		])
		stopped.resolve(snapshot({sequence: ++sequence}))
		await Promise.all([first, duplicate])
	})

	it.each(['native_timeout', 'already_recording'])('cleans up a timed-out start without stopping an existing recording on %s', async code => {
		const h = harness(true)
		await flushPromises()
		native.request.mockImplementation(async (action: string) => {
			if (action === 'startRecording') throw new Error(code)
			if (action === 'stopRecording') return snapshot({sequence: ++sequence})
			return {}
		})
		await h.recorder.start()
		expect(h.recorder.state.value).toBe('paused')
		expect(h.recorder.error.value).toBe(code)
		const stops = native.request.mock.calls.filter(([action]) => action === 'stopRecording')
		expect(stops).toEqual(code === 'native_timeout' ? [
			['stopRecording', {note_id: 4, sid: 'sid-1'}, 45_000],
		] : [])
	})
})
