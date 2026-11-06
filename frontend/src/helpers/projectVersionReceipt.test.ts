import {mount} from '@vue/test-utils'
import {describe, expect, it, vi} from 'vitest'
import type {Action, Operation} from '@/client/generated'
import ProjectVersionReceipt from '@/components/ai/ProjectVersionReceipt.vue'
import {parseProjectVersionReceipt} from './projectVersionReceipt'

vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))

function restore(overrides: Record<string, unknown> = {}): Action {
	return {
		tool: 'restore_project_version', success: true,
		arguments: JSON.stringify({project_id: 6, version_id: 12}),
		result: JSON.stringify({project_id: 6, restored_from_version_id: 12, before_version_id: 13,
			version: {id: 14, project_id: 6, name: 'Restored'}, current_hash: 'a'.repeat(64),
			changed_task_ids: [1, 2, 2], removed_task_ids: [3], verified: true, ...overrides}),
	}
}

describe('project history timeline receipt', () => {
	it('offers distinct verified result and safety-checkpoint links using SPA routes', () => {
		const receipt = parseProjectVersionReceipt(restore())!
		expect(receipt).toMatchObject({kind: 'restored', activeTasks: 2, removedTasks: 1, beforeVersionId: 13})
		const wrapper = mount(ProjectVersionReceipt, {props: {receipt}, global: {stubs: {
			RouterLink: {name: 'RouterLink', props: ['to'], template: '<a><slot /></a>'},
		}}})
		const links = wrapper.findAllComponents({name: 'RouterLink'})
		expect(links.map(link => link.props('to'))).toEqual([
			{name: 'project.versions', params: {projectId: 6}, query: {version: 14}},
			{name: 'project.versions', params: {projectId: 6}, query: {version: 13}},
		])
	})

	it('never announces an uncertain, failed, pending, foreign or malformed restore', () => {
		for (const change of [
			{verified: false}, {project_id: 7}, {uncertain: true}, {success: false}, {error: 'failed'},
			{changed_task_ids: [1, Number.MAX_SAFE_INTEGER + 1]}, {removed_task_ids: [1]},
		]) expect(parseProjectVersionReceipt(restore(change))).toBeUndefined()
		expect(parseProjectVersionReceipt({...restore(), success: false})).toBeUndefined()
		expect(parseProjectVersionReceipt({...restore(), result: '{broken'})).toBeUndefined()
		expect(parseProjectVersionReceipt({...restore(), tool: 'call_mcp_tool'})).toBeUndefined()
		for (const operation of [
			{tool: 'restore_project_version', status: 'pending'},
			{tool: 'restore_project_version', status: 'succeeded', verified: false},
			{tool: 'save_project_version', status: 'succeeded'},
			{tool: 'restore_project_version', status: 'succeeded', external: {server_id: 'remote'}},
		]) expect(parseProjectVersionReceipt(restore(), operation as Operation)).toBeUndefined()
	})

	it('uses only the actual saved checkpoint identity, with a useful fallback name', () => {
		const action: Action = {tool: 'save_project_version', success: true,
			arguments: '{"project_id":6,"name":"Requested"}', result: '{"project_id":6,"id":15}'}
		expect(parseProjectVersionReceipt(action)).toEqual({kind: 'saved', projectId: 6, versionId: 15, name: '#15'})
		expect(parseProjectVersionReceipt({...action, result: '{"project_id":7,"id":15}'})).toBeUndefined()
	})
})
