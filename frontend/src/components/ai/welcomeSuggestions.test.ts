import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {builtinProfileIDs, profileOptions} from '@/helpers/assistantProfiles'
import {suggestionOptions, suggestionProfileSwitch, welcomeSuggestions} from './welcomeSuggestions'

// Read the raw files: imported locale JSON is precompiled into message functions.
function lookup(locale: string, key: string): unknown {
	const path = `../../i18n/lang/${locale}.json`
	const messages = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
	return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('welcome suggestions', () => {
	it('offers three or four distinct suggestions', () => {
		expect(welcomeSuggestions.length).toBeGreaterThanOrEqual(3)
		expect(welcomeSuggestions.length).toBeLessThanOrEqual(4)
		expect(new Set(welcomeSuggestions.map(s => s.id)).size).toBe(welcomeSuggestions.length)
	})

	it.each(['en', 'zh-CN'])('references labels and prompts that exist in %s', locale => {
		for (const suggestion of welcomeSuggestions) {
			for (const key of [suggestion.label, suggestion.prompt]) {
				const value = lookup(locale, key)
				expect(typeof value, `${locale}: ${key}`).toBe('string')
				expect((value as string).trim(), `${locale}: ${key}`).not.toBe('')
			}
		}
	})

	it('only switches to built-in scenarios that have a visible name', () => {
		for (const {profile} of welcomeSuggestions) {
			if (!profile) continue
			expect(builtinProfileIDs).toContain(profile)
			expect(typeof lookup('en', `assistantUI.presets.${profile}.name`)).toBe('string')
		}
	})

	it('keeps read-only suggestions in the current scenario', () => {
		const readOnly = welcomeSuggestions.find(s => s.id === 'today')!
		expect(readOnly.profile).toBeUndefined()
		expect(suggestionProfileSwitch(readOnly, 'assist')).toBeUndefined()
	})

	it('switches only when the required scenario is not already active', () => {
		const create = welcomeSuggestions.find(s => s.id === 'create')!
		expect(suggestionProfileSwitch(create, 'ask')).toBe('plan')
		expect(suggestionProfileSwitch(create, '')).toBe('plan')
		expect(suggestionProfileSwitch(create, 'custom-1')).toBe('plan')
		expect(suggestionProfileSwitch(create, 'plan')).toBeUndefined()
	})
})

describe('suggestionOptions', () => {
	const restricted = {
		...profileOptions('ask'),
		connection_id: 'conn-2',
		project_id: 7,
		search_mode: 'off' as const,
		write_project_ids: [
			7,
			9,
		],
		stop_at_segment_limit: true,
	}

	it('keeps an explicit write restriction instead of the unrestricted preset default', () => {
		const options = suggestionOptions('plan', restricted)
		expect(options.write_project_ids).toEqual([
			7,
			9,
		])
		expect(options.write_project_ids).not.toBe(restricted.write_project_ids)
	})

	it('keeps connection, project context and search choice', () => {
		const options = suggestionOptions('plan', restricted)
		expect(options.connection_id).toBe('conn-2')
		expect(options.project_id).toBe(7)
		expect(options.search_mode).toBe('off')
	})

	it('keeps pausing at segment limits instead of the auto-continuing preset default', () => {
		expect(suggestionOptions('plan', restricted).stop_at_segment_limit).toBe(true)
	})

	it('takes mode, approval and budgets from the preset', () => {
		const options = suggestionOptions('plan', restricted)
		const plan = profileOptions('plan')
		expect(options.mode).toBe(plan.mode)
		expect(options.approval).toBe('review')
		expect(options.max_operations).toBe(plan.max_operations)
	})
	it('keeps only the explicitly selected external servers when changing the scenario', () => {
		const current = {...restricted, mcp_server_ids: ['chosen-server']}
		const options = suggestionOptions('plan', current)
		expect(options.mcp_server_ids).toEqual(['chosen-server'])
		expect(options.mcp_server_ids).not.toBe(current.mcp_server_ids)
	})

})
