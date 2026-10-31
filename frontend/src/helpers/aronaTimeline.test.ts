import {describe, expect, it} from 'vitest'
import type {Action, ModelStep, Operation, RunResult, ToolCall} from '@/client/generated'
import {callName, finalAnswer, groupEntries, hidesLastStepText, NO_OPERATIONS, rejectedByStep, stepEntries, timelineLayout} from './aronaTimeline'

const call = (name: string, args = '{}'): ToolCall => ({id: name, function: {name, arguments: args}})
const action = (round: number, tool: string, success = true): Action => ({round, tool, success, arguments: '{}', result: '{}', duration_ms: 100})

describe('Arona execution timeline', () => {
	it('pairs repeated tool names one by one and keeps the unexecuted drafts', () => {
		const step: ModelStep = {round: 2, tool_calls: [call('create_task'), call('create_task'), call('create_task')]}
		const entries = stepEntries(step, [action(1, 'create_task'), action(2, 'create_task'), action(2, 'create_task', false)])
		expect(entries.map(entry => [entry.tool, entry.action?.success, Boolean(entry.call)])).toEqual([
			['create_task', true, true],
			['create_task', false, true],
			['create_task', undefined, true],
		])
	})

	it('unwraps invoke_tool and turns a running receipt into the executing state of its draft', () => {
		const step: ModelStep = {round: 1, tool_calls: [call('invoke_tool', JSON.stringify({name: 'create_label', arguments: {title: 'Urgent'}})), call('list_tasks')]}
		const running = [{id: 'op-1', tool: 'create_label', status: 'running' as const, arguments: '{"title":"Urgent"}'}]
		const entries = stepEntries(step, [], running)
		expect(entries).toHaveLength(2)
		expect(entries[0]).toMatchObject({tool: 'create_label', operation: {id: 'op-1'}})
		expect(entries[1].operation).toBeUndefined()
		// Once the real action exists, the receipt is not shown a second time.
		expect(stepEntries(step, [{...action(1, 'create_label'), arguments: '{"title":"Urgent"}'}], running)).toHaveLength(2)
	})

	it('pairs by tool and arguments and shows a rejected review decision on its own call', () => {
		// The reviewer approved #11 and #13 and rejected #12: a rejection records a receipt, never an action.
		const step: ModelStep = {round: 4, tool_calls: [call('delete_task', '{"id":11}'), call('delete_task', '{"id":12}'), call('delete_task', '{"force":true, "id":13}')]}
		const actions = [{...action(4, 'delete_task'), arguments: '{"id":11}'}, {...action(4, 'delete_task'), arguments: '{"force":true,"id":13}'}]
		const rejected: Operation = {id: 'op-12', tool: 'delete_task', status: 'rejected', arguments: '{"id":12}'}
		const perStep = rejectedByStep([step], actions, [rejected])
		expect(perStep).toEqual([[rejected]])
		const entries = stepEntries(step, actions, NO_OPERATIONS, perStep[0])
		expect(entries.map(entry => [entry.action?.arguments ?? null, entry.operation?.status ?? null])).toEqual([
			['{"id":11}', null],
			[null, 'rejected'],
			['{"force":true,"id":13}', null],
		])
		// While #13 still runs, its receipt goes to #13, never to the rejected call.
		const running: Operation = {id: 'op-13', tool: 'delete_task', status: 'running', arguments: '{"force":true,"id":13}'}
		const live = stepEntries(step, actions.slice(0, 1), [rejected, running], perStep[0])
		expect(live.map(entry => entry.operation?.id ?? entry.action?.arguments)).toEqual(['{"id":11}', 'op-12', 'op-13'])
	})

	it('gives each rejection to the earliest matching round and keeps a later re-proposal pending', () => {
		// The same proposal again in a later round still awaits review; the rejection stays with the first one.
		const rejected: Operation = {id: 'op-1', tool: 'delete_task', status: 'rejected', arguments: '{"id":12}'}
		const steps: ModelStep[] = [{round: 1, tool_calls: [call('delete_task', '{"id":12}')]}, {round: 2, tool_calls: [call('delete_task', '{"id": 12}')]}]
		const perStep = rejectedByStep(steps, [], [rejected])
		expect(perStep[0]).toEqual([rejected])
		expect(perStep[1]).toBe(NO_OPERATIONS)
		expect(stepEntries(steps[1], [], NO_OPERATIONS, perStep[1])[0].operation).toBeUndefined()

		// A reviewer may edit the arguments and then reject: the decision still belongs to that call, by its tool name.
		const edited: Operation = {id: 'op-2', tool: 'update_task', status: 'rejected', arguments: '{"id":5,"title":"Edited"}'}
		const draft: ModelStep = {round: 3, tool_calls: [call('update_task', '{"id":5,"title":"Draft"}')]}
		const own = rejectedByStep([draft], [], [edited])[0]
		expect(stepEntries(draft, [], NO_OPERATIONS, own)[0].operation).toBe(edited)
	})

	it('keeps a malformed invoke_tool envelope as one invoke_tool row, like the backend', () => {
		// Stringified arguments are not an object, so the backend runs and fails it as invoke_tool itself.
		const envelope = JSON.stringify({name: 'add_comment', arguments: '{"task_id":5}'})
		const malformed = call('invoke_tool', envelope)
		expect(callName(malformed)).toBe('invoke_tool')
		expect(callName(call('invoke_tool', JSON.stringify({name: 'add_comment', arguments: {task_id: 5}, extra: 1})))).toBe('invoke_tool')
		expect(callName(call('invoke_tool', JSON.stringify({name: 'invoke_tool', arguments: {}})))).toBe('invoke_tool')
		const valid = call('invoke_tool', JSON.stringify({name: 'add_comment', arguments: {task_id: 6, comment: 'Done'}}))
		expect(callName(valid)).toBe('add_comment')
		const step: ModelStep = {round: 1, tool_calls: [malformed, valid]}
		const actions: Action[] = [
			{...action(1, 'invoke_tool', false), arguments: envelope},
			{...action(1, 'add_comment'), arguments: '{"comment":"Done","task_id":6}'},
		]
		expect(stepEntries(step, actions).map(entry => [entry.tool, entry.action?.success, Boolean(entry.call)])).toEqual([
			['invoke_tool', false, true],
			['add_comment', true, true],
		])
	})

	it('keeps earlier rounds visible and hides only the final text that the answer block shows', () => {
		const steps: ModelStep[] = [
			{round: 1, text: 'Looking up projects.', tool_calls: [call('list_projects')]},
			{round: 2, text: 'Creating tasks.', tool_calls: [call('create_task')]},
			{round: 3, text: 'Checking the result.', tool_calls: [call('list_tasks')]},
			{round: 4, text: 'All 3 tasks are created.'},
		]
		const running: RunResult = {stage: 'model', steps}
		expect(finalAnswer(running, true)).toBe('')
		expect(hidesLastStepText(running, true)).toBe(false)

		const done: RunResult = {...running, reply: 'All 3 tasks are created.\n'}
		expect(finalAnswer(done, false)).toBe('All 3 tasks are created.\n')
		expect(hidesLastStepText(done, false)).toBe(true)
		expect(finalAnswer({steps}, false)).toBe('All 3 tasks are created.')

		// An error reply differs from the last round, so both stay visible.
		expect(hidesLastStepText({...running, reply: 'The provider returned an error.'}, false)).toBe(false)
		// A run that stopped after a tool round has no final answer; its text stays in the timeline.
		expect(finalAnswer({steps: steps.slice(0, 3)}, false)).toBe('')
	})

	it('groups four or more consecutive calls of one tool with honest counts', () => {
		const calls = [...Array.from({length: 34}, () => call('create_task')), call('list_tasks'), call('get_task'), call('get_task'), call('get_task')]
		const actions = Array.from({length: 33}, (_, index) => action(1, 'create_task', index !== 5))
		const items = groupEntries(stepEntries({round: 1, tool_calls: calls}, actions))
		expect(items.map(item => item.kind)).toEqual(['group', 'entry', 'entry', 'entry', 'entry'])
		expect(items[0]).toMatchObject({tool: 'create_task', succeeded: 32, failed: 1, pending: 1, durationMs: 3300})
		expect(items[0].kind === 'group' && items[0].entries).toHaveLength(34)
	})

	it('places compactions before the next round and subagents after the round that delegated them', () => {
		// Go timestamps carry nanoseconds.
		const at = (second: number) => `2026-11-01T08:00:${String(second).padStart(2, '0')}.123456789Z`
		const steps: ModelStep[] = [
			{round: 1, started: at(0), tool_calls: [call('list_tasks')]},
			{round: 2, started: at(20), tool_calls: [call('invoke_tool', JSON.stringify({name: 'delegate_tasks', arguments: {tasks: [{goal: 'Read project 7'}]}}))]},
			{round: 3, started: at(40)},
		]
		const items = timelineLayout(steps, [],
			[{id: 'checkpoint', status: 'completed', started: at(10)}, {id: 'live', status: 'running', started: at(50)}],
			[{id: 'child', status: 'completed', started: at(25)}, {id: 'unmatched', status: 'failed', started: at(5)}])
		expect(items.map(item => item.kind === 'step' ? `round ${item.step.round}` : item.key)).toEqual([
			'round 1', 'compaction-checkpoint', 'round 2', 'subagent-child', 'round 3', 'subagent-unmatched', 'compaction-live',
		])
		expect(items.flatMap(item => item.kind !== 'step' && item.first ? [item.key] : [])).toEqual(['compaction-checkpoint', 'subagent-child'])
	})
})
