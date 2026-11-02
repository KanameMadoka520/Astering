export type ViewTaskPosition = {
	task_id: number
	project_view_id: number
	position: number
}

export type TaskOrderResult = {
	project_id: number
	view_id: number
	view_kind: 'list' | 'table' | 'kanban'
	bucket_id: number
	task_ids: number[]
	changed_positions: ViewTaskPosition[]
	order_version: string
	position_recalculated: boolean
	manual_order_saved: true
	verified: true
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Tool results are untrusted JSON. Never apply a position to a different view or request. */
export function parseTaskOrderResult(value: unknown, args?: unknown): TaskOrderResult | undefined {
	if (!record(value) || !id(value.project_id) || !id(value.view_id)
		|| typeof value.view_kind !== 'string' || !['list', 'table', 'kanban'].includes(value.view_kind)
		|| typeof value.bucket_id !== 'number' || !Number.isSafeInteger(value.bucket_id) || value.bucket_id < 0
		|| (value.view_kind === 'kanban' && !id(value.bucket_id))
		|| value.manual_order_saved !== true || value.verified !== true
		|| typeof value.order_version !== 'string' || !/^[a-f0-9]{64}$/.test(value.order_version)
		|| typeof value.position_recalculated !== 'boolean'
		|| !Array.isArray(value.task_ids) || value.task_ids.length < 1 || value.task_ids.length > 100
		|| !value.task_ids.every(id) || new Set(value.task_ids).size !== value.task_ids.length
		|| !Array.isArray(value.changed_positions)) return undefined
	const positions = value.changed_positions
	if (!positions.every(position => record(position) && id(position.task_id)
		&& position.project_view_id === value.view_id && typeof position.position === 'number'
		&& Number.isFinite(position.position))
		|| new Set(positions.map(position => position.task_id)).size !== positions.length) return undefined
	const taskIds = value.task_ids
	if (args !== undefined && !record(args)) return undefined
	if (args && (args.project_id !== value.project_id || args.view_id !== value.view_id
		|| (args.bucket_id ?? 0) !== value.bucket_id
		|| !Array.isArray(args.task_ids) || args.task_ids.length !== value.task_ids.length
		|| args.task_ids.some((task, index) => task !== taskIds[index]))) return undefined
	return value as TaskOrderResult
}
