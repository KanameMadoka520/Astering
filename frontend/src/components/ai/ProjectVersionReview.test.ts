import {mount} from '@vue/test-utils'
import {
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import ProjectVersionReview from './ProjectVersionReview.vue'

vi.mock('vue-i18n', () => ({
	useI18n: () => ({
		t: (key: string, values?: Record<string, unknown>) => values
			? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ')})`
			: key,
	}),
}))

function review(before: unknown) {
	return mount(ProjectVersionReview, {
		props: {
			operation: {
				tool: 'restore_project_version',
				arguments: JSON.stringify({
					project_id: 7,
					version_id: 19,
					expected_current_hash: 'a'.repeat(64),
				}),
				before: JSON.stringify(before),
			},
		},
		global: {stubs: {RouterLink: {template: '<a><slot /></a>'}}},
	})
}

describe('project version human review', () => {
	it('shows the authorized project and named checkpoint with actual nonzero content and fact counts', () => {
		const wrapper = review([{
			project_id: 7,
			title: 'Research',
			version_name: 'Before launch',
			target_sequence: 4,
			summary: {
				added_tasks: 2,
				updated_tasks: 3,
				removed_tasks: 1,
			},
			preserved: {
				comments: 5,
				checkins: 6,
				progress: 7,
				time_entries: 8,
				permissions: true,
			},
		}])
		expect(wrapper.text()).toContain('Research · #7')
		expect(wrapper.text()).toContain('Before launch')
		expect(wrapper.text()).toContain('projectVersions.review.checkpoint(version=4)')
		expect(wrapper.text()).toContain('projectVersions.review.impact(added=2, updated=3, removed=1)')
		expect(wrapper.text()).toContain('comments=5, checkins=6, progress=7, timeEntries=8')
		expect(wrapper.text()).not.toContain('expected_current_hash')
	})

	it('does not invent zero impact or reuse another project’s prepared snapshot', () => {
		const wrapper = review([{
			project_id: 8,
			title: 'Wrong project',
			summary: {
				added_tasks: 1,
				updated_tasks: 2,
				removed_tasks: 3,
			},
			preserved: {
				comments: 1,
				checkins: 2,
				progress: 3,
				time_entries: 4,
				permissions: true,
			},
		}])
		expect(wrapper.get('[role="alert"]').text()).toBe('projectVersions.review.unavailable')
		expect(wrapper.text()).not.toContain('Wrong project')
		expect(wrapper.text()).not.toContain('projectVersions.review.impact(')
	})
})
