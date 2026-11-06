import type {Action, Operation} from '@/client/generated'

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validResult(value: unknown): value is Record<string, unknown> {
	return record(value) && value.success !== false && value.executed !== false
		&& value.uncertain !== true && value.isError !== true && !value.error && !value.code
}

/** A restore receipt identifies the verified final active set, not only tasks with field changes. */
export function parseProjectVersionRestore(args: Record<string, unknown>, value: unknown) {
	if (!id(args.project_id) || !id(args.version_id) || !validResult(value) || value.verified !== true
		|| value.project_id !== args.project_id || value.restored_from_version_id !== args.version_id
		|| !id(value.before_version_id) || !record(value.version)
		|| value.version.project_id !== args.project_id || !id(value.version.id)
		|| typeof value.current_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.current_hash)) return undefined
	const validIds = (ids: unknown): ids is number[] => Array.isArray(ids) && ids.every(id)
	if (!validIds(value.changed_task_ids) || !validIds(value.removed_task_ids)) return undefined
	const active = new Set(value.changed_task_ids)
	if (value.removed_task_ids.some(task => active.has(task))) return undefined
	return {
		project_id: args.project_id,
		changed_task_ids: [...active],
		removed_task_ids: [...new Set(value.removed_task_ids)],
		before_version_id: value.before_version_id,
		version_id: value.version.id,
		name: typeof value.version.name === 'string' ? value.version.name : `#${value.version.id}`,
	}
}

export type ProjectVersionReceipt = {
	kind: 'saved' | 'restored'
	projectId: number
	versionId: number
	name: string
	beforeVersionId?: number
	activeTasks?: number
	removedTasks?: number
}

/** Native successful results only; a pending review or remote tool cannot imply a local restore. */
export function parseProjectVersionReceipt(action?: Action, operation?: Operation): ProjectVersionReceipt | undefined {
	if (action?.success !== true || operation?.external
		|| !['save_project_version', 'restore_project_version'].includes(action.tool ?? '')
		|| (operation && (operation.tool !== action.tool || operation.status !== 'succeeded' || operation.verified === false))) return undefined
	try {
		const args: unknown = JSON.parse(action.arguments ?? '')
		const value: unknown = JSON.parse(action.result ?? '')
		if (!record(args) || !validResult(value) || !id(args.project_id)) return undefined
		if (action.tool === 'save_project_version') {
			if (value.project_id !== args.project_id || !id(value.id)) return undefined
			return {kind: 'saved', projectId: args.project_id, versionId: value.id,
				name: typeof value.name === 'string' ? value.name : `#${value.id}`}
		}
		const restored = parseProjectVersionRestore(args, value)
		return restored ? {
			kind: 'restored', projectId: restored.project_id, versionId: restored.version_id,
			name: restored.name, beforeVersionId: restored.before_version_id,
			activeTasks: restored.changed_task_ids.length, removedTasks: restored.removed_task_ids.length,
		} : undefined
	} catch {
		return undefined
	}
}
