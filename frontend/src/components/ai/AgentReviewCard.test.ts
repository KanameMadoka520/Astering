import {mount, shallowMount, type DOMWrapper} from '@vue/test-utils'
import {describe, expect, it, vi} from 'vitest'
import type {ChatTurn, Operation} from '@/client/generated'
import AgentReviewCard from './AgentReviewCard.vue'

// Named values show in the output, so the assertions see the real numbers and titles a message receives.
vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string, values?: unknown) => values && typeof values === 'object'
			? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${String(value)}`).join(', ')})`
			: key,
		locale: {value: 'en'},
	}),
}))

describe('project completion review', () => {
	it('shows the persisted project state before approval and submits the exact pending operation', async () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: {
					id: 'turn-1',
					result: {
						pause: 'review',
						pending: {
							id: 'operation-1',
							tool: 'set_project_completed',
							before: '[{"id":7,"title":"A project","is_completed":false}]',
							arguments: '{"id":7,"completed":true}',
						},
					},
				},
			},
			global: {
				stubs: {
					Icon: true,
					XButton: {template: '<button><slot /></button>'},
				},
			},
		})
		const cells = wrapper.findAll('tbody td').map(cell => cell.text())
		expect(cells).toEqual(['#7 A project', 'agent.fields.completed', 'false', 'true'])
		const approve = wrapper.findAll('button').find(button => button.text() === 'agent.approve')!
		await wrapper.setProps({busy: true})
		await approve.trigger('click')
		expect(wrapper.emitted('review')).toBeUndefined()
		await wrapper.setProps({busy: false})
		await approve.trigger('click')
		expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({
			turn_id: 'turn-1',
			operation_id: 'operation-1',
			decision: 'approve',
		})
	})
})

describe('routine check-in review', () => {
	it('compares the requested check-in with the current period under a routine label', () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: {
					id: 'turn-2',
					result: {
						pause: 'review',
						pending: {
							id: 'operation-2',
							tool: 'check_in_task_routine',
							before: '[{"id":12,"title":"Water the plants","done":false,"routine":{"enabled":true,"completed_today":false,"date":"2026-11-01"}}]',
							arguments: '{"id":12,"date":"2026-11-01","completed":true}',
						},
					},
				},
			},
			global: {
				stubs: {
					Icon: true,
					XButton: {template: '<button><slot /></button>'},
				},
			},
		})
		const rows = wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))
		expect(wrapper.get('.review-target strong').text()).toBe('agent.tools.check_in_task_routine')
		expect(rows).toEqual([
			['#12 Water the plants', 'agent.fields.routine_date', '2026-11-01', '2026-11-01'],
			['#12 Water the plants', 'agent.fields.routine_completed', 'false', 'true'],
		])
	})
})

describe('calendar routine and repeat return review', () => {
	function changes(tool: string, before: object, args: object) {
		return shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({tool, before: JSON.stringify([before]), arguments: JSON.stringify(args)}),
			},
			global: {stubs},
		})
	}

	it('compares calendar and quota values against the routine snapshot and hides revision', () => {
		const wrapper = changes('configure_task_routine', {
			id: 12,
			title: 'Practice',
			routine: {
				period: 'daily',
				reset_hour: 0,
				reset_minute: 0,
				week_start: 0,
				month_day: 1,
				target: 1,
				unit: '',
			},
		}, {
			id: 12,
			period: 'weekly',
			reset_hour: 4,
			reset_minute: 30,
			week_start: 1,
			month_day: 1,
			target: 5,
			unit: 'sessions',
			revision: 7,
		})
		expect(wrapper.get('.review-target strong').text()).toBe('agent.tools.configure_task_routine')
		const rows = wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))
		expect(rows).toContainEqual([
			'#12 Practice', 'agent.fields.routine_period', 'routineSchedule.daily', 'routineSchedule.weekly',
		])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_target', '1', '5'])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_reset_hour', '0', '4'])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_reset_minute', '0', '30'])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_week_start', 'Sunday', 'Monday'])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_month_day', '1', '1'])
		expect(rows).toContainEqual(['#12 Practice', 'agent.fields.routine_unit', 'agent.routineReview.noUnit', 'sessions'])
		expect(rows).toHaveLength(7)
		expect(rows.flat()).not.toContain('agent.fields.revision')
	})

	it('shows absolute progress from the current period and excludes its revision token', () => {
		const wrapper = changes('set_task_routine_progress', {
			id: 12,
			title: 'Practice',
			routine: {date: '2026-11-02', current_amount: 2},
		}, {id: 12, date: '2026-11-02', amount: 4, revision: 7})
		expect(wrapper.get('.review-target strong').text()).toBe('agent.tools.set_task_routine_progress')
		expect(wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))).toEqual([
			['#12 Practice', 'agent.fields.routine_date', '2026-11-02', '2026-11-02'],
			['#12 Practice', 'agent.fields.routine_amount', '2', '4'],
		])
		expect(wrapper.text()).toContain('agent.routineReview.absoluteProgress')
	})

	it('names the repeat return policy and target without pretending the task moves immediately', () => {
		const wrapper = changes('set_task_repeat_bucket', {
			task_id: 12,
			project_id: 1,
			view_id: 4,
			repeat_return_mode: 'default',
			repeat_return_bucket_id: 0,
		}, {
			project_id: 1,
			view_id: 4,
			task_id: 12,
			repeat_return_mode: 'bucket',
			repeat_return_bucket_id: 9,
		})
		expect(wrapper.get('.review-target strong').text()).toBe('agent.tools.set_task_repeat_bucket')
		expect(wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))).toEqual([
			['#12', 'agent.fields.repeat_return_mode', 'agent.repeatPolicy.default', 'agent.repeatPolicy.bucket'],
			['#12', 'agent.fields.repeat_return_bucket_id', 'agent.repeatPolicy.noBucket', 'agent.repeatPolicy.bucketId(id=9)'],
		])
		expect(wrapper.text()).toContain('agent.repeatPolicy.futureOnly')
	})
})

