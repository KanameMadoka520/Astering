import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {useNativeNotificationSync} from './useNativeNotificationSync'

const state = vi.hoisted(() => ({epoch: 1, identity: true, native: true}))
const bridge = vi.hoisted(() => ({getNativeAndroidClientInfo: vi.fn(), requestNativeAndroid: vi.fn()}))
vi.mock('@/helpers/nativeAndroid', () => ({...bridge, isNativeAndroid: () => state.native}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => ({epoch: state.epoch, identity: state.identity ? {id: 1, type: 1} : null}),
	isClientRequestContextCurrent: (context: {epoch: number}) => context.epoch === state.epoch,
}))

let client: QueryClient
let wrapper: VueWrapper
beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime('2026-11-16T12:00:00Z')
	Object.assign(state, {epoch: 1, identity: true, native: true})
	bridge.getNativeAndroidClientInfo.mockReset().mockResolvedValue({capabilities: {deviceNotifications: true}})
	bridge.requestNativeAndroid.mockReset().mockResolvedValue({})
	client = new QueryClient()
	wrapper = mount(defineComponent({setup() {useNativeNotificationSync(); return () => null}}), {
		global: {plugins: [[VueQueryPlugin, {queryClient: client}]]},
	})
})
afterEach(() => {wrapper.unmount(); client.clear(); vi.clearAllTimers(); vi.useRealTimers()})

it('coalesces task, project and notification changes into a credential-free reminder refresh', async () => {
	client.setQueryData(['tasks', 'detail', 1], {done: true})
	client.setQueryData(['projects', 'list'], [])
	client.setQueryData(['notifications'], [])
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.requestNativeAndroid).toHaveBeenCalledExactlyOnceWith('notificationsReadChanged')
	client.setQueryData(['tasks', 'detail', 2], {done: false})
	await vi.advanceTimersByTimeAsync(29_999)
	expect(bridge.requestNativeAndroid).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(1)
	expect(bridge.requestNativeAndroid).toHaveBeenCalledTimes(2)
})

it('does not request native capabilities for unrelated data or ordinary browsers', async () => {
	client.setQueryData(['compass', 'space', 1], {})
	state.native = false
	client.setQueryData(['tasks', 'detail', 1], {})
	await vi.advanceTimersByTimeAsync(60_000)
	expect(bridge.getNativeAndroidClientInfo).not.toHaveBeenCalled()
	expect(bridge.requestNativeAndroid).not.toHaveBeenCalled()
})

it('leaves older clients and logged-out pages alone', async () => {
	state.identity = false
	client.setQueryData(['tasks'], [])
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.getNativeAndroidClientInfo).not.toHaveBeenCalled()
	state.identity = true
	bridge.getNativeAndroidClientInfo.mockResolvedValue({capabilities: {clientSettings: true}})
	client.setQueryData(['tasks'], [{id: 1}])
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.requestNativeAndroid).not.toHaveBeenCalled()
})

it('drops pending account work and detached observers', async () => {
	client.setQueryData(['notifications'], [])
	state.epoch++
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.getNativeAndroidClientInfo).not.toHaveBeenCalled()
	client.setQueryData(['tasks'], [])
	wrapper.unmount()
	await vi.advanceTimersByTimeAsync(60_000)
	expect(bridge.requestNativeAndroid).not.toHaveBeenCalled()
})

it('does not send a late capability response into a different account', async () => {
	let resolve!: (value: unknown) => void
	bridge.getNativeAndroidClientInfo.mockReturnValue(new Promise(done => {resolve = done}))
	client.setQueryData(['notifications'], [])
	await vi.advanceTimersByTimeAsync(1500)
	client.setQueryData(['tasks'], [])
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.getNativeAndroidClientInfo).toHaveBeenCalledTimes(1)
	state.epoch++
	resolve({capabilities: {deviceNotifications: true}})
	await flushPromises()
	expect(bridge.requestNativeAndroid).not.toHaveBeenCalled()
})

it('refreshes off-screen reminder plans when a write only invalidates board, calendar or routine data', async () => {
	for (const root of ['kanban', 'calendar-tasks', 'task-routine']) {
		client.setQueryData([root, 'inactive'], {})
	}
	await vi.advanceTimersByTimeAsync(1500)
	expect(bridge.requestNativeAndroid).toHaveBeenCalledTimes(1)
	await client.invalidateQueries({queryKey: ['kanban'], refetchType: 'none'})
	await client.invalidateQueries({queryKey: ['calendar-tasks'], refetchType: 'none'})
	await client.invalidateQueries({queryKey: ['task-routine'], refetchType: 'none'})
	await vi.advanceTimersByTimeAsync(30_000)
	expect(bridge.requestNativeAndroid).toHaveBeenCalledTimes(2)
})
