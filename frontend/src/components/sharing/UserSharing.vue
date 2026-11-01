<template>
	<SharingList
		v-model:search="search"
		kind="user"
		:project="project"
		:user-is-admin="userIsAdmin"
		:shares="shares"
		:status="status"
		:retry="() => sharesQuery.refetch()"
		:candidates="candidates"
		:search-loading="isFetching"
		search-label="username"
		:is-mutating="createShare.isPending.value || updateShare.isPending.value || deleteShare.isPending.value"
		:type-name="$t('project.share.userTeam.typeUser', 1)"
		:type-names="$t('project.share.userTeam.typeUser', 2)"
		:share-name="getDisplayName"
		:inherited-grant="share => access.inheritedUser(share.id)"
		:add="(projectId, user) => createShare.mutateAsync({projectId, username: user.username})"
		:update-permission="(projectId, share, permission) => updateShare.mutateAsync({projectId, username: share.username, permission})"
		:remove="(projectId, share) => deleteShare.mutateAsync({projectId, username: share.username, name: getDisplayName(share), self: isMe(share)})"
		:is-self="isMe"
		@removedSelf="router.push({name: 'home'})"
	>
		<template #candidate="{candidate}">
			<User
				:avatar-size="24"
				:show-username="true"
				:user="candidate"
			/>
		</template>
		<template #share="{share}">
			<td class="sharing-name">
				<span>{{ getDisplayName(share) }}</span>
				<span
					v-if="isMe(share)"
					class="sharing-you"
				>{{ $t('project.share.userTeam.you') }}</span>
			</td>
		</template>
	</SharingList>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useRouter} from 'vue-router'
import {useQuery} from '@tanstack/vue-query'
import {projectUserSharesQuery, useCreateProjectUserShareMutation, useUpdateProjectUserShareMutation, useDeleteProjectUserShareMutation} from '@/client/queries/projectShares'
import type {ProjectResponse} from '@/client/queries/projects'
import {useUserSearch} from '@/composables/useUserSearch'
import {getDisplayName} from '@/helpers/user'
import {useAuthStore} from '@/stores/auth'
import SharingList from '@/components/sharing/SharingList.vue'
import {queryStatus, useProjectAccess} from '@/components/sharing/useProjectAccess'
import User from '@/components/misc/User.vue'

const props = defineProps<{
	project: ProjectResponse
	userIsAdmin: boolean
}>()

const authStore = useAuthStore()
const router = useRouter()

function isMe(share: {id: number}) {
	return share.id === authStore.info?.id
}

function hasUsername<T extends {username?: string}>(user: T): user is T & {username: string} {
	return Boolean(user.username)
}

const sharesQuery = useQuery(computed(() => ({...projectUserSharesQuery(props.project.id), enabled: props.project.id > 0})))
const shares = computed(() => (sharesQuery.data.value ?? []).filter(hasUsername))
const status = computed(() => queryStatus(sharesQuery.data.value, sharesQuery.isError.value, sharesQuery.isFetching.value))
const access = useProjectAccess(() => props.project)
const search = ref('')
const {users, isFetching} = useUserSearch(search)
const candidates = computed(() => users.value.filter(hasUsername).filter(user => user.id !== authStore.info?.id))

const createShare = useCreateProjectUserShareMutation()
const updateShare = useUpdateProjectUserShareMutation()
const deleteShare = useDeleteProjectUserShareMutation()
</script>

<style lang="scss" scoped>
.sharing-name {
	overflow-wrap: anywhere;
}

.sharing-you {
	display: inline-block;
	margin-inline-start: var(--space-2);
	padding-inline: var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-normal);
}
</style>