const stubs = {
	Icon: true,
	XButton: {template: '<button><slot /></button>'},
}

function reviewTurn(pending: Operation): ChatTurn {
	return {
		id: 'turn-bucket',
		result: {
			pause: 'review',
			pending: {id: 'operation-bucket', units: 1, ...pending},
		},
	}
}

describe('budget pause', () => {
	it('continues a long auto-continued turn: there is no cumulative 200-round or 1000-operation ceiling', async () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: {
					id: 'turn-3',
					result: {
						pause: 'budget',
						budget: {rounds: 230, round_limit: 230, operations: 1200, operation_limit: 1200},
					},
				},
			},
			global: {stubs},
		})
		const button = wrapper.find('button')
		expect(button.attributes('disabled')).toBeUndefined()
		expect(wrapper.text()).not.toContain('agent.overallLimit')
		await button.trigger('click')
		expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({turn_id: 'turn-3', decision: 'continue'})
	})
})

describe('bucket review', () => {
	function impactTexts(section: DOMWrapper<Element>): Record<string, string> {
		return Object.fromEntries(section.findAll('li[data-impact]')
			.map(item => [item.attributes('data-impact') ?? '', item.text()]))
	}

	it('explains a bucket delete: where its tasks go, that none is deleted, and what the board loses', () => {
		const wrapper = mount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'delete_bucket',
					arguments: '{"project_id":1,"view_id":4,"bucket_id":12}',
					before: JSON.stringify([{
						id: 12,
						title: 'Backlog',
						bucket_id: 12,
						view_id: 4,
						project_id: 1,
						limit: 0,
						is_default_bucket: true,
						is_done_bucket: false,
						tasks_moved: 12,
						done_tasks_moved: 2,
						tasks_deleted: 0,
						move_to_bucket_id: 13,
						move_to_bucket_title: 'To do',
						clears: ['default_bucket_id'],
						task_done_state: 'unchanged',
						sample_tasks: [
							{id: 3, title: 'Write the brief', done: false},
							{id: 5, title: 'Ship it', done: true},
						],
						hidden_sample_tasks: 1,
					}]),
					after: JSON.stringify({
						deleted_bucket_id: 12,
						tasks_moved: 12,
						move_to_bucket_id: 13,
						default_bucket_id: 0,
						done_bucket_id: 9,
						tasks_deleted: 0,
					}),
				}),
			},
			global: {stubs},
		})
		const section = wrapper.find('section.bucket-impact')
		expect(section.findAll('li[data-impact]').map(item => item.attributes('data-impact'))).toEqual([
			'bucket',
			'tasks-moved',
			'tasks-deleted',
			'done-tasks',
			'default-bucket',
			'samples',
		])
		const impacts = impactTexts(section)
		expect(impacts.bucket).toBe('agent.bucketImpact.deleteBucket(bucket=agent.bucketImpact.quoted(title=Backlog))')
		expect(impacts['tasks-moved'])
			.toBe('agent.bucketImpact.tasksMoved(count=12, bucket=agent.bucketImpact.quoted(title=To do))')
		expect(impacts['tasks-deleted']).toBe('agent.bucketImpact.noTasksDeleted')
		expect(impacts['done-tasks']).toBe('agent.bucketImpact.doneTasks(count=2)')
		expect(impacts['default-bucket']).toBe('agent.bucketImpact.deleteDefault')
		expect(section.findAll('li[data-impact="samples"] li').map(item => item.text()))
			.toEqual(['Write the brief', 'Ship it · agent.bucketImpact.sampleDone'])
		// 12 tasks move: 2 are listed, 1 sits in a project the user cannot read, 9 are beyond the sample.
		expect(impacts.samples).toContain('agent.bucketImpact.samplesHidden(count=1)')
		expect(impacts.samples).toContain('agent.bucketImpact.samplesMore(count=9)')
		expect(wrapper.find('.destructive-warning').text()).toBe('agent.bucketImpact.deleteWarning')
		expect(wrapper.find('table').exists()).toBe(false)
		expect(wrapper.text()).toContain('agent.exactArguments')
		expect(wrapper.text()).toContain('agent.bucketImpact.afterSnapshot')
	})

	it('warns that a lower limit keeps existing tasks and never lists locators as changes', () => {
		const wrapper = mount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'update_bucket',
					arguments: '{"project_id":1,"view_id":4,"bucket_id":8,"limit":3}',
					before: '[{"id":8,"bucket_id":8,"title":"Doing","limit":0,"after_bucket_id":7,"project_id":1,"view_id":4}]',
					after: JSON.stringify({
						title: 'Doing',
						limit: 3,
						after_bucket_id: 7,
						after_bucket_title: 'To do',
						task_count: 5,
						warning: 'limit_below_task_count: existing tasks stay; only new moves into this bucket are refused.',
					}),
				}),
			},
			global: {stubs},
		})
		expect(impactTexts(wrapper.find('section.bucket-impact'))).toEqual({
			'bucket': 'agent.bucketImpact.updateBucket(bucket=agent.bucketImpact.quoted(title=Doing))',
			'update': 'agent.bucketImpact.limitChange(from=agent.bucketImpact.limitNone, to=agent.bucketImpact.limitValue(limit=3))',
			'warning': 'agent.bucketImpact.limitBelowCount(count=5, limit=3)',
		})
		expect(wrapper.find('.destructive-warning').exists()).toBe(false)
		expect(wrapper.find('table').exists()).toBe(false)
	})

	it('falls back to the field table without locators when the server sent no impact', () => {
		const wrapper = mount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'update_bucket',
					arguments: '{"project_id":1,"view_id":4,"bucket_id":8,"limit":3}',
					before: '[{"id":8,"bucket_id":8,"title":"Doing","limit":0,"after_bucket_id":7,"project_id":1,"view_id":4}]',
				}),
			},
			global: {stubs},
		})
		expect(wrapper.find('section.bucket-impact').exists()).toBe(false)
		const rows = wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))
		expect(rows).toEqual([['#8 Doing', 'agent.fields.limit', '0', '3']])
	})

	it('says where a moved task ends up and that the done bucket completes it', () => {
		const effects = ['marks_task_done', 'also_moves_into_done_bucket_of_other_views']
		const wrapper = mount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'move_task_to_bucket',
					arguments: '{"project_id":-2,"view_id":9,"bucket_id":31,"task_id":3}',
					before: JSON.stringify([{
						id: 3,
						title: 'Card',
						task_id: 3,
						project_id: -2,
						view_id: 9,
						bucket_id: 30,
						bucket_title: 'Open',
						target_bucket_title: 'Done',
						done: false,
						repeating: false,
						task_project_id: 1,
						effects,
					}]),
					after: JSON.stringify({
						bucket_id: 31,
						bucket_title: 'Done',
						done: true,
						effects,
						done_views: [{view_id: 5, done_bucket_id: 22}],
					}),
				}),
			},
			global: {stubs},
		})
		const impacts = impactTexts(wrapper.find('section.bucket-impact'))
		expect(Object.keys(impacts)).toEqual(['move', 'done-state'])
		expect(impacts.move).toBe('agent.bucketImpact.move(task=agent.bucketImpact.quoted(title=Card), '
			+ 'from=agent.bucketImpact.quoted(title=Open), to=agent.bucketImpact.quoted(title=Done))')
		expect(impacts['done-state']).toContain('agent.bucketImpact.becomesDone')
		expect(impacts['done-state']).toContain('agent.bucketImpact.otherDoneBuckets(count=1)')
		expect(wrapper.find('table').exists()).toBe(false)
	})
})


