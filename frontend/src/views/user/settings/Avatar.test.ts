import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import {defineComponent, h} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import Avatar from './Avatar.vue'
import testid from '@/directives/testid'
import en from '@/i18n/lang/en.json'

const sdk = vi.hoisted(() => ({
	userGetAvatarProvider: vi.fn(),
	userSetAvatarProvider: vi.fn(),
	userAvatarUpload: vi.fn(),
	avatarGet: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/composables/useTitle', () => ({useTitle: vi.fn()}))
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => ({info: {username: 'user1'}})}))

const cropped = new Blob(['cropped'], {type: 'image/png'})
vi.mock('vue-advanced-cropper', () => ({
	Cropper: defineComponent({
		name: 'Cropper',
		props: {src: {type: String, default: ''}},
		emits: ['ready'],
		setup: () => ({
			getResult: () => ({canvas: {toBlob: (done: (blob: Blob) => void) => done(cropped)}}),
		}),
		render() { return h('div', {class: 'vue-advanced-cropper'}) },
	}),
}))

let wrapper: VueWrapper
beforeEach(() => {
	window.TESTING = true
	for (const fn of Object.values(sdk)) fn.mockReset()
	sdk.userGetAvatarProvider.mockResolvedValue({data: {avatar_provider: 'upload'}})
	sdk.userAvatarUpload.mockResolvedValue({data: {message: 'ok'}})
})
afterEach(() => {
	wrapper?.unmount()
	delete window.TESTING
})

async function mountAvatar() {
	wrapper = mount(Avatar, {
		global: {
			plugins: [
				createI18n({legacy: false, locale: 'en', messages: {en}}),
				[VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}],
			],
			directives: {cy: testid},
			stubs: {
				Card: {template: '<div><slot /><slot name="footer" /></div>'},
				XButton: {
					props: {loading: Boolean},
					emits: ['click'],
					template: '<button type="button" :disabled="loading" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	})
	await flushPromises()
	return wrapper
}

async function pick(file: File) {
	const input = wrapper.get<HTMLInputElement>('input[type=file]')
	// happy-dom accepts any list here; resetting the value swaps in a fresh empty FileList.
	input.element.files = [file] as unknown as FileList
	await input.trigger('change')
	return input.element
}

describe('Avatar settings', () => {
	it('uploads the picked file as is and clears the picker when cropping is off', async () => {
		await mountAvatar()
		const file = new File(['raw'], 'me.jpg', {type: 'image/jpeg'})

		const input = await pick(file)
		await flushPromises()

		expect(sdk.userAvatarUpload).toHaveBeenCalledOnce()
		expect(sdk.userAvatarUpload.mock.calls[0][0].body.avatar).toBe(file)
		expect(input.files).toHaveLength(0)
		expect(wrapper.find('.vue-advanced-cropper').exists()).toBe(false)
	})

	it('crops first when asked, keeping the upload button busy until the cropper is ready', async () => {
		await mountAvatar()
		await wrapper.get<HTMLInputElement>('input[type=checkbox]').setValue(true)

		const input = await pick(new File(['raw'], 'me.jpg', {type: 'image/jpeg'}))
		// The picker is cleared at once so picking the same file again still fires change.
		expect(input.files).toHaveLength(0)
		await vi.waitFor(() => expect(wrapper.find('.vue-advanced-cropper').exists()).toBe(true))
		expect(sdk.userAvatarUpload).not.toHaveBeenCalled()
		expect(wrapper.getComponent({name: 'Cropper'}).props('src')).toMatch(/^data:image\/jpeg;base64,/)

		const upload = wrapper.get('[data-cy="uploadAvatar"]')
		expect(upload.attributes('disabled')).toBeDefined()
		wrapper.getComponent({name: 'Cropper'}).vm.$emit('ready')
		await flushPromises()
		expect(upload.attributes('disabled')).toBeUndefined()

		await upload.trigger('click')
		await flushPromises()

		expect(sdk.userAvatarUpload).toHaveBeenCalledOnce()
		const sent: File = sdk.userAvatarUpload.mock.calls[0][0].body.avatar
		expect(sent.name).toBe('avatar.png')
		expect(await sent.text()).toBe('cropped')
		expect(wrapper.find('.vue-advanced-cropper').exists()).toBe(false)
	})

	it('does not show "Default" as the saved source when it failed to load, and offers a retry', async () => {
		sdk.userGetAvatarProvider.mockReset()
		sdk.userGetAvatarProvider.mockRejectedValueOnce(new Error('Server error'))
		await mountAvatar()

		expect(wrapper.find('input[type=radio]').exists()).toBe(false)
		expect(wrapper.text()).not.toContain('Save')
		expect(wrapper.find('.load-error').text()).toContain("Couldn't load which avatar you use")

		sdk.userGetAvatarProvider.mockResolvedValueOnce({data: {avatar_provider: 'gravatar'}})
		await wrapper.get('.load-error button').trigger('click')
		await flushPromises()
		expect(wrapper.get<HTMLInputElement>('input[type=radio][value="gravatar"]').element.checked).toBe(true)
	})

	it('shows no picker while the saved source is still loading', async () => {
		sdk.userGetAvatarProvider.mockReset()
		sdk.userGetAvatarProvider.mockReturnValue(new Promise(() => {}))
		await mountAvatar()

		expect(wrapper.find('input[type=radio]').exists()).toBe(false)
	})
})
