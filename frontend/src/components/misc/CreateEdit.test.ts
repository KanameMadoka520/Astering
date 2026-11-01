import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {nextTick} from 'vue'

const goBack = vi.fn()
vi.mock('@/composables/useGoBack', () => ({useGoBack: () => goBack}))
import CreateEdit from './CreateEdit.vue'
import Card from './Card.vue'
import Modal from './Modal.vue'
import XButton from '@/components/input/Button.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	document.body.innerHTML = ''
	goBack.mockClear()
})

async function setup(props: Record<string, unknown> = {}) {
	wrapper = mount(CreateEdit, {
		attachTo: document.body,
		props: {title: 'New project', ...props},
		slots: {default: '<label>Title <input class="title-field"></label>'},
		global: {
			mocks: {$t: (key: string) => key},
			components: {Card, Modal, XButton},
			stubs: {Icon: true, RouterLink: true},
		},
	})
	await flushPromises()
	await nextTick()
	return wrapper
}

function buttons() {
	const footer = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog .card-footer .button'))
	return {cancel: footer[0], primary: footer[1]}
}

describe('CreateEdit', () => {
	it('stays put while the request runs: Escape, Cancel and × do nothing', async () => {
		await setup({loading: true})
		const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
		dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
		buttons().cancel.click()
		document.querySelector<HTMLButtonElement>('dialog .card-header-icon.close')?.click()
		await nextTick()
		expect(goBack).not.toHaveBeenCalled()
	})

	it('keeps the clicked primary button focusable while it is busy', async () => {
		const view = await setup()
		const {primary} = buttons()
		primary.focus()
		primary.click()
		await nextTick()
		expect(view.emitted('primary')).toHaveLength(1)
		expect(primary.disabled).toBe(false)
		expect(primary.getAttribute('aria-disabled')).toBe('true')
		expect(document.activeElement).toBe(primary)
		primary.click()
		expect(view.emitted('primary')).toHaveLength(1)
	})

	it('puts the cursor in the first field once the dialog is open', async () => {
		await setup()
		expect(document.activeElement).toBe(document.querySelector('.title-field'))
	})

	it('still goes back on Cancel when nothing is running', async () => {
		await setup()
		buttons().cancel.click()
		expect(goBack).toHaveBeenCalledTimes(1)
	})

	describe('with typed changes', () => {
		async function typeTitle() {
			const field = document.querySelector<HTMLInputElement>('.title-field')!
			field.value = 'Garden'
			field.dispatchEvent(new Event('input', {bubbles: true}))
			await nextTick()
		}

		function leaveDialog() {
			return Array.from(document.querySelectorAll('dialog.modal-dialog')).find(d => d.textContent?.includes('user.settings.leave.title'))
		}

		it('asks before Escape, Cancel or × drop them, and keeps editing by default', async () => {
			await setup()
			await typeTitle()

			const dialog = document.querySelector('dialog.modal-dialog') as HTMLDialogElement
			dialog.dispatchEvent(new Event('cancel', {cancelable: true}))
			await flushPromises()
			expect(goBack).not.toHaveBeenCalled()
			expect(leaveDialog()).toBeDefined()

			leaveDialog()!.querySelector<HTMLButtonElement>('[data-leave-stay]')!.click()
			await flushPromises()
			await new Promise(resolve => setTimeout(resolve, 200))
			expect(leaveDialog()).toBeUndefined()

			buttons().cancel.click()
			await flushPromises()
			expect(goBack).not.toHaveBeenCalled()
			expect(leaveDialog()).toBeDefined()
		})

		it('goes back only after "Discard and leave"', async () => {
			await setup()
			await typeTitle()
			buttons().cancel.click()
			await flushPromises()

			const discard = Array.from(leaveDialog()!.querySelectorAll<HTMLButtonElement>('.card-footer .button')).find(b => b.textContent?.includes('user.settings.leave.discard'))
			discard!.click()
			await flushPromises()
			expect(goBack).toHaveBeenCalledTimes(1)
		})

		it('does not ask in a dialog without a primary action, whose changes apply right away', async () => {
			await setup({hasPrimaryAction: false})
			await typeTitle()
			buttons().cancel.click()
			expect(goBack).toHaveBeenCalledTimes(1)
		})
	})
})
