import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, nextTick, type PropType} from 'vue'
import {enableAutoUnmount, mount} from '@vue/test-utils'

vi.mock('@/composables/useProjects', () => ({useProjects: () => ({getChildProjects: () => []})}))
vi.mock('@/client/queries/projects', () => {
	const never = () => new Promise(() => undefined)
	return {
		getSavedFilterIdFromProjectId: (id: number) => -id - 1,
		isSavedFilterProject: () => false,
		usePatchProjectFavoriteMutation: () => ({mutateAsync: vi.fn()}),
		projectQuery: (id: number) => ({
			queryKey: ['projects', 'detail', id],
			queryFn: never,
		}),
		projectsQuery: () => ({
			queryKey: ['projects', 'list'],
			queryFn: never,
		}),
	}
})
vi.mock('@/client/queries/savedFilters', () => ({usePatchSavedFilterFavoriteMutation: () => ({mutateAsync: vi.fn()})}))
vi.mock('@/stores/base', async () => {
	const {reactive, ref} = await import('vue')
	// A ref inside, as in a Pinia store, so storeToRefs finds it too.
	const base = reactive({currentProjectId: ref(0)})
	return {useBaseStore: () => base}
})

import {queryClient} from '@/client/queryClient'
import type {ProjectResponse} from '@/client/queries/projects'
import {useBaseStore} from '@/stores/base'
import type {TaskResponse} from '@/client/queries/tasks'
import {useTaskDragState} from '@/composables/useTaskDragState'
import ProjectsNavigationItem from './ProjectsNavigationItem.vue'

enableAutoUnmount(afterEach)

const PROJECTS = Array.from({length: 40}, (_, index) => ({
	id: index + 1,
	title: `Project ${index + 1}`,
	hex_color: '',
	max_permission: 1,
}) as ProjectResponse)

const Sidebar = defineComponent({
	props: {projects: {type: Array as PropType<ProjectResponse[]>, required: true}},
	setup: props => () => h('ul', props.projects.map(project => h(ProjectsNavigationItem, {
		key: project.id,
		project,
	}))),
})

describe('ProjectsNavigationItem', () => {
	const elementsFromPoint = document.elementsFromPoint
	afterEach(() => {
		useTaskDragState().setDraggedTask(null)
		document.elementsFromPoint = elementsFromPoint
		queryClient.clear()
		useBaseStore().currentProjectId = 0
	})
	function mountSidebar() {
		return mount(Sidebar, {
			props: {projects: PROJECTS},
			attachTo: document.body,
			global: {
				stubs: {
					ProjectSettingsDropdown: true,
					ProjectsNavigation: true,
					Icon: true,
				},
				mocks: {$t: (key: string) => key},
			},
		})
	}

	it('marks the current project without a project query per row', async () => {
		const wrapper = mountSidebar()
		useBaseStore().currentProjectId = 7
		await nextTick()

		expect(wrapper.findAll('.navigation-item.is-current')).toHaveLength(1)
		expect(wrapper.find('li[data-project-id="7"] .navigation-item').classes()).toContain('is-current')
		const observers = queryClient.getQueryCache().getAll().reduce((sum, query) => sum + query.getObserversCount(), 0)
		expect(observers).toBe(0)
	})

	it('hit-tests the pointer once per move for the whole sidebar and marks the row under it', async () => {
		const wrapper = mountSidebar()
		const row = (id: number) => wrapper.find(`li[data-project-id="${id}"]`)
		// happy-dom does no layout: the pointer is over the title of project 7.
		const hitTest = vi.fn(() => [row(7).find('.project-menu-title').element])
		document.elementsFromPoint = hitTest

		useTaskDragState().setDraggedTask({id: 99, project_id: 1} as TaskResponse)
		await nextTick()
		document.dispatchEvent(new MouseEvent('mousemove', {
			clientX: 20,
			clientY: 140,
		}))
		await nextTick()

		expect(hitTest).toHaveBeenCalledTimes(1)
		expect(wrapper.findAll('li.is-drop-target').map(li => li.attributes('data-project-id'))).toEqual(['7'])

		useTaskDragState().setDraggedTask(null)
		await nextTick()
		document.dispatchEvent(new MouseEvent('mousemove', {
			clientX: 20,
			clientY: 140,
		}))
		expect(hitTest).toHaveBeenCalledTimes(1)
		expect(wrapper.findAll('li.is-drop-target')).toHaveLength(0)
	})
})
