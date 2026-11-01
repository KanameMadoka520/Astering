<template>
	<Modal
		:loading="isSaving"
		:confirm-label="archiving ? $t('menu.archive') : $t('project.archive.unarchiveConfirm')"
		@close="goBack()"
		@submit="archiveProject()"
	>
		<template #header>
			<span>{{ archiving ? $t('project.archive.archive') : $t('project.archive.unarchive') }}</span>
		</template>

		<template #text>
			<p>{{ archiving ? $t('project.archive.archiveText') : $t('project.archive.unarchiveText') }}</p>
			<!-- The server applies the change to every project inside this one, including ones archived on their own. -->
			<p v-if="descendants.length > 0">
				{{ archiving
					? $t('project.archive.archiveChildren', {count: descendants.length}, descendants.length)
					: $t('project.archive.unarchiveChildren', {count: descendants.length}, descendants.length) }}
			</p>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'

import {useUpdateProjectMutation} from '@/client/queries/projects'
import {useTitle} from '@/composables/useTitle'
import {useGoBack} from '@/composables/useGoBack'
import {useIsAlive} from '@/composables/useIsAlive'
import {descendantProjects} from '@/helpers/projectAccess'

import {useBaseStore} from '@/stores/base'
import {useProjects} from '@/composables/useProjects'

defineOptions({name: 'ProjectSettingArchive'})

const {t} = useI18n({useScope: 'global'})
const projectList = useProjects()
const archiveMutation = useUpdateProjectMutation(t('project.archive.success'))
const unarchiveMutation = useUpdateProjectMutation(t('project.archive.unarchiveSuccess'))
const goBack = useGoBack()
const route = useRoute()
const router = useRouter()
const alive = useIsAlive()
// Taken during setup: a store first created after the await could not set itself up.
const baseStore = useBaseStore()

const projectId = computed(() => Number(route.params.projectId))
const project = computed(() => projectList.projects[projectId.value])
useTitle(() => project.value?.title ? t('project.archive.title', {project: project.value.title}) : '')

// The direction is fixed when the project is first seen: the optimistic update flips `is_archived` in the list while
// the request runs, which would otherwise turn the dialog (and a second submit) into the opposite action.
const target = ref<{id: number, archiving: boolean} | null>(null)
watch(project, current => {
	if (current && target.value?.id !== current.id) {
		target.value = {id: current.id, archiving: !current.is_archived}
	}
}, {immediate: true})
const archiving = computed(() => target.value && target.value.id === project.value?.id
	? target.value.archiving
	: !project.value?.is_archived)

const descendants = computed(() => project.value ? descendantProjects(projectList.projectsArray, project.value.id) : [])

const isSaving = ref(false)

async function archiveProject() {
	const current = project.value
	if (!current || isSaving.value) {
		return
	}
	const isArchiving = archiving.value
	const origin = router.currentRoute.value
	const isCurrentRequest = () => alive.value && projectId.value === current.id && router.currentRoute.value === origin
	isSaving.value = true
	try {
		const updated = await (isArchiving ? archiveMutation : unarchiveMutation).mutateAsync({
			...current,
			is_archived: isArchiving,
		})
		if (isCurrentRequest()) baseStore.setCurrentProject(updated)
	} catch {
		// The toast says what went wrong; the dialog stays open to retry or cancel.
		return
	} finally {
		isSaving.value = false
	}
	if (isCurrentRequest()) {
		goBack()
	}
}
</script>
