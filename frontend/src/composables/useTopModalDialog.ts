import {computed, getCurrentScope, onScopeDispose, shallowRef} from 'vue'

const MODAL = 'dialog.modal-dialog'
const OPEN = {attributes: true, attributeFilter: ['open']}

const openModals = shallowRef<readonly HTMLDialogElement[]>([])
let users = 0
let observer: MutationObserver | undefined

function read() {
	const next = Array.from(document.querySelectorAll<HTMLDialogElement>(`${MODAL}[open]`))
	const current = openModals.value
	if (next.length !== current.length || next.some((dialog, index) => dialog !== current[index])) openModals.value = next
}

function isDialog(node: Node): node is HTMLDialogElement {
	return node.nodeName === 'DIALOG'
}

// Modal.vue teleports every dialog straight into <body>, so only body's own children and those dialogs' `open`
// attribute are watched. Streaming text, lists and editors deeper in the page never wake this observer.
function start() {
	observer = new MutationObserver(records => {
		let changed = false
		for (const record of records) {
			if (record.type === 'attributes') changed = true
			record.addedNodes.forEach(node => {
				if (!isDialog(node)) return
				observer?.observe(node, OPEN)
				changed = true
			})
			record.removedNodes.forEach(node => {
				if (isDialog(node)) changed = true
			})
		}
		// A dialog added and opened in one task arrives as one batch; reading the document covers both.
		if (changed) read()
	})
	observer.observe(document.body, {childList: true})
	document.body.querySelectorAll(':scope > dialog').forEach(dialog => observer?.observe(dialog, OPEN))
	read()
}

function stop() {
	observer?.disconnect()
	observer = undefined
	openModals.value = []
}

/**
 * The open modal dialogs (Modal.vue), shared by everything that must follow them into the top layer: toasts and
 * uploads go into the topmost one, the floating assistant joins only the task detail. One observer serves all users.
 */
export function useTopModalDialog() {
	if (typeof document !== 'undefined' && getCurrentScope()) {
		if (users++ === 0) start()
		onScopeDispose(() => {
			if (--users === 0) stop()
		})
	}
	return {
		// Computed, not readonly(): a readonly proxy around a dialog would not work as a Teleport target.
		openModals: computed(() => openModals.value),
		topModalDialog: computed(() => openModals.value.at(-1)),
		taskDetailDialog: computed(() => openModals.value.find(dialog => dialog.classList.contains('task-detail-view-modal'))),
	}
}
