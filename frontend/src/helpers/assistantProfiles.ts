export const toolModuleIDs = ['project_tasks', 'compass', 'notes'] as const
export type ToolModuleID = typeof toolModuleIDs[number]
export type ToolModuleAccess = 'off' | 'read' | 'write'
export type ToolModules = Record<ToolModuleID, ToolModuleAccess>
export const defaultToolModules = (): ToolModules => ({project_tasks: 'write', compass: 'off', notes: 'off'})
export function normalizeToolModules(value?: Partial<ToolModules> | null): ToolModules {
	return Object.fromEntries(toolModuleIDs.map(id => {
		const access = value?.[id]
		return [id, access === undefined ? defaultToolModules()[id]
			: ['off', 'read', 'write'].includes(access) ? access : 'off']
	})) as ToolModules
}
export function effectiveModuleAccess(modules: ToolModules, id: ToolModuleID, mode: 'read' | 'write'): ToolModuleAccess {
	return modules[id] === 'write' && mode === 'read' ? 'read' : modules[id]
}
export function changeModuleAccess(modules: ToolModules, mode: 'read' | 'write', id: ToolModuleID, access: ToolModuleAccess) {
	// Raising one module must not silently raise another module that was capped at read-only.
	const next = Object.fromEntries(toolModuleIDs.map(key => [key, effectiveModuleAccess(modules, key, mode)])) as ToolModules
	next[id] = access
	// The global write ceiling also governs selected MCP servers. Turning off a
	// local module must not silently change those independent connections.
	return {tool_modules: next, mode: mode === 'write' || Object.values(next).includes('write') ? 'write' as const : 'read' as const}
}

export interface AssistantOptions {
	tool_modules: ToolModules
	search_mode?: 'auto' | 'off' | 'required'
	connection_id: string
	project_id: number
	mode: 'read' | 'write'
	allow_delete: boolean
	approval: 'smart' | 'review' | 'auto'
	write_project_ids: number[]
	mcp_server_ids: string[]
	max_rounds: number
	max_operations: number
	timeout_seconds: number
	token_budget: number
	stop_at_segment_limit: boolean
	enable_subagents: boolean
}
export const builtinProfileIDs = ['ask', 'plan', 'assist', 'batch'] as const
export function profileOptions(id = 'ask'): AssistantOptions {
	const options: AssistantOptions = {
		search_mode: 'auto',
		connection_id: '',
		project_id: 0,
		mode: 'read',
		allow_delete: false,
		approval: 'smart',
		write_project_ids: [],
		mcp_server_ids: [],
		tool_modules: defaultToolModules(),
		max_rounds: 8,
		max_operations: 20,
		timeout_seconds: 120,
		token_budget: 0,
		stop_at_segment_limit: false,
		enable_subagents: false,
	}
	if (id !== 'ask') Object.assign(options, {mode: 'write', max_rounds: 16, max_operations: 40, timeout_seconds: 180})
	if (id === 'plan') Object.assign(options, {approval: 'review', max_rounds: 12, max_operations: 30})
	if (id === 'batch') Object.assign(options, {approval: 'review', max_rounds: 24, max_operations: 80, timeout_seconds: 300})
	return options
}
// Templates, run configurations and tab storage saved before these switches existed omit them; the server omits false too.
export function normalizeOptions(options?: Omit<Partial<AssistantOptions>, 'write_project_ids' | 'mcp_server_ids' | 'tool_modules'> & {
	write_project_ids?: number[] | null
	mcp_server_ids?: string[] | null
	tool_modules?: Partial<ToolModules> | null
}): AssistantOptions {
	return {
		...profileOptions(),
		...options,
		write_project_ids: [...(options?.write_project_ids ?? [])],
		mcp_server_ids: [...new Set((options?.mcp_server_ids ?? []).filter(id => typeof id === 'string' && id !== ''))],
		tool_modules: normalizeToolModules(options?.tool_modules),
		stop_at_segment_limit: options?.stop_at_segment_limit === true,
		enable_subagents: options?.enable_subagents === true,
	}
}
export function validOptions(o: AssistantOptions) {
	return [o.stop_at_segment_limit, o.enable_subagents].every(v => v === undefined || typeof v === 'boolean')
		&& (o.tool_modules === undefined || (o.tool_modules !== null && typeof o.tool_modules === 'object'
			&& !Array.isArray(o.tool_modules)
			&& Object.entries(o.tool_modules).every(([key, value]) => toolModuleIDs.includes(key as ToolModuleID)
				&& (value === undefined || ['off', 'read', 'write'].includes(value)))))
		&& (o.mcp_server_ids === undefined || (Array.isArray(o.mcp_server_ids)
			&& o.mcp_server_ids.every(id => typeof id === 'string' && id !== '')))
		&& [[o.max_rounds, 1, 40], [o.max_operations, 1, 100], [o.timeout_seconds, 1, 600], [o.token_budget, 0, 1000000]].every(([n, min, max]) => Number.isInteger(n) && n >= min && n <= max)
}
