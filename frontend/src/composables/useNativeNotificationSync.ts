import {onScopeDispose} from 'vue'
import {useQueryClient} from '@tanstack/vue-query'
import {getNativeAndroidClientInfo, isNativeAndroid, requestNativeAndroid} from '@/helpers/nativeAndroid'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {AUTH_TYPES} from '@/constants/auth'

/** Visible data changes are a hint to refresh the native reminder plan, never a source of reminder data. */
export function useNativeNotificationSync() {
	const client = useQueryClient()
	let disposed = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let probing = false
	let lastSent = 0
	const relevant = new Set(['tasks', 'projects', 'notifications', 'automations', 'task-routine', 'kanban', 'calendar-tasks'])
	const unsubscribe = client.getQueryCache().subscribe(event => {
		if (disposed || !isNativeAndroid() || event.type !== 'updated' || !['success', 'invalidate'].includes(event.action.type) ||
			!relevant.has(String(event.query.queryKey[0])) || timer || probing) return
		const context = captureClientRequestContext()
		if (context.identity?.type !== AUTH_TYPES.USER) return
		timer = setTimeout(async () => {
			timer = undefined
			if (disposed || !isClientRequestContextCurrent(context)) return
			probing = true
			const info = await getNativeAndroidClientInfo()
			probing = false
			if (disposed || !isClientRequestContextCurrent(context) || !info?.capabilities.deviceNotifications) return
			lastSent = Date.now()
			// Older clients and disabled notifications need no error toast or fallback request.
			void requestNativeAndroid('notificationsReadChanged').catch(() => {})
		}, Math.max(1500, 30_000 - (Date.now() - lastSent)))
	})
	onScopeDispose(() => {
		disposed = true
		clearTimeout(timer)
		unsubscribe()
	})
}