describe('external MCP and private chat image review', () => {
	it('uses persisted external source and destructive policy without presenting remote rows as Vikunja tasks', () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'call_mcp_tool',
					arguments: '{"server_id":"remote","tool_name":"delete_task","arguments":{"id":12}}',
					before: '[{"id":12,"title":"Remote record"}]',
					external: {
						server_id: 'remote',
						server_name: 'Wallos fixture',
						tool: 'delete_task',
						destructive: true,
					},
				}),
			},
			global: {stubs},
		})
		expect(wrapper.get('.review-external').text()).toContain('Wallos fixture')
		expect(wrapper.get('.review-external code').text()).toBe('delete_task')
		expect(wrapper.classes()).toContain('is-destructive')
		expect(wrapper.find('.change-table').exists()).toBe(false)
		expect(wrapper.text()).toContain('tcy.mcp.externalReview')
	})

	it.each([
		['insert_chat_image', 'tcy.chatImages.shareHint'],
		['update_task_description_image', 'tcy.chatImages.updateHint'],
		['remove_task_description_image', 'tcy.chatImages.removeHint'],
	])('explains the precise sharing or removal effect of %s', (tool, hint) => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({tool}),
			},
			global: {stubs},
		})
		expect(wrapper.text()).toContain(hint)
	})
	it('shows image placement and text changes without exposing concurrency hashes as change fields', () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'update_task_description_image',
					arguments: JSON.stringify({
						id: 12,
						image_index: 0,
						position: 'after',
						block_index: 2,
						alt: '',
						description_version: 'fixture-description-hash',
						image_hash: 'fixture-image-hash',
					}),
				}),
			},
			global: {stubs},
		})
		const summary = wrapper.get('.review-external')
		expect(summary.text()).toContain('tcy.chatImages.after')
		expect(summary.text()).toContain('tcy.chatImages.emptyText')
		expect(summary.text()).not.toContain('fixture-description-hash')
		expect(summary.text()).not.toContain('fixture-image-hash')
	})

	it('submits external arguments unchanged after opening the editor, preserving large integers and decimal spelling', async () => {
		const raw = '{"server_id":"remote","tool_name":"update_fixture","arguments":{"id":9007199254740993,"amount":1.2300,"small":1e-8}}'
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'call_mcp_tool',
					arguments: raw,
					external: {
						server_id: 'remote',
						server_name: 'External fixture',
						tool: 'update_fixture',
					},
				}),
			},
			global: {stubs},
		})
		await wrapper.findAll('button').find(button => button.text() === 'agent.edit')!.trigger('click')
		await wrapper.findAll('button').find(button => button.text() === 'agent.updatePreview')!.trigger('click')
		expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({
			decision: 'edit',
			arguments: raw,
		})
		expect(wrapper.get('textarea.argument-editor').element).toHaveProperty('value', raw)
		expect(wrapper.findAll('pre').some(pre => pre.text() === raw)).toBe(true)
	})

})

