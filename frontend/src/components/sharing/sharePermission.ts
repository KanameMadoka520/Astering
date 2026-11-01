import {PERMISSIONS} from '@/constants/permissions'

export function sharePermissionIcon(permission?: number | null) {
	if (permission === PERMISSIONS.ADMIN) return 'lock'
	return permission === PERMISSIONS.READ_WRITE ? 'pen' : 'users'
}

export function sharePermissionKey(permission?: number | null) {
	if (permission === PERMISSIONS.ADMIN) return 'project.share.permission.admin'
	return permission === PERMISSIONS.READ_WRITE
		? 'project.share.permission.readWrite'
		: 'project.share.permission.read'
}
