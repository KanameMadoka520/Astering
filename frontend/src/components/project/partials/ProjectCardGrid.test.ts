import {describe, expect, it} from 'vitest'
import {defineComponent, h, onMounted} from 'vue'
import {mount} from '@vue/test-utils'

import type {ProjectResponse} from '@/client/queries/projects'
import ProjectCardGrid from './ProjectCardGrid.vue'

describe('ProjectCardGrid', () => {
	it('keeps the remaining cards when a search hides one before them', async () => {
		let mounts = 0
		// Each real card loads its background and decodes its blurhash when it mounts.
		const ProjectCard = defineComponent({
			props: {project: {type: Object, required: true}},
			setup(props) {
				onMounted(() => { mounts++ })
				return () => h('span', (props.project as ProjectResponse).title)
			},
		})
		const projects = Array.from({length: 10}, (_, index) => ({
			id: index + 1,
			title: `Project ${index + 1}`,
		}) as ProjectResponse)
		const wrapper = mount(ProjectCardGrid, {
			props: {projects},
			global: {stubs: {ProjectCard}},
		})
		expect(mounts).toBe(10)

		await wrapper.setProps({projects: projects.slice(1)})

		expect(wrapper.findAll('li')).toHaveLength(9)
		expect(mounts).toBe(10)
	})
})
