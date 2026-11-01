<template>
	<CreateEdit
		:title="$t('project.share.header')"
		:has-primary-action="false"
	>
		<LoadError
			v-if="!project && isError"
			:message="$t('project.share.loadError')"
			:retry="() => refetch()"
		/>
		<p
			v-else-if="!project"
			class="share-loading"
			role="status"
		>
			{{ $t('misc.loading') }}
		</p>
		<template v-else>
			<ProjectAccessSummary
				:project="project"
				:user-is-admin="userIsAdmin"
			/>
			<UserSharing
				:project="project"
				:user-is-admin="userIsAdmin"
			/>
			<TeamSharing
				:project="project"
				:user-is-admin="userIsAdmin"
			/>
			<LinkSharing
				v-if="configStore.link_sharing_enabled && userIsAdmin"
				:project="project"
				:has-subprojects="hasSubprojects"
				class="mbs-4"
			/>
		</template>
	</CreateEdit>
</template>


<script lang="ts" setup>
import {computed, watchEffect} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useRoute} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useTitle} from '@vueuse/core'

import {PERMISSIONS} from '@/constants/permissions'

import CreateEdit from '@/components/misc/CreateEdit.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import LinkSharing from '@/components/sharing/LinkSharing.vue'
import ProjectAccessSummary from '@/components/sharing/ProjectAccessSummary.vue'
import TeamSharing from '@/components/sharing/TeamSharing.vue'
import UserSharing from '@/components/sharing/UserSharing.vue'

import {useBaseStore} from '@/stores/base'
import {useConfigStore} from '@/stores/config'
import {projectQuery} from '@/client/queries/projects'
import {useProjects} from '@/composables/useProjects'

defineOptions({name: 'ProjectSettingShare'})

const {t} = useI18n({useScope: 'global'})

const route = useRoute()
const projectId = computed(() => Number(route.params.projectId))
// The page shows its own error with Retry, so the global toast is skipped.
const {data: project, isError, refetch} = useQuery(computed(() => ({...projectQuery(projectId.value), enabled: projectId.value > 0, meta: {handlesError: true}})))
const title = computed(() => project.value?.title
	? t('project.share.title', {project: project.value.title})
	: '',
)
useTitle(title)

const configStore = useConfigStore()
const projectList = useProjects()

const userIsAdmin = computed(() => project.value?.max_permission === PERMISSIONS.ADMIN)
const hasSubprojects = computed(() => projectList.projectsArray.some(item => item.parent_project_id === projectId.value))

const baseStore = useBaseStore()
watchEffect(() => {
	if (project.value) baseStore.setCurrentProject(project.value)
})
</script>

<style lang="scss" scoped>
.share-loading {
	color: var(--text-secondary);
}
</style>
