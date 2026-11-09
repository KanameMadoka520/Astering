import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {onlineManager, QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {accountKeys, type UserInfoResponse} from '@/client/queries/account'
import {removeToken, saveToken} from '@/helpers/auth'
import {useLiveNotePreferences} from './useLiveNotePreferences'

const sdk = vi.hoisted(() => ({
	patchUserSettingsRead: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/client/queries/avatars', () => ({invalidateAvatarQueries: vi.fn()}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))

function login(id = 1) {
	saveToken(`fixture.${btoa(JSON.stringify({id, type: 1}))}.fixture`, false)
}

function account(id = 1, background = true, awake = false): UserInfoResponse {
	return {
		id,
		username: `person-${id}`,
		name: '',
		is_admin: false,
		is_local_user: true,
		settings: {frontend_settings: {
			sidebar_width: 367,
			live_notes_allow_background: background,
			live_notes_keep_awake: awake,
		}},
	}
}

describe('account-owned recording preferences', () => {
	let client: QueryClient
	let server: UserInfoResponse
	let wrappers: VueWrapper[]
	const microphone = vi.fn()

	function harness() {
		let preferences!: ReturnType<typeof useLiveNotePreferences>
		const wrapper = mount(defineComponent({
			setup() {
				preferences = useLiveNotePreferences()
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}]]}})
		wrappers.push(wrapper)
		return {preferences, wrapper}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		window.API_URL = 'https://notes.example'
		removeToken()
		login()
		vi.stubGlobal('navigator', {language: 'en-US', mediaDevices: {getUserMedia: microphone}})
		client = new QueryClient({defaultOptions: {
			queries: {retry: false, staleTime: Infinity},
			mutations: {retry: false},
		}})
		wrappers = []
		server = account()
		client.setQueryData(accountKeys.user(1), structuredClone(server))
		sdk.userShow.mockImplementation(async () => ({data: structuredClone(server)}))
		sdk.patchUserSettingsRead.mockImplementation(async ({body}: {
			body: {frontend_settings: Record<string, unknown>},
		}) => {
			server = {...server, settings: {...server.settings, frontend_settings: {
				...(server.settings?.frontend_settings as object),
				...body.frontend_settings,
			}}}
			return {data: {message: 'saved'}, response: {status: 200}}
		})
	})

	afterEach(() => {
		wrappers.forEach(wrapper => wrapper.unmount())
		client.clear()
		onlineManager.setOnline(true)
		removeToken()
		vi.unstubAllGlobals()
	})

	it('restores choices without starting audio and remembers an explicit false after reopening', async () => {
		const first = harness()
		expect(first.preferences.ready.value).toBe(true)
		expect(first.preferences.allowBackground.value).toBe(true)
		expect(first.preferences.keepAwake.value).toBe(false)
		expect(sdk.patchUserSettingsRead).not.toHaveBeenCalled()
		expect(microphone).not.toHaveBeenCalled()
		await first.preferences.setPreference('live_notes_allow_background', false)
		expect(sdk.patchUserSettingsRead.mock.calls[0][0].body).toEqual({frontend_settings: {
			live_notes_allow_background: false,
		}})
		expect(server.settings?.frontend_settings).toMatchObject({
			sidebar_width: 367,
			live_notes_allow_background: false,
			live_notes_keep_awake: false,
		})
		first.wrapper.unmount()
		const reopened = harness()
		expect(reopened.preferences.allowBackground.value).toBe(false)
		expect(reopened.preferences.status.value).toBe('idle')
		expect(microphone).not.toHaveBeenCalled()
	})

	it('keeps a failed choice through stale account reads and retries only edited keys', async () => {
		const h = harness().preferences
		sdk.patchUserSettingsRead.mockRejectedValueOnce(new Error('offline'))
		await h.setPreference('live_notes_keep_awake', true)
		expect(h.status.value).toBe('error')
		expect(h.keepAwake.value).toBe(true)
		client.setQueryData(accountKeys.user(1), account(1, false, false))
		await flushPromises()
		expect(h.allowBackground.value).toBe(false)
		expect(h.keepAwake.value).toBe(true)
		await h.retry()
		expect(h.status.value).toBe('saved')
		expect(h.keepAwake.value).toBe(true)
		expect(sdk.patchUserSettingsRead.mock.calls.map(([input]) => input.body)).toEqual([
			{frontend_settings: {live_notes_keep_awake: true}},
			{frontend_settings: {live_notes_keep_awake: true}},
		])
	})

	it('does not enable changes before settings load and can recover a failed initial read', async () => {
		client.removeQueries({queryKey: accountKeys.user(1)})
		sdk.userShow.mockRejectedValueOnce(new Error('unavailable'))
		const h = harness().preferences
		await h.setPreference('live_notes_keep_awake', true)
		expect(sdk.patchUserSettingsRead).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(h.loadFailed.value).toBe(true))
		expect(h.ready.value).toBe(false)
		await h.reload()
		await vi.waitFor(() => expect(h.ready.value).toBe(true))
		expect(h.allowBackground.value).toBe(true)
		expect(microphone).not.toHaveBeenCalled()
	})

	it('guards repeated changes while a write is pending', async () => {
		let resolve!: (value: unknown) => void
		sdk.patchUserSettingsRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
		const h = harness().preferences
		const first = h.setPreference('live_notes_keep_awake', true)
		await vi.waitFor(() => expect(sdk.patchUserSettingsRead).toHaveBeenCalledTimes(1))
		await h.setPreference('live_notes_allow_background', false)
		await h.retry()
		expect(sdk.patchUserSettingsRead).toHaveBeenCalledTimes(1)
		expect(h.allowBackground.value).toBe(true)
		server = account(1, true, true)
		resolve({data: {}, response: {status: 200}})
		await first
		expect(h.status.value).toBe('saved')
	})

	it.each(['account', 'session', 'api', 'unmount'])('ignores old handlers and late completions after %s changes', async change => {
		let resolve!: (value: unknown) => void
		sdk.patchUserSettingsRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
		const h = harness()
		const pending = h.preferences.setPreference('live_notes_keep_awake', true)
		await vi.waitFor(() => expect(sdk.patchUserSettingsRead).toHaveBeenCalledTimes(1))
		if (change === 'account') login(2)
		else if (change === 'session') { removeToken(); login() }
		else if (change === 'api') window.API_URL = 'https://other.example'
		else h.wrapper.unmount()
		const newAccount = account(2, false, false)
		client.setQueryData(accountKeys.user(2), newAccount)
		await h.preferences.setPreference('live_notes_allow_background', false)
		await h.preferences.retry()
		resolve({data: {}, response: {status: 200}})
		await pending
		expect(sdk.patchUserSettingsRead).toHaveBeenCalledTimes(1)
		// Unmounting does not cancel an already committed account setting; its shared cache may reconcile.
		if (change === 'unmount') expect(sdk.userShow).toHaveBeenCalledTimes(1)
		else expect(sdk.userShow).not.toHaveBeenCalled()
		expect(client.getQueryData(accountKeys.user(2))).toEqual(newAccount)
		expect(h.preferences.status.value).toBe('saving')
		if (change === 'account') {
			const own = harness().preferences
			expect(own.allowBackground.value).toBe(false)
			expect(own.keepAwake.value).toBe(false)
		}
	})

	it('does not send an offline queued preference after switching accounts', async () => {
		const h = harness().preferences
		onlineManager.setOnline(false)
		const pending = h.setPreference('live_notes_keep_awake', true)
		await flushPromises()
		login(2)
		onlineManager.setOnline(true)
		await client.resumePausedMutations()
		await pending
		expect(sdk.patchUserSettingsRead).not.toHaveBeenCalled()
		expect(sdk.userShow).not.toHaveBeenCalled()
	})
})
