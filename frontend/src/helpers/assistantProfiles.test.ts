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
})
