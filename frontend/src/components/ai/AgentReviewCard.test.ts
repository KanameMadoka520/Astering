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
	it('compares the requested check-in with today\'s recorded state under a routine label', () => {
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
		expect(rows).toEqual([
			['#12 Water the plants', 'agent.fields.date', '2026-11-01', '2026-11-01'],
			['#12 Water the plants', 'agent.fields.routine_completed', 'false', 'true'],
		])
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
