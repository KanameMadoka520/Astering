<template>
	<Modal
		danger
		:loading="isDeleting"
		:confirm-label="$t('misc.delete')"
		@close="goBack()"
		@submit="deleteProject()"
	>
		<template #header>
			<span>{{ target ? $t('project.delete.confirmHeader', {project: target.title}) : $t('project.delete.header') }}</span>
		</template>

		<template #text>
			<p>
				{{ $t('project.delete.text1') }}
			</p>

			<p
				v-if="countStatus === 'success'"
				class="has-text-weight-bold"
			>
				{{ deleteNotice }}
			</p>
			<LoadError
				v-else-if="countStatus === 'error'"
				:message="$t('project.delete.countError', {count: projectIds.length}, projectIds.length)"
				:retry="retryCounts"
			/>
			<Loading
				v-else
				class="is-loading-small"
				variant="default"
			/>

			<p>
				{{ $t('project.delete.collaborators', projectIds.length) }}
			</p>
			<p>
				{{ $t('misc.cannotBeUndone') }}
			</p>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useQueries} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter} from 'vue-router'

import {useDeleteProjectMutation} from '@/client/queries/projects'
import {tasksQuery} from '@/client/queries/tasks'
import Loading from '@/components/misc/Loading.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {combineStatus, queryStatus} from '@/components/sharing/useProjectAccess'
import {useGoBack} from '@/composables/useGoBack'
import {useIsAlive} from '@/composables/useIsAlive'
import {useProjects} from '@/composables/useProjects'
import {useTitle} from '@/composables/useTitle'
import {descendantProjects} from '@/helpers/projectAccess'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'

const {t} = useI18n({useScope: 'global'})
const projectList = useProjects()
const deleteMutation = useDeleteProjectMutation()
const route = useRoute()
const router = useRouter()
const goBack = useGoBack()
const alive = useIsAlive()

const projectId = computed(() => Number(route.params.projectId))
const project = computed(() => projectList.projects[projectId.value])

// What gets deleted is fixed once the project is known: the delete removes the project and everything inside it
// from the list as soon as it starts, which would otherwise blank the title and shrink the count mid-request.
const target = ref<{
	id: number,
	title: string,
	ids: number[],
	request: ClientRequestContext,
} | null>(null)
watch(projectId, () => { target.value = null }, {flush: 'sync'})
watch([project, () => projectList.projectsArray], ([current]) => {
	if (current && target.value?.id !== current.id) {
		target.value = {
			id: current.id,
			title: current.title,
			request: captureClientRequestContext(),
			// The server deletes every level below, not just the direct children.
			ids: [current.id, ...descendantProjects(projectList.projectsArray, current.id).map(child => child.id)],
		}
	}
}, {immediate: true})
const projectIds = computed(() => target.value?.ids ?? [])

useTitle(() => t('project.delete.title', {project: target.value?.title ?? project.value?.title}))

// Each project is counted on its own endpoint: the cross-project task list leaves out archived projects.
const counts = useQueries({queries: computed(() => projectIds.value.map(id => ({
	...tasksQuery({project: id, params: {per_page: 1}}),
	meta: {handlesError: true},
})))})
const countStatus = computed(() => projectIds.value.length === 0
	? 'pending'
	: combineStatus(counts.value.map(count => queryStatus(count.data, count.isError))))
const totalTasks = computed(() => counts.value.reduce((sum, count) => sum + (count.data?.total ?? 0), 0))

function retryCounts() {
	for (const count of counts.value) {
		if (count.isError) count.refetch()
	}
}

const deleteNotice = computed(() => {
	const projects = projectIds.value.length
	if (totalTasks.value > 0) {
		return projects <= 1
			? t('project.delete.tasksToDelete', {count: totalTasks.value})
			: t('project.delete.tasksAndChildProjectsToDelete', {tasks: totalTasks.value, projects})
	}
	return projects <= 1
		? t('project.delete.noTasksToDelete')
		: t('project.delete.noTasksInProjects', {count: projects})
})

const isDeleting = ref(false)

async function deleteProject() {
	const confirmation = target.value
	const id = confirmation?.id
	if (!confirmation || !id || id !== projectId.value || isDeleting.value) {
		return
	}
	if (!isClientRequestContextCurrent(confirmation.request)) {
		target.value = null
		goBack()
		return
	}
	const origin = router.currentRoute.value
	isDeleting.value = true
	try {
		await deleteMutation.mutateAsync(id)
	} catch {
		// The toast says what went wrong; the dialog stays open to retry or cancel.
		return
	} finally {
		isDeleting.value = false
	}
	if (alive.value && target.value === confirmation && projectId.value === id && router.currentRoute.value === origin
		&& isClientRequestContextCurrent(confirmation.request)) {
		await router.push({name: 'home'})
	}
}
</script>
