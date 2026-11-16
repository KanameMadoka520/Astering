import type {RouteLocationRaw} from 'vue-router'

export const OPEN_NOTIFICATION_INBOX = 'astering:open-notification-inbox'

export function nativeNotificationAction(event: unknown, owner: {userID: number, sid: string, origin: string}) {
	if (!event || typeof event !== 'object' || Array.isArray(event) || !owner.sid || owner.userID <= 0) return null
	const message = event as Record<string, unknown>
	if (message.event !== 'openNotification' || message.user_id !== owner.userID ||
		message.sid !== owner.sid || message.server_origin !== owner.origin) return null
	return nativeNotificationTarget(message.target)
}

function positiveID(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
}

/** A notification can select a known resource, never supply a URL or execute a command. */
export function nativeNotificationTarget(value: unknown): RouteLocationRaw | 'inbox' | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const target = value as Record<string, unknown>
	if (Object.keys(target).some(key => key !== 'kind' && key !== 'id')) return null
	if (target.kind === 'task' && positiveID(target.id)) return {name: 'task.detail', params: {id: target.id}}
	if (target.kind === 'project' && positiveID(target.id)) return {name: 'project.index', params: {projectId: target.id}}
	if (target.kind === 'automation' && typeof target.id === 'string' &&
		/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(target.id)) {
		return {name: 'automations', params: {automationId: target.id}}
	}
	return target.kind === 'notifications' && target.id === '' ? 'inbox' : null
}
