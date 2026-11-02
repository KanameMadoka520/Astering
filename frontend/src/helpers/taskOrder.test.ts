import {describe, expect, it} from 'vitest'
import {parseTaskOrderResult} from './taskOrder'

const args = {
	project_id: 1,
	view_id: 4,
	bucket_id: 8,
	task_ids: [3],
}
const result = {
	...args,
	view_kind: 'kanban',
	changed_positions: [{
		task_id: 3,
		project_view_id: 4,
		position: 50,
	}],
	order_version: 'a'.repeat(64),
	position_recalculated: false,
	manual_order_saved: true,
	verified: true,
}

describe('task-order receipt validation', () => {
	it('accepts the exact verified scope and a no-op receipt without pretending to receive a full task', () => {
		expect(parseTaskOrderResult(result, args)).toEqual(result)
		expect(parseTaskOrderResult({...result, changed_positions: []}, args)?.task_ids).toEqual([3])
	})

	it.each([
		{project_id: 2},
		{view_id: 5},
		{bucket_id: 9},
		{task_ids: [2]},
		{task_ids: [3, 3]},
		{changed_positions: [{task_id: 3, project_view_id: 5, position: 50}]},
		{changed_positions: [{task_id: 3, project_view_id: 4, position: Infinity}]},
		{verified: false},
		{manual_order_saved: false},
		{order_version: ''},
	])('does not patch or link to a mismatched or malformed result: %j', override => {
		expect(parseTaskOrderResult({...result, ...override}, args)).toBeUndefined()
	})

	it.each([null, [], 'invalid'])('does not treat invalid request arguments as an omitted scope: %j', invalid => {
		expect(parseTaskOrderResult(result, invalid)).toBeUndefined()
	})
})
