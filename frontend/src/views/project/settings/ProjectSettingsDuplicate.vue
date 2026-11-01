<template>
	<CreateEdit
		v-model:loading="loadingModel"
		:title="$t('project.duplicate.title')"
		primary-icon="paste"
		:primary-label="$t('project.duplicate.label')"
		:primary-disabled="Boolean(loadError)"
		@primary="duplicate"
	>
		<ErrorMessage v-if="loadError" />
		<template v-else>
			<p>{{ $t('project.duplicate.text') }}</p>
			<ProjectSearch
				v-model="parentProject"
				:filter="canHoldCopy"
			/>
			<ParentAccessNote
				kind="copy"
				:parent="parentProject"
			/>
			<!-- Off by default: copying shares also creates new working public links (D4). -->
			<FancyCheckbox
				v-model="duplicateShares"
				class="mbs-2"
			>
				{{ $t('project.duplicate.shares') }}
			</FancyCheckbox>
			<div class="duplicate-shares-help">
				<p
					v-if="sharesStatus === 'pending'"
					role="status"
				>
					{{ $t('project.duplicate.sharesChecking') }}
				</p>
				<p v-else-if="sharesStatus === 'error'">
					{{ $t('project.duplicate.sharesError') }}
				</p>
				<p v-else>
					{{ sharesSentence }}
				</p>
				<p v-if="!duplicateShares">
					{{ $t('project.duplicate.sharesOff') }}
				</p>
			</div>
		</template>
	</CreateEdit>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'

import CreateEdit from '@/components/misc/CreateEdit.vue'
import ProjectSearch from '@/components/tasks/partials/ProjectSearch.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import ErrorMessage from '@/components/misc/Error.vue'
import ParentAccessNote from '@/components/sharing/ParentAccessNote.vue'
import {combineStatus, queryStatus} from '@/components/sharing/useProjectAccess'

import {useTitle} from '@/composables/useTitle'
import {useProject} from '@/composables/useProject'
import {useProjects} from '@/composables/useProjects'
import {PERMISSIONS} from '@/constants/permissions'
import {linkSharesQuery} from '@/client/queries/linkShares'
import {projectTeamSharesQuery, projectUserSharesQuery} from '@/client/queries/projectShares'
import type {ProjectResponse} from '@/client/queries/projects'
import {useDuplicateProjectMutation} from '@/client/queries/projects'
import {useConfigStore} from '@/stores/config'

const {t} = useI18n({useScope: 'global'})
useTitle(() => t('project.duplicate.title'))

const route = useRoute()
const router = useRouter()
const projectList = useProjects()
const configStore = useConfigStore()

const {project, isLoading, isLoaded, error: loadError} = useProject(() => Number(route.params.projectId))
const duplicateProject = useDuplicateProjectMutation()

const parentProject = ref<ProjectResponse | null>(null)
const duplicateShares = ref(false)
const isDuplicating = ref(false)

const loadingModel = computed({
	get: () => isDuplicating.value || isLoading.value,
	set(value: boolean) {
		isDuplicating.value = value
	},
})
watch(
	() => projectList.projects[project.value.parent_project_id],
	parent => parentProject.value = parent ?? null,
	{immediate: true},
)

// Placing the copy under a parent needs write access there.
function canHoldCopy(candidate: ProjectResponse) {
	return (candidate.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.READ_WRITE
}

// What turning sharing on would do: the direct shares of the original are copied, and its public links are
// recreated with new addresses. Listing public links needs admin on the original.
const sourceId = computed(() => isLoaded.value ? project.value.id : 0)
const canListLinks = computed(() => project.value.max_permission === PERMISSIONS.ADMIN && configStore.link_sharing_enabled)
const users = useQuery(computed(() => ({...projectUserSharesQuery(sourceId.value), enabled: sourceId.value > 0})))
const teams = useQuery(computed(() => ({...projectTeamSharesQuery(sourceId.value), enabled: sourceId.value > 0})))
const links = useQuery(computed(() => ({...linkSharesQuery(sourceId.value), enabled: sourceId.value > 0 && canListLinks.value})))
const sharesStatus = computed(() => combineStatus([
	queryStatus(users.data.value, users.isError.value),
	queryStatus(teams.data.value, teams.isError.value),
	...(canListLinks.value ? [queryStatus(links.data.value, links.isError.value)] : []),
]))
const sharesSentence = computed(() => {
	const userCount = users.data.value?.length ?? 0
	const teamCount = teams.data.value?.length ?? 0
	const people = t('project.duplicate.people', userCount)
	const teamText = t('project.duplicate.teams', teamCount)
	if (canListLinks.value) {
		const linkCount = links.data.value?.length ?? 0
		return t('project.duplicate.sharesWho', {people, teams: teamText, links: t('project.duplicate.links', linkCount)})
	}
	return configStore.link_sharing_enabled
		? t('project.duplicate.sharesWhoNoLinks', {people, teams: teamText})
		: t('project.duplicate.sharesWhoPeople', {people, teams: teamText})
})

async function duplicate() {
	if (isDuplicating.value || !isLoaded.value) {
		return
	}
	isDuplicating.value = true

	try {
		const duplicated = await duplicateProject.mutateAsync({
			projectId: project.value.id,
			parentProjectId: parentProject.value?.id ?? 0,
			duplicateShares: duplicateShares.value,
		})
		await router.push({name: 'project.index', params: {projectId: duplicated.id}})
	} catch {
		// The toast says what went wrong; the form stays as it was.
	} finally {
		isDuplicating.value = false
	}
}
</script>

<style lang="scss" scoped>
.duplicate-shares-help {
	margin-block-start: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	p {
		margin: 0;
	}
}
</style>
