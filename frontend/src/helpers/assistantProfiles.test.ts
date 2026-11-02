import {describe, expect, it} from 'vitest'
import {builtinProfileIDs, normalizeOptions, profileOptions, validOptions} from './assistantProfiles'

describe('assistant run options', () => {
	it('keeps both execution switches off in every built-in scenario', () => {
		for (const id of builtinProfileIDs) {
			expect(profileOptions(id)).toMatchObject({stop_at_segment_limit: false, enable_subagents: false})
		}
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