it('previews view-order changes as named sequences and boundaries without presenting a version token as a change', async () => {
	const input = {
		project_id: 1,
		view_id: 4,
		bucket_id: 8,
		task_ids: [3, 1],
		after_task_id: 7,
		before_task_id: 9,
		order_version: 'a'.repeat(64),
	}
	const wrapper = mount(AgentReviewCard, {
		props: {
			busy: false,
			turn: {
				id: 'order-turn',
				result: {
					pause: 'review',
					pending: {
						id: 'order-operation',
						tool: 'reorder_view_tasks',
						arguments: JSON.stringify(input),
						before: JSON.stringify({
							...input,
							items: [
								{id: 1, title: 'First fixture', position: 100},
								{id: 3, title: 'Third fixture', position: 300},
							],
						}),
						after: JSON.stringify(input),
					},
				},
			},
		},
		global: {
			stubs: {
				Icon: true,
				XButton: {template: '<button><slot /></button>'},
			},
		},
	})
	const preview = wrapper.get('.task-order-preview')
	expect(preview.findAll('ol')[0].findAll('li').map(item => item.text())).toEqual(['#1 First fixture', '#3 Third fixture'])
	expect(preview.findAll('ol')[1].findAll('li').map(item => item.text())).toEqual(['#3 Third fixture', '#1 First fixture'])
	expect(preview.text()).toContain('agent.taskOrder.afterTask(task=agent.taskOrder.taskId(id=7))')
	expect(preview.text()).toContain('agent.taskOrder.beforeTask(task=agent.taskOrder.taskId(id=9))')
	expect(preview.text()).not.toContain(input.order_version)
	expect(wrapper.find('.change-table').exists()).toBe(false)
	await wrapper.findAll('button').find(button => button.text() === 'agent.approve')!.trigger('click')
	expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({
		turn_id: 'order-turn',
		operation_id: 'order-operation',
		decision: 'approve',
	})
	wrapper.unmount()
})


