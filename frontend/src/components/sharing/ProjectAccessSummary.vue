<template>
	<section
		class="sharing-section access-summary"
		:aria-labelledby="headingId"
		:aria-busy="status === 'pending' || undefined"
	>
		<h3
			:id="headingId"
			class="sharing-title"
		>
			{{ $t('project.share.access.title') }}
		</h3>

		<ul class="access-lines">
			<li
				v-if="project.owner"
				class="access-line"
			>
				<Icon
					icon="user"
					class="access-icon"
				/>
				<span>{{ $t('project.share.access.owner', {name: getDisplayName(project.owner)}) }}</span>
				<span
					v-if="ownerIsMe"
					class="access-you"
				>{{ $t('project.share.userTeam.you') }}</span>
			</li>
			<li
				v-if="project.owner && !ownerIsMe"
				class="access-line"
			>
				<Icon
					icon="users"
					class="access-icon"
				/>
				<span>{{ $t('project.share.access.sharedWithYou', {permission: $t(sharePermissionKey(project.max_permission))}) }}</span>
			</li>
		</ul>

		<div
			v-for="source in grantingSources"
			:key="source.parent.id"
			class="access-source"
		>
			<p class="access-source__title">
				{{ $t('project.share.access.throughParent', {parent: getProjectTitle(source.parent)}) }}
			</p>
			<ul class="access-grants">
				<li v-if="source.ownerDiffers && source.parent.owner">
					{{ $t('project.share.access.parentOwner', {
						name: getDisplayName(source.parent.owner),
						parent: getProjectTitle(source.parent),
					}) }}
				</li>
				<li
					v-for="user in source.users"
					:key="`user-${user.id}`"
				>
					<span>{{ getDisplayName(user) }}</span>
					<span class="access-permission">{{ $t(sharePermissionKey(user.permission)) }}</span>
				</li>
				<li
					v-for="team in source.teams"
					:key="`team-${team.id}`"
				>
					<span>{{ team.name || $t('project.share.userTeam.unknownTeam') }}</span>
					<span class="access-permission">{{ $t(sharePermissionKey(team.permission)) }}</span>
				</li>
			</ul>
			<RouterLink
				v-if="source.parent.max_permission === PERMISSIONS.ADMIN"
				class="access-manage"
				:to="{name: 'project.settings.share', params: {projectId: source.parent.id}}"
			>
				{{ $t('project.share.access.manageParent', {parent: getProjectTitle(source.parent)}) }}
			</RouterLink>
			<p
				v-else
				class="access-muted"
			>
				{{ $t('project.share.access.parentManaged', {parent: getProjectTitle(source.parent)}) }}
			</p>
		</div>

		<p
			v-if="access.ancestry.value.hasHiddenAncestor && isListed(access.listStatus.value)"
			class="access-note"
		>
			{{ $t('project.share.access.hiddenParent') }}
		</p>

		<details
			v-if="subprojects.length > 0"
			class="access-subprojects"
		>
			<summary>{{ $t('project.share.access.subprojects', {count: subprojects.length}, subprojects.length) }}</summary>
			<ul>
				<li
					v-for="subproject in subprojects"
					:key="subproject.id"
				>
					{{ getProjectTitle(subproject) }}
				</li>
			</ul>
		</details>

		<p
			v-if="status === 'pending'"
			class="access-muted"
			role="status"
		>
			{{ $t('project.share.access.checking') }}
		</p>
		<LoadError
			v-else-if="status === 'error'"
			:message="$t('project.share.access.loadError')"
			:retry="access.retry"
		/>
		<template v-else-if="notShared">
			<p class="access-verdict">
				{{ $t('project.share.access.notShared') }}
			</p>
			<p
				v-if="adminPanelEnabled"
				class="access-muted"
			>
				{{ $t('project.share.access.siteAdmins') }}
			</p>
		</template>

		<details class="access-rules">
			<summary>{{ $t('project.share.access.rulesTitle') }}</summary>
			<p>{{ $t('project.share.access.inheritRule') }}</p>
			<p>{{ $t('project.share.access.knownGrants') }}</p>
			<p>{{ $t('project.share.access.explainer') }}</p>
		</details>
	</section>
</template>

<script setup lang="ts">
import {computed, useId} from 'vue'
import {useQuery} from '@tanstack/vue-query'

import {linkSharesQuery} from '@/client/queries/linkShares'
import {projectTeamSharesQuery, projectUserSharesQuery} from '@/client/queries/projectShares'
import type {ProjectResponse} from '@/client/queries/projects'
import LoadError from '@/components/misc/state/LoadError.vue'
import {sharePermissionKey} from '@/components/sharing/sharePermission'
import {isListed, queryStatus, useProjectAccess} from '@/components/sharing/useProjectAccess'
import {useProjects} from '@/composables/useProjects'
import {PERMISSIONS} from '@/constants/permissions'
import {PRO_FEATURE} from '@/constants/proFeatures'
import {getProjectTitle} from '@/helpers/getProjectTitle'
import {descendantProjects} from '@/helpers/projectAccess'
import {getDisplayName} from '@/helpers/user'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'

