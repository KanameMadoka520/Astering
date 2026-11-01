import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {effectScope} from 'vue'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import Notifications from '@kyvg/vue3-notification'

vi.mock('@/helpers/diagnostics', async () => {
	const {ref} = await import('vue')
	return {diagnostics: ref([]), openDiagnostics: vi.fn()}
})

import {error, success} from '@/message'
import Notification from './Notification.vue'

enableAutoUnmount(afterEach)

function mountToasts() {
	return mount(Notification, {
		attachTo: document.body,
		global: {
			plugins: [Notifications],
			stubs: {
				Icon: true,
				XButton: {template: '<button type="button" class="action" @click="$emit(\'click\', $event)"><slot /></button>'},
			},
			mocks: {$t: (key: string) => key},
		},
	})
}
const toasts = () => document.body.querySelectorAll('.vue-notification')
const alertRegion = () => document.querySelector('[aria-live="assertive"]')!
const statusRegion = () => document.querySelector('[role="status"]')!

// Every text a live region is given, in order: what a screen reader would read out.
function readOuts(region: Element) {
	const said: string[] = []
	new MutationObserver(() => {
		const text = region.textContent?.trim()
		if (text) said.push(text)
	}).observe(region, {childList: true, characterData: true, subtree: true})
	return said
}

