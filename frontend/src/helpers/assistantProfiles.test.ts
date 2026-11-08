import {describe, expect, it} from 'vitest'
import {builtinProfileIDs, changeModuleAccess, effectiveModuleAccess, normalizeOptions, profileOptions, validOptions} from './assistantProfiles'

describe('assistant run options', () => {
	it('keeps personal notes explicitly off in every built-in scenario and old account template', () => {
		for (const id of builtinProfileIDs) expect(profileOptions(id).tool_modules.notes).toBe('off')
		expect(normalizeOptions({tool_modules: {project_tasks: 'write', compass: 'write'}}).tool_modules.notes).toBe('off')
		const previous = normalizeOptions({mcp_server_ids: ['account-mcp']})
		const next = changeModuleAccess(previous.tool_modules, 'read', 'notes', 'write')
		expect(next).toEqual({
			mode: 'write',
			tool_modules: {project_tasks: 'read', compass: 'off', notes: 'write'},
		})
		expect(previous.mcp_server_ids).toEqual(['account-mcp'])
		expect(previous.tool_modules.notes).toBe('off')
		expect(normalizeOptions({tool_modules: {notes: 'invalid'} as never}).tool_modules.notes).toBe('off')
	})
	it('requires explicit access to Compass and keeps legacy project access under the read-only ceiling', () => {
		const options = normalizeOptions()
		expect(options.tool_modules).toEqual({project_tasks: 'write', compass: 'off', notes: 'off'})
		expect(effectiveModuleAccess(options.tool_modules, 'project_tasks', 'read')).toBe('read')
		expect(effectiveModuleAccess(options.tool_modules, 'compass', 'write')).toBe('off')
		const isolated = normalizeOptions({tool_modules: {project_tasks: 'off', compass: 'write'}})
		expect(effectiveModuleAccess(isolated.tool_modules, 'project_tasks', 'write')).toBe('off')
		expect(effectiveModuleAccess(isolated.tool_modules, 'compass', 'write')).toBe('write')
		const cloned = normalizeOptions(isolated)
		cloned.tool_modules.compass = 'off'
		expect(isolated.tool_modules.compass).toBe('write')
		expect(validOptions({...isolated, tool_modules: {compass: 'admin'} as never})).toBe(false)
		expect(validOptions({...isolated, tool_modules: {unknown: 'read'} as never})).toBe(false)
		expect(normalizeOptions({tool_modules: {project_tasks: 'invalid'} as never}).tool_modules.project_tasks).toBe('off')
	})
	it('enabling Compass writes does not escalate previously read-only project tools', () => {
		const previous = normalizeOptions()
		const next = changeModuleAccess(previous.tool_modules, previous.mode, 'compass', 'write')
		expect(next).toEqual({tool_modules: {project_tasks: 'read', compass: 'write', notes: 'off'}, mode: 'write'})
		expect(changeModuleAccess(next.tool_modules, next.mode, 'project_tasks', 'off').tool_modules).toEqual({project_tasks: 'off', compass: 'write', notes: 'off'})
		expect(previous.tool_modules.compass).toBe('off')
	})
	it('keeps both execution switches off in every built-in scenario', () => {
		for (const id of builtinProfileIDs) {
			expect(profileOptions(id)).toMatchObject({stop_at_segment_limit: false, enable_subagents: false})
		}
	})
	it('preserves the MCP global ceiling when the last local write module is restricted', () => {
		const modules = {project_tasks: 'off', compass: 'write', notes: 'off'} as const
		expect(changeModuleAccess(modules, 'write', 'compass', 'off')).toEqual({
			tool_modules: {project_tasks: 'off', compass: 'off', notes: 'off'}, mode: 'write',
		})
		expect(changeModuleAccess(modules, 'write', 'compass', 'read').mode).toBe('write')
	})

	it('reads templates, run configurations and tab storage saved before the switches existed as off', () => {
		const {stop_at_segment_limit: _stop, enable_subagents: _subagents, ...legacy} = profileOptions('assist')
		const options = normalizeOptions({...legacy, write_project_ids: null})
		expect(options).toMatchObject({mode: 'write', stop_at_segment_limit: false, enable_subagents: false, write_project_ids: []})
		expect(validOptions(legacy as Parameters<typeof validOptions>[0])).toBe(true)
	})

	it('round-trips enabled switches and rejects malformed stored values', () => {
		const options = normalizeOptions({...profileOptions('plan'), stop_at_segment_limit: true, enable_subagents: true})
		expect(normalizeOptions(JSON.parse(JSON.stringify(options)))).toEqual(options)
		expect(validOptions({...options, enable_subagents: 'yes' as unknown as boolean})).toBe(false)
	})
	it('requires an explicit conversation choice for external MCP, including legacy templates', () => {
		for (const id of builtinProfileIDs) expect(profileOptions(id).mcp_server_ids).toEqual([])
		const ids = ['server-a', 'server-a', 'server-b']
		const options = normalizeOptions({mcp_server_ids: ids})
		expect(options.mcp_server_ids).toEqual(['server-a', 'server-b'])
		expect(options.mcp_server_ids).not.toBe(ids)
		expect(normalizeOptions({mcp_server_ids: null}).mcp_server_ids).toEqual([])
		expect(validOptions({...options, mcp_server_ids: [123 as unknown as string]})).toBe(false)
	})

})
