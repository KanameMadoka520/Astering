<template>
	<SharingList
		v-model:search="search"
		kind="team"
		:project="project"
		:user-is-admin="userIsAdmin"
		:shares="sharesQuery.data.value ?? []"
		:status="status"
		:retry="() => sharesQuery.refetch()"
		:candidates="teams"
		:search-loading="isFetching"
		search-label="name"
		:is-mutating="createShare.isPending.value || updateShare.isPending.value || deleteShare.isPending.value"
		:type-name="$t('project.share.userTeam.typeTeam', 1)"
		:type-names="$t('project.share.userTeam.typeTeam', 2)"
		:share-name="teamName"
		:inherited-grant="share => access.inheritedTeam(share.id)"
		:add="(projectId, team) => createShare.mutateAsync({projectId, teamId: team.id})"
		:update-permission="(projectId, share, permission) => updateShare.mutateAsync({projectId, teamId: share.id, permission})"
		:remove="(projectId, share) => deleteShare.mutateAsync({projectId, teamId: share.id, name: teamName(share)})"
	>
		<template #help>
			<p
				v-if="userIsAdmin"
				class="sharing-help"
			>
				{{ $t('project.share.userTeam.teamHelp') }}
			</p>
		</template>
		<template #candidate="{candidate}">
			<span class="search-result">{{ candidate.name }}</span>
		</template>
		<template #share="{share}">
			<td class="sharing-name">
				<!-- A team page only opens for its members (and instance admins); a public team can be named here without that. -->
				<RouterLink
					v-if="share.name && canOpenTeam(share.id)"
					:to="{name: 'teams.edit', params: {id: share.id}}"
				>
					{{ share.name }}
				</RouterLink>
				<span v-else-if="share.name">{{ share.name }}</span>
				<!-- The server leaves out the details of teams the viewer can't read. -->
				<span
					v-else
					class="sharing-unknown"
				>{{ teamName(share) }}</span>
			</td>
		</template>
	</SharingList>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'
import {projectTeamSharesQuery, useCreateProjectTeamShareMutation, useUpdateProjectTeamShareMutation, useDeleteProjectTeamShareMutation} from '@/client/queries/projectShares'
import {memberTeamIdsQuery} from '@/client/queries/teams'
import type {ProjectResponse} from '@/client/queries/projects'
import {useTeamSearch} from '@/composables/useTeams'
import {PRO_FEATURE} from '@/constants/proFeatures'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'
import SharingList from '@/components/sharing/SharingList.vue'
import {queryStatus, useProjectAccess} from '@/components/sharing/useProjectAccess'

const props = defineProps<{
	project: ProjectResponse
	userIsAdmin: boolean
}>()

const {t} = useI18n({useScope: 'global'})
const configStore = useConfigStore()
const authStore = useAuthStore()

const sharesQuery = useQuery(computed(() => ({...projectTeamSharesQuery(props.project.id), enabled: props.project.id > 0})))
const status = computed(() => queryStatus(sharesQuery.data.value, sharesQuery.isError.value, sharesQuery.isFetching.value))
const access = useProjectAccess(() => props.project)
const search = ref('')
const {teams, isFetching} = useTeamSearch({search, includePublic: () => configStore.public_teams_enabled, enabled: () => search.value !== ''})

const isInstanceAdmin = computed(() => configStore.isProFeatureEnabled(PRO_FEATURE.ADMIN_PANEL) && authStore.info?.is_admin === true)
const hasNamedShares = computed(() => (sharesQuery.data.value ?? []).some(share => Boolean(share.name)))
const memberTeams = useQuery(computed(() => ({...memberTeamIdsQuery(), enabled: hasNamedShares.value && !isInstanceAdmin.value})))

function canOpenTeam(teamId: number) {
	return isInstanceAdmin.value || (memberTeams.data.value ?? []).includes(teamId)
}

function teamName(team: {name?: string}) {
	return team.name || t('project.share.userTeam.unknownTeam')
}

const createShare = useCreateProjectTeamShareMutation()
const updateShare = useUpdateProjectTeamShareMutation()
const deleteShare = useDeleteProjectTeamShareMutation()
</script>

<style lang="scss" scoped>
.sharing-name {
	overflow-wrap: anywhere;

	a {
		color: var(--accent-text);
		font-weight: var(--weight-medium);
	}
}

.sharing-unknown {
	color: var(--text-secondary);
	font-style: italic;
}
</style>
