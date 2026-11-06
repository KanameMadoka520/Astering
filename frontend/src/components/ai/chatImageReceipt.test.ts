import {describe, expect, it} from 'vitest'
import type {Action, Operation} from '@/client/generated'
import {parseChatImageReceipt} from './chatImageReceipt'

const args = {
	id: 12,
	attachment_id: 'a'.repeat(64),
	position: 'end',
	description_version: 'b'.repeat(64),
}
const task = {
	id: 12,
	project_id: 3,
	description: '<p>Retained text</p><img src="/api/v2/tasks/12/attachments/4">',
}

function action(overrides: Partial<Action> = {}): Action {
	return {
		tool: 'insert_chat_image',
		success: true,
		arguments: JSON.stringify(args),
		result: JSON.stringify(task),
		...overrides,
	}
}

describe('native chat image receipts', () => {
	it.each([
		['insert_chat_image', 'inserted'],
		['remove_task_description_image', 'removed'],
	])('recognizes the settled %s result without requiring expanded attachments', (tool, kind) => {
		expect(parseChatImageReceipt(action({tool}))).toEqual({
			taskId: 12,
			kind,
		})
	})

	it.each([
		[{attachment_id: 'c'.repeat(64), position: 'before'}, 'replaced'],
		[{position: 'before', block_index: 0}, 'moved'],
		[{attachment_id: '', position: 'end'}, 'moved'],
		[{alt: ''}, 'updated'],
		[{title: 'Updated caption'}, 'updated'],
	] as const)('classifies the executed update parameters %j as %s', (changes, kind) => {
		expect(parseChatImageReceipt(action({
			tool: 'update_task_description_image',
			arguments: JSON.stringify({
				id: 12,
				...changes,
			}),
		}))).toEqual({
			taskId: 12,
			kind,
		})
	})

	it('uses the matching numeric identity and discards arbitrary model URLs', () => {
		expect(parseChatImageReceipt(action({
			result: JSON.stringify({
				...task,
				url: 'https://example.invalid/tasks/99',
				task_url: 'javascript:untrusted()',
			}),
		}))).toEqual({
			taskId: 12,
			kind: 'inserted',
		})
	})

	it.each([false, undefined, 'true'])('requires explicit boolean success: %j', success => {
		expect(parseChatImageReceipt(action({success: success as boolean}))).toBeUndefined()
	})

	it.each([
		{success: false},
		{executed: false},
		{uncertain: true},
		{isError: true},
		{code: 'WRITE_UNCERTAIN'},
		{error: 'write failed'},
	])('rejects contradictory failure or unknown-result evidence: %j', failure => {
		expect(parseChatImageReceipt(action({result: JSON.stringify({...task, ...failure})}))).toBeUndefined()
	})

	it.each([
		{id: 13},
		{id: '12'},
		{id: 0},
		{id: Number.MAX_SAFE_INTEGER + 1},
		{project_id: 0},
		{project_id: '3'},
		{description: undefined},
		{description: null},
	])('rejects an unverified task response: %j', change => {
		expect(parseChatImageReceipt(action({result: JSON.stringify({...task, ...change})}))).toBeUndefined()
	})

	it.each(['not json', 'null', '[]', '{}', '{"id":"12"}', '{"id":9007199254740992}'])(
		'requires actual matching task arguments: %s', argumentsValue => {
			expect(parseChatImageReceipt(action({arguments: argumentsValue}))).toBeUndefined()
		},
	)
	it.each([0, -1, '12', 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects matching identities that are not safe positive integer task IDs: %j', invalidId => {
			expect(parseChatImageReceipt(action({
				arguments: JSON.stringify({id: invalidId}),
				result: JSON.stringify({
					...task,
					id: invalidId,
				}),
			}))).toBeUndefined()
		},
	)

	it.each(['not json', 'null', '[]', '{}', '{"success":true}'])(
		'requires a complete task response: %s', result => {
			expect(parseChatImageReceipt(action({result}))).toBeUndefined()
		},
	)

	it('does not interpret an MCP inner tool name as a native image write', () => {
		expect(parseChatImageReceipt(action({
			tool: 'call_mcp_tool',
			arguments: JSON.stringify({
				tool_name: 'insert_chat_image',
				arguments: args,
			}),
		}))).toBeUndefined()
		expect(parseChatImageReceipt(action(), {
			tool: 'insert_chat_image',
			status: 'succeeded',
			external: {
				server_id: 'remote',
				tool: 'insert_chat_image',
			},
		})).toBeUndefined()
	})

	it.each(['prepared', 'running', 'failed', 'rejected', 'unknown'] as const)(
		'does not convert a %s operation into successful execution', status => {
			const operation: Operation = {
				tool: 'insert_chat_image',
				status,
				arguments: JSON.stringify(args),
			}
			expect(parseChatImageReceipt(undefined, operation)).toBeUndefined()
			expect(parseChatImageReceipt(action(), operation)).toBeUndefined()
		},
	)

	it('rejects an unrelated operation or explicitly unverified write', () => {
		expect(parseChatImageReceipt(action(), {
			tool: 'remove_task_description_image',
			status: 'succeeded',
		})).toBeUndefined()
		expect(parseChatImageReceipt(action(), {
			tool: 'insert_chat_image',
			status: 'succeeded',
			verified: false,
		})).toBeUndefined()
	})
	it('accepts a corresponding verified and settled native operation', () => {
		expect(parseChatImageReceipt(action(), {
			tool: 'insert_chat_image',
			status: 'succeeded',
			verified: true,
		})).toEqual({
			taskId: 12,
			kind: 'inserted',
		})
	})

	it('does not invent an update when no replacement, placement or text change is recorded', () => {
		expect(parseChatImageReceipt(action({
			tool: 'update_task_description_image',
			arguments: '{"id":12}',
		}))).toBeUndefined()
		expect(parseChatImageReceipt(action({tool: 'get_task_description_layout'}))).toBeUndefined()
	})
})