describe('Notification', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		document.body.innerHTML = ''
	})

	it('follows the topmost modal without re-reading the page for unrelated changes', async () => {
		const wrapper = mountToasts()
		const page = document.createElement('main')
		document.body.append(page)
		await vi.advanceTimersByTimeAsync(0)
		const query = vi.spyOn(document, 'querySelectorAll')

		for (let index = 0; index < 5; index++) {
			const row = document.createElement('p')
			row.textContent = `Streamed line ${index}`
			page.append(row)
		}
		await vi.advanceTimersByTimeAsync(0)
		expect(query).not.toHaveBeenCalled()

		const dialog = document.createElement('dialog')
		dialog.className = 'modal-dialog'
		document.body.append(dialog)
		dialog.setAttribute('open', '')
		success({message: 'Saved'})
		await vi.advanceTimersByTimeAsync(0)
		await flushPromises()
		expect(dialog.querySelector('.vue-notification')).not.toBeNull()
		wrapper.unmount()
		query.mockRestore()
	})

	it('reads each toast out once: errors interrupt, others wait', async () => {
		mountToasts()
		error(new Error('The server did not answer'))
		success({message: 'Saved'})
		await flushPromises()

		expect(document.querySelector('[aria-live="assertive"]')?.textContent?.trim()).toBe('Error: The server did not answer')
		// An open dialog's own error stays the only alert in it.
		expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
		expect(document.querySelector('[role="status"]')?.textContent?.trim()).toBe('Success: Saved')
		// No live region around or on the toasts, which would read them a second time.
		expect(document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')).toHaveLength(2)
		expect(toasts()).toHaveLength(2)
	})

	it('reads a repeat out again while the first toast still shows it', async () => {
		mountToasts()
		const said = readOuts(alertRegion())
		error(new Error('The server did not answer'))
		await flushPromises()
		await vi.advanceTimersByTimeAsync(3_000)
		error(new Error('The server did not answer'))
		await flushPromises()

		// One toast counts the attempts; each attempt is read out once.
		expect(toasts()).toHaveLength(1)
		expect(toasts()[0].textContent).toContain('×2')
		expect(said).toEqual(['Error: The server did not answer', 'Error: The server did not answer'])
	})

	it('reads each of several repeats raised at the same moment', async () => {
		mountToasts()
		const said = readOuts(alertRegion())
		error(new Error('The server did not answer'))
		await flushPromises()
		error(new Error('The server did not answer'))
		error(new Error('The server did not answer'))
		await flushPromises()

		expect(toasts()[0].textContent).toContain('×3')
		expect(said).toEqual([
			'Error: The server did not answer',
			'Error: The server did not answer Error: The server did not answer',
		])
	})

	it('still reads repeats after the component that raised the toast is gone', async () => {
		mountToasts()
		const said = readOuts(alertRegion())
		// As from an error in another component's hook, whose effect scope is active while it runs.
		const raiser = effectScope()
		raiser.run(() => error(new Error('The server did not answer')))
		await flushPromises()
		raiser.stop()
		error(new Error('The server did not answer'))
		await flushPromises()

		expect(said).toEqual(['Error: The server did not answer', 'Error: The server did not answer'])
	})

	it('does not read out a toast pushed out before it could be shown', async () => {
		mountToasts()
		const polite = readOuts(statusRegion())
		const alert = readOuts(alertRegion())
		success({message: 'Saved'})
		error(new Error('first.png is too large'))
		error(new Error('second.png is too large'))
		await flushPromises()

		expect(toasts()).toHaveLength(2)
		expect(polite).toEqual([])
		expect(statusRegion().textContent?.trim()).toBe('')
		expect(alert).toEqual(['Error: first.png is too large Error: second.png is too large'])
	})

	it('reads out every toast raised at the same moment', async () => {
		mountToasts()
		const said = readOuts(alertRegion())
		error(new Error('first.png is too large'))
		error(new Error('second.png is too large'))
		await flushPromises()

		expect(toasts()).toHaveLength(2)
		expect(said).toEqual(['Error: first.png is too large Error: second.png is too large'])
	})

	it('leaves no words behind once their toast is gone', async () => {
		mountToasts()
		error(new Error('The server did not answer'))
		success({message: 'Saved'})
		await flushPromises()
		await vi.advanceTimersByTimeAsync(3_000)
		// A repeat bumps the count of the shown toast, but the library still runs a timer of its own for it.
		error(new Error('The server did not answer'))
		await flushPromises()

		await vi.advanceTimersByTimeAsync(3_000)
		expect(statusRegion().textContent?.trim()).toBe('')
		expect(alertRegion().textContent?.trim()).toBe('Error: The server did not answer')

		await vi.advanceTimersByTimeAsync(5_000)
		expect(toasts()).toHaveLength(0)
		expect(alertRegion().textContent?.trim()).toBe('')

		// The repeat's timer ends while a new toast shows the same words; they stay until that toast goes.
		error(new Error('The server did not answer'))
		await flushPromises()
		await vi.advanceTimersByTimeAsync(3_000)
		expect(toasts()).toHaveLength(1)
		expect(alertRegion().textContent?.trim()).toBe('Error: The server did not answer')
	})

	it('keeps a toast with an Undo action until it is used or closed', async () => {
		mountToasts()
		const undo = vi.fn()
		success({message: 'Task done'}, [{title: 'Undo', callback: undo}])
		await flushPromises()

		await vi.advanceTimersByTimeAsync(60_000)
		expect(toasts()).toHaveLength(1)

		document.body.querySelector<HTMLButtonElement>('.notification-close')!.click()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(toasts()).toHaveLength(0)
	})

	it('pauses while hovered or focused and resumes with the time that was left', async () => {
		mountToasts()
		error(new Error('The server did not answer'))
		await flushPromises()
		const toast = toasts()[0] as HTMLElement

		await vi.advanceTimersByTimeAsync(4_000)
		toast.dispatchEvent(new MouseEvent('mouseenter'))
		toast.querySelector<HTMLButtonElement>('.notification-close')!.dispatchEvent(new FocusEvent('focusin', {bubbles: true}))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(toasts()).toHaveLength(1)

		// Leaving with the pointer alone keeps it: focus is still inside.
		toast.dispatchEvent(new MouseEvent('mouseleave'))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(toasts()).toHaveLength(1)

		toast.querySelector<HTMLButtonElement>('.notification-close')!.dispatchEvent(new FocusEvent('focusout', {bubbles: true}))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(toasts()).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(toasts()).toHaveLength(0)
	})
})
