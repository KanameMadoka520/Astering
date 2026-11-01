import {describe, it, expect, beforeEach, afterEach, vi, type MockInstance} from 'vitest'
import {mount, flushPromises} from '@vue/test-utils'
import {nextTick} from 'vue'
import Modal from './Modal.vue'
import XButton from '@/components/input/Button.vue'

const globalMocks = {
	global: {
		mocks: {
			$t: (key: string) => key,
		},
	},
}

let showModalSpy: MockInstance<HTMLDialogElement['showModal']>

beforeEach(() => {
	showModalSpy = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
})

afterEach(() => {
	showModalSpy.mockRestore()
	document.body.innerHTML = ''
})

describe('Modal.vue — open race condition (#2590)', () => {
	it('opens the dialog when enabled flips false → true', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: false},
			slots: {default: '<p class="test-body">hi</p>'},
		})

		// Pre-condition: dialog is not yet in the DOM.
		expect(document.querySelector('dialog.modal-dialog')).toBeNull()

		// Flip enabled → true. This is the failure path in the bug report.
		// The fix must call showModal() deterministically — i.e. once the
		// <dialog> element is mounted via the dialogRef watcher, not via a
		// nextTick that may fire before the mount flush under Electron.
		await wrapper.setProps({enabled: true})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement | null
		expect(dialog).not.toBeNull()
		expect(dialog!.hasAttribute('open')).toBe(true)
		expect(showModalSpy).toHaveBeenCalledTimes(1)

		wrapper.unmount()
	})

	it('calls showModal synchronously with the render flush, not via a deferred nextTick (#2590)', async () => {
		// Regression guard: the buggy implementation scheduled showModal() via
		// nextTick *after* setting showDialog = true, so the call landed in a
		// microtask that could fire before the <dialog> mount flush under
		// Electron/Chromium. The fix invokes showModal() from a watch on the
		// dialogRef template ref, which Vue populates during the same flush
		// that mounts the element. That means by the time `await nextTick()`
		// resolves after the first state change, the dialog must already have
		// [open] set — no additional flushPromises or extra ticks required.
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: false},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		expect(document.querySelector('dialog.modal-dialog')).toBeNull()

		// Flip enabled and wait exactly one render flush. After this, the
		// dialog is mounted AND showModal has been called.
		wrapper.setProps({enabled: true})
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement | null
		expect(dialog).not.toBeNull()
		expect(showModalSpy).toHaveBeenCalled()
		expect(showModalSpy.mock.instances[0]).toBe(dialog)
		expect(dialog!.hasAttribute('open')).toBe(true)

		wrapper.unmount()
	})

	it('calls showModal on the exact dialog element that is mounted (race regression)', async () => {
		// This test asserts the fix's contract: whenever the <dialog> element
		// is mounted (i.e. dialogRef becomes non-null), showModal() is called
		// on *that* element. The buggy implementation instead relied on a
		// nextTick callback whose timing could fire before the dialog mounted,
		// skipping the showModal() call entirely and leaving .open === false.
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement | null
		expect(dialog).not.toBeNull()
		// The fingerprint from the bug report: element is mounted but .open
		// is false because showModal() was never called. The fix guarantees
		// these two always agree.
		expect(dialog!.hasAttribute('open')).toBe(true)
		expect(showModalSpy).toHaveBeenCalled()
		expect(showModalSpy.mock.instances[0]).toBe(dialog)

		wrapper.unmount()
	})

	it('closes the dialog when enabled flips true → false', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		// Sanity: open.
		expect(document.querySelector('dialog.modal-dialog')?.hasAttribute('open')).toBe(true)

		await wrapper.setProps({enabled: false})
		// Wait past the 140ms closeTimer (real timers — fake timers interact
		// badly with Vue's scheduler).
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()
		await nextTick()

		expect(document.querySelector('dialog.modal-dialog')).toBeNull()

		wrapper.unmount()
	})

	it('does not open the dialog if enabled flips back to false before mount', async () => {
		// Regression guard: the dialogRef watcher fires once the <dialog>
		// element mounts. If props.enabled has flipped back to false by the
		// time the mount happens, the watcher must not call showModal().
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: false},
			slots: {default: '<p class="test-body">hi</p>'},
		})

		// Flip enabled true then false within the same tick, before the mount
		// flush can complete.
		wrapper.setProps({enabled: true})
		wrapper.setProps({enabled: false})
		await flushPromises()
		await nextTick()
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()
		await nextTick()

		// showModal must not have been called — the final prop state is
		// disabled.
		expect(showModalSpy).not.toHaveBeenCalled()
		expect(document.querySelector('dialog.modal-dialog')).toBeNull()

		wrapper.unmount()
	})

	it('clears data-closing when re-opened mid-close transition', async () => {
		// Regression guard: if the user toggles enabled back to true while the
		// 140ms close transition is still in flight, the <dialog> is still
		// mounted and [open], so the dialogRef watcher does not re-fire. Make
		// sure openDialog() clears the leftover data-closing flag itself;
		// otherwise the dialog stays stuck at opacity 0.
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.hasAttribute('open')).toBe(true)

		// Start closing — this sets data-closing and schedules the unmount.
		await wrapper.setProps({enabled: false})
		await nextTick()
		expect(dialog.dataset.closing).toBe('')

		// Re-open well before the 140ms close timer fires.
		await wrapper.setProps({enabled: true})
		await nextTick()

		expect(dialog.dataset.closing).toBeUndefined()
		expect(dialog.hasAttribute('open')).toBe(true)

		wrapper.unmount()
	})
})

