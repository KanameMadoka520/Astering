import {ref, type Ref} from 'vue'
import {onBeforeRouteLeave, onBeforeRouteUpdate, useRouter, type RouteLocationNormalized} from 'vue-router'
import {useEventListener} from '@vueuse/core'

import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'

/**
 * Asks before a route change or tab close drops unsaved form changes. The route is only followed after an
 * explicit "discard". A logout or account switch is never held up: the form belongs to the account it was
 * opened for.
 */
export function useUnsavedLeaveGuard(dirty: Readonly<Ref<boolean>>) {
	const router = useRouter()
	const owner = captureClientRequestContext()
	const leaveTarget = ref<string | null>(null)
	let leaving = false

	function holds() {
		return !leaving && dirty.value && isClientRequestContextCurrent(owner)
	}

	function guard(to: RouteLocationNormalized) {
		if (!holds()) return true
		leaveTarget.value = to.fullPath
		return false
	}

	onBeforeRouteLeave(guard)
	onBeforeRouteUpdate(guard)

	function stay() {
		leaveTarget.value = null
	}

	async function discardAndLeave() {
		const target = leaveTarget.value
		if (target === null) return
		leaving = true
		leaveTarget.value = null
		try {
			await router.push(target)
		} finally {
			// Only this confirmed navigation bypasses the guard. A reused task view must protect later edits,
			// and cancellation or a thrown navigation error must keep protecting the original form too.
			leaving = false
		}
	}

	useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
		if (!holds()) return
		event.preventDefault()
		// Older browsers only ask when a return value is set.
		event.returnValue = ''
	})

	return {leaveTarget, stay, discardAndLeave}
}
