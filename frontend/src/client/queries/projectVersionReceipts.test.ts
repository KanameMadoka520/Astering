import {describe, expect, it} from 'vitest'
import {agentReceipt, planAgentRefresh} from './tcyConversations'

const args = {project_id: 6, version_id: 12}
function result(overrides: Record<string, unknown> = {}) {
	return {
		project_id: 6,
		restored_from_version_id: 12,
		before_version_id: 13,
		version: {id: 14, project_id: 6},
		current_hash: 'a'.repeat(64),
		changed_task_ids: [30, 31],
		removed_task_ids: [32],
		verified: true,
		...overrides,
	}
}
function receipt(tool: string, arguments_: object, data: unknown, success = true) {
	return agentReceipt('version-receipt', {tool, arguments: JSON.stringify(arguments_), result: JSON.stringify(data), success})
}

describe('native project version receipts', () => {
	it('uses verified identities to update the same shared restore path as the UI', () => {
		const plan = planAgentRefresh([receipt('restore_project_version', args, result())!])
		expect(plan.versionRestores).toEqual([{
			project_id: 6, changed_task_ids: [30, 31], removed_task_ids: [32],
		}])
		expect(plan.operations).toEqual([])
	})

	it('rejects failed, foreign, mismatched and malformed responses', () => {
		expect(receipt('restore_project_version', args, result(), false)).toBeUndefined()
		for (const response of [
			result({verified: false}), result({project_id: 7}), result({restored_from_version_id: 11}),
			result({version: {id: 14, project_id: 7}}), result({before_version_id: 0}),
			result({current_hash: 'guess'}), result({changed_task_ids: [0]}),
			result({removed_task_ids: [30]}), result({removed_task_ids: '32'}),
		]) {
			expect(planAgentRefresh([receipt('restore_project_version', args, response)!]).versionRestores).toEqual([])
		}
		expect(planAgentRefresh([receipt('call_mcp_tool', {tool_name: 'restore_project_version', ...args}, result())!]).versionRestores).toEqual([])
	})

	it('does not apply an earlier deletion after a later restore revives the same task', () => {
		const first = receipt('restore_project_version', args, result({changed_task_ids: [30], removed_task_ids: [31, 32]}))!
		const second = receipt('restore_project_version', {...args, version_id: 13}, result({
			restored_from_version_id: 13, changed_task_ids: [30, 31], removed_task_ids: [33],
		}))!
		expect(planAgentRefresh([first, second]).versionRestores).toEqual([{
			project_id: 6, changed_task_ids: [30, 31], removed_task_ids: [32, 33],
		}])
	})

	it('saving a checkpoint refreshes only that authorized project history', () => {
		const valid = receipt('save_project_version', {project_id: 6, name: 'Named'}, {id: 1, project_id: 6})!
		const wrong = receipt('save_project_version', {project_id: 6, name: 'Named'}, {id: 1, project_id: 7})!
		const plan = planAgentRefresh([valid, valid, wrong])
		expect(plan.versionSaves).toEqual([6])
		expect(plan.versionRestores).toEqual([])
		expect(plan.projectList).toBe(false)
	})
})
