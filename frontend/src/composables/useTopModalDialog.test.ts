import {afterEach, describe, expect, it, vi} from 'vitest'
import {effectScope, nextTick} from 'vue'
import {useTopModalDialog} from './useTopModalDialog'

// MutationObserver callbacks run as microtasks.
const settle = () => new Promise(resolve => setTimeout(resolve))

function modal(...classes: string[]) {
	const dialog = document.createElement('dialog')
	dialog.classList.add('modal-dialog', ...classes)
	return dialog
}

describe('useTopModalDialog', () => {
	const scopes: ReturnType<typeof effectScope>[] = []
	function track() {
		const scope = effectScope()
		scopes.push(scope)
		return scope.run(() => useTopModalDialog())!
	}

	afterEach(() => {
		scopes.splice(0).forEach(scope => scope.stop())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
	})

	it('follows modals opening, stacking, closing and leaving', async () => {
		const {topModalDialog, taskDetailDialog} = track()
		const task = modal('task-detail-view-modal')
		document.body.append(task)
		task.setAttribute('open', '')
		await settle()
		expect(topModalDialog.value).toBe(task)
		expect(taskDetailDialog.value).toBe(task)

		// A confirmation over the task detail takes the toasts; the assistant stays with the task.
		const confirm = modal('is-confirm')
		document.body.append(confirm)
		confirm.setAttribute('open', '')
		await settle()
		expect(topModalDialog.value).toBe(confirm)
		expect(taskDetailDialog.value).toBe(task)

		confirm.removeAttribute('open')
		await settle()
		expect(topModalDialog.value).toBe(task)

		task.remove()
		await settle()
		expect(topModalDialog.value).toBeUndefined()
		expect(taskDetailDialog.value).toBeUndefined()
	})

	it('picks up a dialog that is already open', () => {
		const dialog = modal()
		dialog.setAttribute('open', '')
		document.body.append(dialog)
		expect(track().topModalDialog.value).toBe(dialog)
	})

	it('ignores everything below body\'s own children', async () => {
		const {topModalDialog} = track()
		const page = document.createElement('main')
		document.body.append(page)
		await settle()
		const query = vi.spyOn(document, 'querySelectorAll')

		for (let index = 0; index < 5; index++) {
			const row = document.createElement('div')
			row.innerHTML = '<details open><summary>Step</summary><p>Streamed text</p></details>'
			page.append(row)
			row.querySelector('details')!.removeAttribute('open')
		}
		await settle()

		expect(query).not.toHaveBeenCalled()
		expect(topModalDialog.value).toBeUndefined()
	})

	it('shares one observer and stops with its last user', async () => {
		const observe = vi.spyOn(MutationObserver.prototype, 'observe')
		const first = track()
		track()
		expect(observe.mock.calls.filter(([target]) => target === document.body)).toHaveLength(1)

		scopes.splice(0).forEach(scope => scope.stop())
		const dialog = modal()
		document.body.append(dialog)
		dialog.setAttribute('open', '')
		await settle()
		await nextTick()
		expect(first.topModalDialog.value).toBeUndefined()
	})
})
