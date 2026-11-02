import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	enableAutoUnmount,
	mount,
} from '@vue/test-utils'
import {nextTick} from 'vue'
import SpeechInputControl from './SpeechInputControl.vue'

vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string) => key,
	}),
}))

enableAutoUnmount(afterEach)

function mountControl(overrides = {}) {
	const wrapper = mount(SpeechInputControl, {
		attachTo: document.body,
		props: {
			recording: false,
			requesting: false,
			stopping: false,
			processing: false,
			elapsed: 0,
			canTidy: true,
			tidy: true,
			canCleanup: true,
			...overrides,
		},
		global: {
			stubs: {
				Icon: true,
			},
		},
	})
	const mic = wrapper.get<HTMLButtonElement>('.speech-input-control__mic')
	const captured = new Set<number>()
	const setPointerCapture = vi.fn((id: number) => captured.add(id))
	const releasePointerCapture = vi.fn((id: number) => {
		captured.delete(id)
		pointer(mic.element, 'lostpointercapture', {pointerId: id})
	})
	Object.assign(mic.element, {
		setPointerCapture,
		hasPointerCapture: (id: number) => captured.has(id),
		releasePointerCapture,
	})
	return {
		wrapper,
		mic,
		setPointerCapture,
		releasePointerCapture,
	}
}

function pointer(target: EventTarget, type: string, overrides = {}) {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	})
	Object.assign(event, {
		pointerType: 'touch',
		pointerId: 1,
		isPrimary: true,
		button: 0,
		clientX: 200,
		...overrides,
	})
	target.dispatchEvent(event)
}

async function click(element: HTMLElement, detail = 1) {
	element.dispatchEvent(new MouseEvent('click', {
		bubbles: true,
		cancelable: true,
		button: 0,
		detail,
	}))
	await nextTick()
}