const props = defineProps<{
	project: ProjectResponse
	userIsAdmin: boolean
}>()

const headingId = useId()
const authStore = useAuthStore()
const configStore = useConfigStore()
const projectList = useProjects()
const access = useProjectAccess(() => props.project)

const myId = computed(() => authStore.info?.id)
const ownerIsMe = computed(() => props.project.owner?.id !== undefined && props.project.owner.id === myId.value)
const adminPanelEnabled = computed(() => configStore.isProFeatureEnabled(PRO_FEATURE.ADMIN_PANEL))
// Link shares need project admin to list and only count while the site allows them.
const checksLinks = computed(() => props.userIsAdmin && configStore.link_sharing_enabled)

// Same keys as the lists below, so these reuse their requests.
const directUsers = useQuery(computed(() => ({...projectUserSharesQuery(props.project.id), enabled: props.project.id > 0})))
const directTeams = useQuery(computed(() => ({...projectTeamSharesQuery(props.project.id), enabled: props.project.id > 0})))
const links = useQuery(computed(() => ({...linkSharesQuery(props.project.id), enabled: props.project.id > 0 && checksLinks.value})))

// Grants read earlier stay listed when a refresh fails; the error below says the lists may be incomplete.
const grantingSources = computed(() => access.sources.value.filter(source =>
	source.ownerDiffers || source.users.length > 0 || source.teams.length > 0,
))
const status = access.status

const subprojects = computed(() => access.listStatus.value === 'success'
	? descendantProjects(projectList.projectsArray.filter(project => project.id > 0), props.project.id)
	: [])

function settled(query: {data: {value: unknown}, isError: {value: boolean}, isFetching: {value: boolean}}) {
	return queryStatus(query.data.value, query.isError.value, query.isFetching.value) === 'success'
}

// "Not shared" is only said once every source of access has just been read and is empty: cached lists that failed
// to refresh, or are refreshing, don't count. Site admins are mentioned separately.
const notShared = computed(() => {
	if (!ownerIsMe.value || status.value !== 'success' || access.ancestry.value.hasHiddenAncestor) {
		return false
	}
	const others = (users: {id?: number}[]) => users.some(user => user.id !== myId.value)
	if (access.sources.value.some(source => source.ownerDiffers || others(source.users) || source.teams.length > 0)) {
		return false
	}
	if (!settled(directUsers) || others(directUsers.data.value ?? [])) {
		return false
	}
	if (!settled(directTeams) || (directTeams.data.value ?? []).length > 0) {
		return false
	}
	if (configStore.link_sharing_enabled) {
		if (!checksLinks.value || !settled(links) || (links.data.value ?? []).length > 0) {
			return false
		}
	}
	return true
})
</script>

<style lang="scss" scoped>
.access-summary {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;

	.sharing-title {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-tight);
	}

	p,
	ul {
		margin: 0;
	}
}

.access-lines,
.access-grants {
	display: grid;
	gap: var(--space-1);
	padding: 0;
	list-style: none;
}

.access-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-primary);
	font-size: var(--text-md);
}

.access-icon {
	color: var(--text-tertiary);
}

.access-you {
	padding-inline: var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-normal);
}

.access-source {
	display: grid;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
}

.access-source__title {
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.access-grants li {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	overflow-wrap: anywhere;
	color: var(--text-primary);
	font-size: var(--text-sm);
}

.access-permission {
	color: var(--text-secondary);
}

.access-manage {
	justify-self: start;
	color: var(--accent-text);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);

	@media (pointer: coarse) {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--target-min);
	}
}

.access-note,
.access-verdict {
	color: var(--text-primary);
	font-size: var(--text-sm);
}

.access-muted {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.access-rules {
	color: var(--text-secondary);
	font-size: var(--text-sm);

	summary {
		cursor: pointer;
		color: var(--text-primary);

		@media (pointer: coarse) {
			min-block-size: var(--target-min);
			align-content: center;
		}
	}

	p {
		margin-block-start: var(--space-1);
	}
}

.access-subprojects {
	color: var(--text-primary);
	font-size: var(--text-sm);

	summary {
		cursor: pointer;

		@media (pointer: coarse) {
			min-block-size: var(--target-min);
			align-content: center;
		}
	}

	ul {
		margin-block-start: var(--space-1);
		padding-inline-start: var(--space-5);
	}
}
</style>