describe('Modal.vue — close requests', () => {
	it('ignores Escape while its close transition is still running', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement

		dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
		expect(wrapper.emitted('close')).toHaveLength(1)

		await wrapper.setProps({enabled: false})
		await nextTick()
		expect(dialog.dataset.closing).toBe('')
		dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
		expect(wrapper.emitted('close')).toHaveLength(1)

		wrapper.unmount()
	})
})

describe('Modal.vue — accessible name derivation', () => {
	it('labels the dialog via the rendered header slot when no default slot or aria-label is given', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {header: '<span class="test-header">Delete this task</span>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		const labelledBy = dialog.getAttribute('aria-labelledby')
		expect(labelledBy).toBeTruthy()

		const headerEl = document.getElementById(labelledBy!)
		expect(headerEl).not.toBeNull()
		expect(headerEl!.classList.contains('modal-header')).toBe(true)
		expect(headerEl!.textContent).toContain('Delete this task')

		wrapper.unmount()
	})

	it('omits aria-labelledby when an explicit aria-label attr is passed', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			attrs: {'aria-label': 'Confirm deletion'},
			props: {enabled: true},
			slots: {header: '<span class="test-header">Delete this task</span>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.hasAttribute('aria-labelledby')).toBe(false)

		wrapper.unmount()
	})

	it('omits aria-labelledby when default slot content is provided', async () => {
		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.hasAttribute('aria-labelledby')).toBe(false)

		wrapper.unmount()
	})
})

describe('Modal.vue — focus restoration', () => {
	it('restores focus to the trigger when the modal is unmounted without a close transition', async () => {
		const trigger = document.createElement('button')
		document.body.append(trigger)
		trigger.focus()

		const wrapper = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.hasAttribute('open')).toBe(true)

		// The browser moves focus into the top layer when the dialog opens and
		// makes everything outside it inert; happy-dom does neither, so emulate
		// both — without that, a focus() issued before dialog.close() would
		// wrongly appear to work here.
		const realFocus = HTMLElement.prototype.focus
		trigger.blur()
		const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
			.mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
				const topLayer = document.querySelector('dialog[open]')
				if (topLayer && !topLayer.contains(this)) return
				realFocus.call(this, options)
			})

		// v-if teardown (Popup's sheet): no closeDialog(), straight to unmount.
		wrapper.unmount()
		focusSpy.mockRestore()

		expect(document.activeElement).toBe(trigger)
	})
})

describe('Modal.vue — nested body scroll lock', () => {
	it('keeps the page locked while an outer modal is still open', async () => {
		const outer = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="outer-body">outer</p>'},
		})
		const inner = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="inner-body">inner</p>'},
		})
		await flushPromises()
		await nextTick()

		expect(document.body.style.overflow).toBe('hidden')

		await inner.setProps({enabled: false})
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()

		expect(document.body.style.overflow).toBe('hidden')

		await outer.setProps({enabled: false})
		await new Promise(resolve => setTimeout(resolve, 200))
		await flushPromises()

		expect(document.body.style.overflow).toBe('')

		inner.unmount()
		outer.unmount()
		expect(document.body.style.overflow).toBe('')
	})

	it('keeps the page locked when an inner modal is unmounted instead of closed', async () => {
		const outer = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="outer-body">outer</p>'},
		})
		const inner = mount(Modal, {
			...globalMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="inner-body">inner</p>'},
		})
		await flushPromises()
		await nextTick()

		inner.unmount()
		expect(document.body.style.overflow).toBe('hidden')

		outer.unmount()
		expect(document.body.style.overflow).toBe('')
	})
})