beforeEach(() => {
	vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('speech input touch and native button controls', () => {
	it('uses a short tap to start continuous recording and a second native click to stop', async () => {
		const {wrapper, mic, setPointerCapture, releasePointerCapture} = mountControl()
		pointer(mic.element, 'pointerdown')
		expect(setPointerCapture).toHaveBeenCalledWith(1)
		await vi.advanceTimersByTimeAsync(349)
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('start')).toEqual([[]])
		expect(releasePointerCapture).toHaveBeenCalledWith(1)
		await vi.advanceTimersByTimeAsync(350)
		expect(wrapper.emitted('start')).toHaveLength(1)
		await wrapper.setProps({recording: true})
		await click(mic.element)
		expect(wrapper.emitted('stop')).toEqual([[]])
		expect(wrapper.emitted('cancel')).toBeUndefined()
	})

	it('starts a captured long hold once, stops on release, and suppresses its generated click', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		expect(wrapper.emitted('start')).toEqual([[]])
		await wrapper.setProps({recording: true})
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('stop')).toEqual([[]])
		expect(wrapper.emitted('start')).toHaveLength(1)
		expect(wrapper.emitted('cancel')).toBeUndefined()
		await wrapper.setProps({recording: false})
		await click(mic.element, 0)
		expect(wrapper.emitted('start')).toHaveLength(2)
	})

	it('cancels a released hold while permission is pending and shows the actual permission state', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		await wrapper.setProps({requesting: true})
		expect(wrapper.get('[role="status"]').text()).toBe('tcy.voice.requesting')
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('cancel')).toEqual([[]])
		expect(wrapper.emitted('stop')).toBeUndefined()
		expect(wrapper.emitted('start')).toHaveLength(1)
	})

	it('cancels even when release happens before the parent renders the permission state', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('cancel')).toEqual([[]])
		expect(wrapper.emitted('start')).toHaveLength(1)
	})

	it.each(['pointercancel', 'lostpointercapture'])('cancels an active hold once on %s', async type => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		await wrapper.setProps({recording: true})
		pointer(mic.element, type)
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('cancel')).toEqual([[]])
		expect(wrapper.emitted('stop')).toBeUndefined()
		expect(wrapper.emitted('start')).toHaveLength(1)
	})

	it('cancels an active hold when another finger touches outside the control', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		await wrapper.setProps({recording: true})
		pointer(document.body, 'pointerdown', {
			pointerId: 2,
			isPrimary: false,
		})
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('cancel')).toEqual([[]])
		expect(wrapper.emitted('stop')).toBeUndefined()
		expect(wrapper.emitted('start')).toHaveLength(1)
	})

	it('discards the pending hold timer on a second finger before recording starts', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		pointer(document.body, 'pointerdown', {
			pointerId: 2,
			isPrimary: false,
		})
		await vi.advanceTimersByTimeAsync(350)
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('start')).toBeUndefined()
		expect(wrapper.emitted('cancel')).toBeUndefined()
	})

	it.each([
		{
			distance: 71,
			expected: 'stop',
		},
		{
			distance: 72,
			expected: 'cancel',
		},
	])('uses a $distance px left slide to $expected', async ({distance, expected}) => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		await wrapper.setProps({recording: true})
		pointer(mic.element, 'pointermove', {clientX: 200 - distance})
		await nextTick()
		if (expected === 'cancel') {
			expect(wrapper.get('[role="status"]').text()).toBe('tcy.voice.cancelReleaseHint')
		}
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted(expected)).toEqual([[]])
		expect(wrapper.emitted(expected === 'stop' ? 'cancel' : 'stop')).toBeUndefined()
		expect(wrapper.emitted('start')).toHaveLength(1)
	})

	it('does not arm recording for a right mouse button or a secondary pointer', async () => {
		const {wrapper, mic, setPointerCapture} = mountControl()
		pointer(mic.element, 'pointerdown', {
			pointerType: 'mouse',
			button: 2,
		})
		pointer(mic.element, 'pointerdown', {isPrimary: false})
		pointer(mic.element, 'pointerdown', {button: 2})
		await vi.advanceTimersByTimeAsync(350)
		await mic.trigger('click', {button: 2})
		expect(setPointerCapture).not.toHaveBeenCalled()
		expect(wrapper.emitted('start')).toBeUndefined()
	})

	it('retains native click activation when pointer capture is unavailable', async () => {
		const {wrapper, mic, setPointerCapture} = mountControl()
		setPointerCapture.mockImplementation(() => { throw new Error('pointer capture unavailable') })
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('start')).toEqual([[]])
	})

	it('clears a hold timer on unmount and cancels an already started hold', async () => {
		const pending = mountControl()
		pointer(pending.mic.element, 'pointerdown')
		pending.wrapper.unmount()
		await vi.advanceTimersByTimeAsync(350)
		expect(pending.wrapper.emitted('start')).toBeUndefined()
		const running = mountControl()
		pointer(running.mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		running.wrapper.unmount()
		expect(running.wrapper.emitted('cancel')).toEqual([[]])
	})

	it('does not restart on release after the parent ends a held recording', async () => {
		const {wrapper, mic} = mountControl()
		pointer(mic.element, 'pointerdown')
		await vi.advanceTimersByTimeAsync(350)
		await wrapper.setProps({requesting: true})
		await wrapper.setProps({requesting: false})
		pointer(mic.element, 'pointerup')
		await click(mic.element)
		expect(wrapper.emitted('start')).toHaveLength(1)
		expect(wrapper.emitted('stop')).toBeUndefined()
		expect(wrapper.emitted('cancel')).toBeUndefined()
	})
})

describe('speech input status and independent menu', () => {
	it('keeps the same focused main button mounted while pending and permits cancellation', async () => {
		const {wrapper, mic} = mountControl()
		mic.element.focus()
		await wrapper.setProps({
			disabled: true,
			requesting: true,
		})
		expect(wrapper.get('.speech-input-control__mic').element).toBe(mic.element)
		expect(document.activeElement).toBe(mic.element)
		expect(mic.attributes('aria-label')).toBe('tcy.voice.cancel')
		await click(mic.element, 0)
		expect(wrapper.emitted('cancel')).toEqual([[]])
	})

	it('renders the real processing stage and returns focus after the cancel control hides', async () => {
		const {wrapper, mic} = mountControl({
			processing: true,
			processingLabel: 'fixture transcription stage',
		})
		expect(wrapper.get('[role="status"]').text()).toBe('fixture transcription stage')
		wrapper.get<HTMLButtonElement>('.speech-input-control__cancel').element.focus()
		await wrapper.setProps({processing: false})
		await nextTick()
		expect(document.activeElement).toBe(mic.element)
	})

})