describe('Compass write review', () => {
	it('shows a new entry parent without comparing its text to the space snapshot', () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'create_compass_entry',
					before: JSON.stringify([{id: 7, title: 'Parent sky', revision: 3}]),
					arguments: JSON.stringify({space_id: 7, title: 'New principle', content: '<p>Remember</p>'}),
				}),
			},
			global: {stubs},
		})
		expect(wrapper.get('.review-target strong').text()).toBe('agent.tools.create_compass_entry')
		expect(wrapper.get('.review-compass').text()).toContain('agent.compassReview.space#7')
		expect(wrapper.find('table').exists()).toBe(false)
		expect(wrapper.text()).toContain('New principle')
		expect(wrapper.text()).toContain('Parent sky')
		expect(wrapper.text()).toContain('agent.compassReview.hint')
	})

	it('distinguishes historical source revision from the current concurrency revision', async () => {
		const wrapper = shallowMount(AgentReviewCard, {
			props: {
				busy: false,
				turn: reviewTurn({
					tool: 'restore_compass_revision',
					before: JSON.stringify([{id: 41, space_id: 7, title: 'Current entry', revision: 5}]),
					arguments: JSON.stringify({id: 41, revision: 2, expected_revision: 5}),
				}),
			},
			global: {stubs},
		})
		const fields = wrapper.get('.review-compass').text()
		expect(fields).toContain('agent.compassReview.entry#41')
		expect(fields).toContain('agent.compassReview.sourceRevision2')
		expect(fields).toContain('agent.compassReview.expectedRevision5')
		expect(wrapper.text()).toContain('agent.compassReview.restoreHint')
		expect(wrapper.find('.is-destructive').exists()).toBe(false)
		await wrapper.findAll('button').find(button => button.text() === 'agent.approve')!.trigger('click')
		expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({
			operation_id: 'operation-bucket',
			decision: 'approve',
		})
	})
})

describe('personal Notes review', () => {
	it('shows the exact note and CAS revision without inventing a blank old article', () => {
		const wrapper = shallowMount(AgentReviewCard, {props: {busy: false, turn: reviewTurn({
			tool: 'update_note',
			before: JSON.stringify([{id: 3, title: 'Before', revision: 4, content_bytes: 400, segment_count: 2}]),
			arguments: JSON.stringify({id: 3, expected_revision: 4, append_content: '\n\nNew conclusion', pinned: true}),
		})}, global: {stubs}})
		const fields = wrapper.get('.review-note').text()
		expect(fields).toContain('agent.noteReview.note#3')
		expect(fields).toContain('agent.noteReview.expectedRevision4')
		expect(wrapper.get('.review-note').findAll('dt').map(field => field.text())).toContain('agent.noteReview.appendContent')
		expect(wrapper.get('.review-note').findAll('dd').map(field => field.text())).toContain('New conclusion')
		expect(wrapper.find('table').exists()).toBe(false)
		expect(wrapper.text()).toContain('agent.noteReview.hint')
	})
	it('warns that deletion also permanently removes the raw transcript and preserves approval identity', async () => {
		const wrapper = shallowMount(AgentReviewCard, {props: {busy: false, turn: reviewTurn({
			tool: 'delete_note', before: JSON.stringify([{id: 3, title: 'Recording', segment_count: 17}]),
			arguments: JSON.stringify({id: 3, expected_revision: 4}),
		})}, global: {stubs}})
		expect(wrapper.classes()).toContain('is-destructive')
		expect(wrapper.get('.review-note').text()).toContain('agent.noteReview.segments17')
		expect(wrapper.get('.destructive-warning').text()).toContain('agent.noteReview.deleteWarning')
		await wrapper.findAll('button').find(button => button.text() === 'agent.approve')!.trigger('click')
		expect(wrapper.emitted('review')?.[0]?.[0]).toMatchObject({operation_id: 'operation-bucket', decision: 'approve'})
	})
	it('does not present an external tool with the same name as native note access', () => {
		const wrapper = shallowMount(AgentReviewCard, {props: {busy: false, turn: reviewTurn({
			tool: 'update_note', arguments: '{"id":3,"expected_revision":2}',
			external: {server_id: 'outside', tool: 'update_note'},
		})}, global: {stubs}})
		expect(wrapper.find('.review-note').exists()).toBe(false)
		expect(wrapper.text()).toContain('tcy.mcp.externalReview')
		expect(wrapper.text()).not.toContain('agent.noteReview.hint')
	})
})