describe('Modal.vue — confirm layout', () => {
	const confirmMocks = {
		global: {
			mocks: {
				$t: (key: string) => key,
			},
			components: {
				XButton,
			},
			stubs: {
				Icon: true,
			},
		},
	}

	it('renders the header/text fallback as a compact confirm card with a neutral cancel', async () => {
		const wrapper = mount(Modal, {
			...confirmMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {
				header: '<span>Delete this task</span>',
				text: '<p>Really?</p>',
			},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.classList.contains('is-confirm')).toBe(true)
		expect(dialog.querySelector('.modal-container > .close')).not.toBeNull()

		const buttons = dialog.querySelectorAll('.modal-content .actions .button')
		expect(buttons).toHaveLength(2)
		expect(buttons[0].textContent).toContain('misc.cancel')
		expect(buttons[0].classList.contains('is-outlined')).toBe(true)
		expect(buttons[0].classList.contains('has-text-danger')).toBe(false)
		expect(buttons[1].textContent).toContain('misc.doit')
		expect(buttons[1].classList.contains('is-danger')).toBe(false)

		wrapper.unmount()
	})

	it('marks the confirm action as destructive when danger is set', async () => {
		const wrapper = mount(Modal, {
			...confirmMocks,
			attachTo: document.body,
			props: {
				enabled: true,
				danger: true,
			},
			slots: {header: '<span>Delete this task</span>'},
		})
		await flushPromises()
		await nextTick()

		const primary = document.querySelectorAll('dialog .modal-content .actions .button')[1]
		expect(primary.classList.contains('is-danger')).toBe(true)

		wrapper.unmount()
	})

	it('keeps the full layout for custom content', async () => {
		const wrapper = mount(Modal, {
			...confirmMocks,
			attachTo: document.body,
			props: {enabled: true},
			slots: {default: '<p class="test-body">hi</p>'},
		})
		await flushPromises()
		await nextTick()

		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		expect(dialog.classList.contains('is-confirm')).toBe(false)
		expect(dialog.classList.contains('default')).toBe(true)

		wrapper.unmount()
	})
})

describe('Modal.vue — confirm submit handling', () => {
	const confirmMocks = {
		global: {
			mocks: {$t: (key: string) => key},
			components: {XButton},
			stubs: {Icon: true},
		},
	}

	async function mountConfirm(props: Record<string, unknown>) {
		const wrapper = mount(Modal, {
			...confirmMocks,
			attachTo: document.body,
			props: {enabled: true, ...props},
			slots: {header: '<span>Revoke this session</span>', text: '<p>Phone, Berlin</p>'},
		})
		await flushPromises()
		await nextTick()
		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		const [cancel, confirm] = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.modal-content .actions .button'))
		return {wrapper, dialog, cancel, confirm}
	}

	it('runs a pending submit handler only once and keeps the dialog open meanwhile', async () => {
		let finish!: () => void
		const onSubmit = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
		const {wrapper, dialog, cancel, confirm} = await mountConfirm({onSubmit})

		confirm.click()
		await nextTick()
		confirm.click()
		await nextTick()
		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(confirm.getAttribute('aria-disabled')).toBe('true')

		dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
		cancel.click()
		await nextTick()
		expect(wrapper.emitted('close')).toBeUndefined()

		finish()
		await flushPromises()
		confirm.click()
		await nextTick()
		expect(onSubmit).toHaveBeenCalledTimes(2)
		wrapper.unmount()
	})

	it('settles a rejected submit handler without an unhandled rejection and allows another try', async () => {
		const unhandled = vi.fn()
		window.addEventListener('unhandledrejection', unhandled)
		const onSubmit = vi.fn().mockRejectedValueOnce(new Error('server said no')).mockResolvedValue(undefined)
		const {wrapper, dialog, confirm} = await mountConfirm({onSubmit})

		confirm.click()
		await flushPromises()
		expect(confirm.getAttribute('aria-disabled')).toBeNull()
		dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
		expect(wrapper.emitted('close')).toHaveLength(1)

		confirm.click()
		await flushPromises()
		expect(onSubmit).toHaveBeenCalledTimes(2)
		expect(unhandled).not.toHaveBeenCalled()
		window.removeEventListener('unhandledrejection', unhandled)
		wrapper.unmount()
	})

	it('composes with an explicit loading prop and plain synchronous handlers', async () => {
		const onSubmit = vi.fn()
		const {wrapper, confirm} = await mountConfirm({onSubmit, loading: true})
		confirm.click()
		await nextTick()
		expect(onSubmit).not.toHaveBeenCalled()

		await wrapper.setProps({loading: false})
		confirm.click()
		confirm.click()
		await nextTick()
		expect(onSubmit).toHaveBeenCalledTimes(2)
		wrapper.unmount()
	})

	it('names the confirm action when a label is given', async () => {
		const {wrapper, confirm} = await mountConfirm({confirmLabel: 'Revoke session'})
		expect(confirm.textContent).toContain('Revoke session')
		expect(confirm.textContent).not.toContain('misc.doit')
		wrapper.unmount()
	})

	it('moves focus to the main content when the trigger was removed while the dialog was open', async () => {
		vi.useFakeTimers()
		const main = document.createElement('main')
		main.id = 'main-content'
		main.tabIndex = -1
		const trigger = document.createElement('button')
		main.append(trigger)
		document.body.append(main)
		trigger.focus()

		const {wrapper} = await mountConfirm({})
		trigger.remove()
		await wrapper.setProps({enabled: false})
		await vi.runAllTimersAsync()
		expect(document.activeElement).toBe(main)
		vi.useRealTimers()
		wrapper.unmount()
	})
})
