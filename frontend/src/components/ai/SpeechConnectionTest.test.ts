import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {enableAutoUnmount, mount} from '@vue/test-utils'
import {defineComponent, h} from 'vue'
import SpeechConnectionTest from './SpeechConnectionTest.vue'

vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string) => key,
		locale: {value: 'en'},
	}),
}))

const ButtonStub = defineComponent({
	inheritAttrs: false,
	setup: (_, {attrs, slots}) => () => h('button', attrs, slots.default?.()),
})
enableAutoUnmount(afterEach)

describe('speech connection audio test', () => {
	const revoke = vi.fn()
	beforeEach(() => {
		vi.stubGlobal('URL', class extends URL {
			static createObjectURL = vi.fn(() => 'blob:fixture-audio')
			static revokeObjectURL = revoke
		})
		revoke.mockClear()
	})
	afterEach(() => { vi.unstubAllGlobals() })

	function mountTest(canTest = true) {
		return mount(SpeechConnectionTest, {
			props: {
				canTest,
				testing: false,
				maxBytes: 1024,
			},
			global: {
				stubs: {
					XButton: ButtonStub,
					Icon: true,
				},
			},
		})
	}
	async function choose(wrapper: ReturnType<typeof mountTest>, file: File) {
		const input = wrapper.get('input[type="file"]')
		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [file],
		})
		await input.trigger('change')
	}

	it('requires a saved connection and a valid file before emitting a test request', async () => {
		const wrapper = mountTest(false)
		const file = new File(['audio'], 'clip.wav', {type: 'audio/wav'})
		await choose(wrapper, file)
		await wrapper.get('button').trigger('click')
		expect(wrapper.emitted('test')).toBeUndefined()
		await wrapper.setProps({canTest: true})
		await wrapper.get('button').trigger('click')
		expect(wrapper.emitted('test')).toEqual([[file]])
	})

	it('invalidates old results when the audio changes and releases both preview URLs', async () => {
		const wrapper = mountTest()
		await choose(wrapper, new File(['first'], 'first.wav'))
		await choose(wrapper, new File(['second'], 'second.wav'))
		expect(wrapper.emitted('reset')).toHaveLength(2)
		expect(revoke).toHaveBeenCalledTimes(1)
		wrapper.unmount()
		expect(revoke).toHaveBeenCalledTimes(2)
	})

	it('rejects an oversized or empty file without making a request', async () => {
		const wrapper = mountTest()
		await choose(wrapper, new File([new Uint8Array(1025)], 'large.wav'))
		await wrapper.get('button').trigger('click')
		expect(wrapper.get('[role="alert"]').text()).toBe('speechSettings.audioLimit')
		await choose(wrapper, new File([], 'empty.wav'))
		await wrapper.get('button').trigger('click')
		expect(wrapper.get('[role="alert"]').text()).toBe('speechSettings.emptyAudio')
		expect(wrapper.emitted('test')).toBeUndefined()
	})

	it('offers a separate connection handshake without a file and keeps recognition file-only', async () => {
		const wrapper = mountTest()
		await wrapper.setProps({canProbe: true})
		const probe = wrapper.findAll('button').find(button => button.text() === 'speechSettings.probeConnection')
		expect(probe).toBeDefined()
		await probe!.trigger('click')
		expect(wrapper.emitted('test')).toEqual([[]])
		const recognition = wrapper.findAll('button').find(button => button.text() === 'speechSettings.runTest')!
		await recognition.trigger('click')
		expect(wrapper.emitted('test')).toHaveLength(1)
		await wrapper.setProps({canTest: false})
		await probe!.trigger('click')
		expect(wrapper.emitted('test')).toHaveLength(1)
	})
})
