export interface AssistantOptions {
 search_mode?: 'auto' | 'off' | 'required'
	connection_id: string
	project_id: number
	mode: 'read' | 'write'
	allow_delete: boolean
	approval: 'smart' | 'review' | 'auto'
	write_project_ids: number[]
	max_rounds: number
	max_operations: number
	timeout_seconds: number
	token_budget: number
	stop_at_segment_limit: boolean
	enable_subagents: boolean
}
export const builtinProfileIDs = ['ask', 'plan', 'assist', 'batch'] as const
export function profileOptions(id = 'ask'): AssistantOptions {
	const options: AssistantOptions = {search_mode: 'auto', connection_id: '', project_id: 0, mode: 'read', allow_delete: false, approval: 'smart', write_project_ids: [], max_rounds: 8, max_operations: 20, timeout_seconds: 120, token_budget: 0, stop_at_segment_limit: false, enable_subagents: false}
	if (id !== 'ask') Object.assign(options, {mode: 'write', max_rounds: 16, max_operations: 40, timeout_seconds: 180})
	if (id === 'plan') Object.assign(options, {approval: 'review', max_rounds: 12, max_operations: 30})
	if (id === 'batch') Object.assign(options, {approval: 'review', max_rounds: 24, max_operations: 80, timeout_seconds: 300})
	return options
}
// Templates, run configurations and tab storage saved before these switches existed omit them; the server omits false too.
export function normalizeOptions(options?: Omit<Partial<AssistantOptions>, 'write_project_ids'> & {write_project_ids?: number[] | null}): AssistantOptions {
	return {...profileOptions(), ...options, write_project_ids: [...(options?.write_project_ids ?? [])], stop_at_segment_limit: options?.stop_at_segment_limit === true, enable_subagents: options?.enable_subagents === true}
}
export function validOptions(o: AssistantOptions) {
	return [o.stop_at_segment_limit, o.enable_subagents].every(v => v === undefined || typeof v === 'boolean')
		&& [[o.max_rounds, 1, 40], [o.max_operations, 1, 100], [o.timeout_seconds, 1, 600], [o.token_budget, 0, 1000000]].every(([n, min, max]) => Number.isInteger(n) && n >= min && n <= max)
}
