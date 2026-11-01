<script setup lang="ts">
import {computed, watch, watchEffect} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useQuery} from '@tanstack/vue-query'

import {useBaseStore} from '@/stores/base'
import {useAuthStore} from '@/stores/auth'

import {saveProjectView} from '@/helpers/projectView'
import {projectQuery} from '@/client/queries/projects'
import {isRequestContextAbort} from '@/client/requestContext'
import LoadError from '@/components/misc/state/LoadError.vue'

import ProjectList from '@/components/project/views/ProjectList.vue'
import ProjectGantt from '@/components/project/views/ProjectGantt.vue'
import ProjectTable from '@/components/project/views/ProjectTable.vue'
import ProjectKanban from '@/components/project/views/ProjectKanban.vue'

import {DEFAULT_PROJECT_VIEW_SETTINGS} from '@/constants/projectView'
import {saveProjectToHistory} from '@/modules/projectHistory'

const props = defineProps<{
	projectId: number,
	viewId: number,
}>()

const router = useRouter()
const route = useRoute()
const baseStore = useBaseStore()
const authStore = useAuthStore()
// The page shows a failed load itself instead of staying blank.
const project = useQuery(computed(() => ({...projectQuery(props.projectId), meta: {handlesError: true}})))
const currentProject = computed(() => project.data.value)

const currentView = computed(() => {
	return currentProject.value?.views.find(v => v.id === props.viewId)
})

const isLoadingProject = project.isPending
const loadFailed = computed(() => project.isError.value && !currentProject.value && !isRequestContextAbort(project.error.value))
const projectMissing = computed(() => {
	const status = (project.error.value as {status?: number} | null)?.status
	return status === 403 || status === 404
})

watch(
	() => [currentProject.value, props.viewId, route.name, route.params.projectId] as const,
	([newCurrentProject, newViewId, routeName, projectId]) => {
		// A cached project view may receive query updates while a global page is active.
		if (routeName !== 'project.view' || Number(projectId) !== props.projectId) return
		if (!newCurrentProject) {
			baseStore.setCurrentProject(null)
			return
		}
		
		baseStore.setCurrentProject(newCurrentProject, newViewId)
	}, {
		deep: true,
		immediate: true,
	},
)

function redirectToDefaultViewIfNecessary() {
	if (props.viewId === 0 || !currentView.value) {
		// Ideally, we would do that in the router redirect, but the projects (and therefore, the views) 
		// are not always loaded then.

		const defaultView  = authStore.settings.frontend_settings.default_view
		const views = currentProject.value?.views ?? []

		let view
		if (defaultView !== DEFAULT_PROJECT_VIEW_SETTINGS.FIRST) {
			view = views.find(view => view.view_kind === defaultView)
		}

		// Use the first view as fallback if the default view is not available
		if (view === undefined && views.length > 0) {
			view = views[0]
		}

		if (view) {
			router.replace({
				name: 'project.view',
				params: {
					projectId: props.projectId,
					viewId: view.id,
				},
			})
		}
	}
}

watch(
	() => props.viewId,
	redirectToDefaultViewIfNecessary,
	{immediate: true},
)

watch(
	currentProject,
	redirectToDefaultViewIfNecessary,
)

watchEffect(() => {
	// Don't save to history if the user is not authenticated (e.g., during logout)
	if (authStore.authenticated) {
		saveProjectToHistory({id: props.projectId})
	}
})
watchEffect(() => saveProjectView(props.projectId, props.viewId))
</script>

<template>
	<div
		v-if="loadFailed"
		class="project-load-state"
	>
		<LoadError
			:message="projectMissing ? $t('project.loadError.missing') : $t('project.loadError.failed')"
			:retry="projectMissing ? undefined : () => project.refetch()"
		/>
		<RouterLink
			:to="{name: 'projects.index'}"
			class="project-load-state__link"
		>
			{{ $t('project.loadError.toProjects') }}
		</RouterLink>
	</div>
	<div
		v-else-if="isLoadingProject && !currentProject"
		class="project-load-state loader-container is-loading"
		aria-busy="true"
	/>
	<!-- The completion notice lives in ProjectWrapper's banner region, below the view toolbar. -->
	<ProjectList
		v-if="currentView?.view_kind === 'list'"
		:project-id="projectId"
		:is-loading-project="isLoadingProject"
		:view-id
	/>
	<ProjectGantt
		v-if="currentView?.view_kind === 'gantt'"
		:project-id="projectId"
		:route
		:is-loading-project="isLoadingProject"
		:view-id
	/>
	<ProjectTable
		v-if="currentView?.view_kind === 'table'"
		:project-id="projectId"
		:is-loading-project="isLoadingProject"
		:view-id
	/>
	<ProjectKanban
		v-if="currentView?.view_kind === 'kanban'"
		:project-id="projectId"
		:is-loading-project="isLoadingProject"
		:view-id
	/>
</template>

<style lang="scss" scoped>
.project-load-state {
	display: grid;
	gap: var(--space-3);
	justify-items: start;
	max-inline-size: 40rem;
	min-block-size: 10rem;
	margin: var(--space-5) auto;
	padding-inline: var(--space-4);
}
</style>
