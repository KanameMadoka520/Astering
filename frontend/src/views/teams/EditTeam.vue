<template>
	<div
		class="edit-team is-max-width-desktop"
		:aria-busy="isFetching"
	>
		<LoadError
			v-if="isError && !team"
			:retry="() => refetch()"
		/>

		<EditTeamForm
			v-if="team && userIsAdmin && !team.external_id"
			:key="team.id"
			:team="team"
			:loading="teamLoading"
			@save="save"
		/>

		<Card
			v-if="team || isPending"
			class="is-fullwidth has-overflow team-members"
			:title="$t('team.edit.members')"
			:padding="false"
		>
			<form
				v-if="userIsAdmin && team && !team.external_id"
				class="team-members__add"
				@submit.prevent="addUser"
			>
				<div class="field has-addons">
					<div class="control is-expanded">
						<Multiselect
							v-model="newMember"
							:loading="usersLoading"
							:placeholder="$t('team.edit.search')"
							:search-results="foundUsers"
							label="username"
							@search="findUser"
						>
							<template #searchResult="{option: user}">
								<User
									:avatar-size="24"
									:user="user"
									class="m-0"
								/>
							</template>
						</Multiselect>
					</div>
					<div class="control">
						<XButton
							icon="plus"
							:loading="addMemberMutation.isPending.value"
							@click="addUser"
						>
							{{ $t('team.edit.addUser') }}
						</XButton>
					</div>
				</div>
				<p
					v-if="showMustSelectUserError"
					class="help is-danger"
				>
					{{ $t('team.edit.mustSelectUser') }}
				</p>
				<p class="help team-members__help">
					{{ $t('team.edit.addHelp') }}
				</p>
			</form>
			<p
				v-if="team?.external_id"
				class="team-members__external"
			>
				{{ $t('team.edit.externalMembers') }}
			</p>
			<div
				v-if="!team"
				class="team-members__skeleton"
				role="status"
			>
				<span class="is-sr-only">{{ $t('misc.loading') }}</span>
				<span
					v-for="row in 3"
					:key="row"
					class="team-members__skeleton-row"
					aria-hidden="true"
				/>
			</div>
			<div
				v-else
				class="has-horizontal-overflow"
			>
				<table class="table has-actions is-hoverable is-fullwidth team-members__table">
					<thead>
						<tr>
							<th scope="col">
								{{ $t('misc.user') }}
							</th>
							<th scope="col">
								{{ $t('team.edit.role') }}
							</th>
							<th
								v-if="userIsAdmin"
								scope="col"
								class="actions"
							>
								<span class="is-sr-only">{{ $t('misc.actions') }}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="m in sortedMembers"
							:key="m.id"
						>
							<td>
								<span class="team-member">
									<User
										:avatar-size="24"
										:user="m"
										class="m-0"
									/>
									<span
										v-if="m.id === userInfo?.id"
										class="team-member__you"
									>{{ $t('tcymc.you') }}</span>
								</span>
							</td>
							<td class="type">
								<template v-if="m.admin">
									<span class="icon is-small">
										<Icon icon="lock" />
									</span>
									{{ $t('team.attributes.admin') }}
								</template>
								<template v-else>
									<span class="icon is-small">
										<Icon icon="user" />
									</span>
									{{ $t('team.attributes.member') }}
								</template>
							</td>
							<td
								v-if="userIsAdmin"
								class="actions"
							>
								<template v-if="m.id !== userInfo?.id">
									<XButton
										variant="secondary"
										class="is-small"
										:shadow="false"
										:loading="isTogglingMember(m)"
										:disabled="isRemovingMember(m) || undefined"
										@click="() => toggleUserType(m)"
									>
										{{ m.admin ? $t('team.edit.makeMember') : $t('team.edit.makeAdmin') }}
									</XButton>
									<!-- The sign-in provider owns the members of a managed team; the server refuses removals. -->
									<XButton
										v-if="!team.external_id"
										variant="tertiary"
										class="is-small team-member__remove"
										:shadow="false"
										:loading="isRemovingMember(m)"
										icon="trash-alt"
										:aria-label="$t('team.edit.deleteUser.header')"
										@click="() => openMemberRemoval(m)"
									/>
								</template>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</Card>

		<section
			v-if="team && !team.external_id"
			class="team-danger-zone"
			aria-labelledby="team-danger-zone-heading"
		>
			<h2
				id="team-danger-zone-heading"
				class="team-danger-zone__title"
			>
				{{ $t('team.edit.dangerZone') }}
			</h2>
			<p
				v-if="isOnlyMember"
				class="team-danger-zone__hint"
			>
				{{ $t('team.edit.leave.onlyMember') }}
			</p>
			<div class="team-danger-zone__actions">
				<XButton
					v-if="!isOnlyMember"
					variant="secondary"
					icon="sign-out-alt"
					:shadow="false"
					class="team-danger-zone__leave"
					@click="showLeaveModal = true"
				>
					{{ $t('team.edit.leave.title') }}
				</XButton>
				<XButton
					v-if="userIsAdmin"
					danger
					icon="trash-alt"
					:shadow="false"
					:loading="deleteMutation.isPending.value"
					@click="openDeleteModal()"
				>
					{{ $t('team.edit.delete.header') }}
				</XButton>
			</div>
		</section>

		<!-- Leave team modal -->
		<Modal
			:enabled="showLeaveModal"
			:loading="leaveMutation.isPending.value"
			:confirm-label="$t('team.edit.leave.title')"
			danger
			@close="showLeaveModal = false"
			@submit="leave()"
		>
			<template #header>
				<span>{{ $t('team.edit.leave.confirmHeader', {team: teamName}) }}</span>
			</template>

			<template #text>
				<p>{{ $t('team.edit.leave.text1') }}</p>
				<p>{{ $t('team.edit.leave.text2') }}</p>
				<p
					v-if="isOnlyAdmin"
					class="team-dialog__warning"
				>
					{{ $t('team.edit.leave.onlyAdmin') }}
				</p>
				<p
					v-if="compassStatus === 'pending'"
					role="status"
				>
					{{ $t('team.edit.leave.compassChecking') }}
				</p>
				<p
					v-else-if="compassStatus === 'error'"
					role="alert"
				>
					{{ $t('team.edit.leave.compassError') }}
				</p>
				<p v-else-if="teamSpaces.length > 0">
					{{ $t('team.edit.leave.compassSpaces', {count: teamSpaces.length, spaces: spaceList}, teamSpaces.length) }}
				</p>
				<ProjectAccessCleanupList
					:intro="$t('team.edit.leave.cleanupText')"
					perspective="self"
				/>
			</template>
		</Modal>

		<!-- Team delete modal -->
		<Modal
			:enabled="showDeleteModal"
			:loading="deleteMutation.isPending.value"
			:confirm-label="$t('team.edit.delete.header')"
			danger
			@close="closeDeleteModal()"
			@submit="deleteTeam()"
		>
			<template #header>
				<span>{{ $t('team.edit.delete.confirmHeader', {team: teamName}) }}</span>
			</template>

			<template #text>
				<p>{{ $t('team.edit.delete.text1') }}</p>
				<p>{{ $t('team.edit.delete.text2') }}</p>
				<!-- Deleting a team deletes all of its Compass spaces with every entry (pkg/models/teams.go). The space list only
				holds spaces the viewer can open (an instance admin outside the team sees none), so it is never called complete. -->
				<p class="team-dialog__warning">
					{{ $t('team.edit.delete.compassWarning') }}
				</p>
				<p
					v-if="compassStatus === 'pending'"
					role="status"
				>
					{{ $t('team.edit.delete.compassChecking') }}
				</p>
				<LoadError
					v-else-if="compassStatus === 'error'"
					:message="$t('team.edit.delete.compassError')"
					:retry="() => compassQuery.refetch()"
				/>
				<div
					v-else-if="teamSpaces.length > 0"
					class="team-dialog__spaces"
				>
					<p>{{ $t('team.edit.delete.compassKnown') }}</p>
					<ul>
						<li
							v-for="space in teamSpaces"
							:key="space.id"
						>
							{{ $t('team.edit.delete.compassSpace', {title: space.title, count: space.entry_count}, space.entry_count) }}
						</li>
					</ul>
				</div>
				<p
					v-if="!ownMembership"
					class="team-dialog__muted"
				>
					{{ $t('team.edit.delete.compassMaybeMore') }}
				</p>
				<FancyCheckbox
					v-model="deleteAcknowledged"
					class="team-dialog__acknowledge"
				>
					{{ $t('team.edit.delete.acknowledge') }}
				</FancyCheckbox>
				<p
					v-if="showAcknowledgeError && !deleteAcknowledged"
					class="help is-danger"
					role="alert"
				>
					{{ $t('team.edit.delete.acknowledgeRequired') }}
				</p>
				<ProjectAccessCleanupList :intro="$t('team.edit.delete.cleanupText')" />
			</template>
		</Modal>

		<!-- User delete modal -->
		<Modal
			:enabled="memberToDelete !== null"
			:loading="removeMemberMutation.isPending.value"
			:confirm-label="$t('team.edit.deleteUser.confirm')"
			danger
			@close="memberToDelete = null"
			@submit="deleteMember()"
		>
			<template #header>
				<span>{{ $t('team.edit.deleteUser.confirmHeader', {name: removalName, team: teamName}) }}</span>
			</template>

			<template #text>
				<p>{{ $t('team.edit.deleteUser.text1', {name: removalName}) }}</p>
				<p>{{ $t('team.edit.deleteUser.text2') }}</p>
				<ProjectAccessCleanupList :intro="$t('team.edit.deleteUser.cleanupText')" />
			</template>
		</Modal>

		<!-- Promote member modal -->
		<Modal
			:enabled="memberToPromote !== null"
			:loading="toggleAdminMutation.isPending.value"
			:confirm-label="$t('team.edit.makeAdmin')"
			@close="memberToPromote = null"
			@submit="promote()"
		>
			<template #header>
				<span>{{ $t('team.edit.makeAdminHeader', {name: promotionName}) }}</span>
			</template>

			<template #text>
				<p>{{ $t('team.edit.makeAdminText') }}</p>
			</template>
		</Modal>
	</div>
</template>

<script lang="ts" setup>
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter} from 'vue-router'
import {useQuery} from '@tanstack/vue-query'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import Multiselect from '@/components/input/Multiselect.vue'
import User from '@/components/misc/User.vue'
import ProjectAccessCleanupList from '@/components/sharing/ProjectAccessCleanupList.vue'
import EditTeamForm from '@/components/teams/EditTeamForm.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {getDisplayName} from '@/helpers/user'
import {compassSpacesQuery} from '@/client/queries/compass'
import {useUpdateTeamMutation, useDeleteTeamMutation, useAddTeamMemberMutation, useRemoveTeamMemberMutation, useLeaveTeamMutation, useToggleTeamMemberAdminMutation} from '@/client/queries/teams'
import {useTeam} from '@/composables/useTeams'
import {useUserSearch} from '@/composables/useUserSearch'
import {PERMISSIONS} from '@/constants/permissions'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'
import type {User as ApiUser, TeamUser, TeamWritable} from '@/client/generated'

const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()
const {t, locale} = useI18n({useScope: 'global'})
const teamId = computed(() => Number(route.params.id))
const {data: team, isFetching, isPending, isError, refetch} = useTeam(teamId)

const userIsAdmin = computed(() => (team.value?.max_permission ?? PERMISSIONS.READ) === PERMISSIONS.ADMIN)
const userInfo = computed(() => authStore.info)
const teamName = computed(() => team.value?.name ?? '')
const members = computed(() => team.value?.members ?? [])
const sortedMembers = computed(() => [...members.value].sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b), undefined, {sensitivity: 'base'})))
const ownMembership = computed(() => members.value.find(member => member.id === userInfo.value?.id))
// The server refuses to remove a team's last member.
const isOnlyMember = computed(() => members.value.length === 1 && ownMembership.value !== undefined)
// The server lets the last admin leave, which leaves a team nobody can manage.
const isOnlyAdmin = computed(() => Boolean(ownMembership.value?.admin)
	&& members.value.length > 1
	&& members.value.filter(member => member.admin).length === 1)
const updateMutation = useUpdateTeamMutation()
const deleteMutation = useDeleteTeamMutation()
const addMemberMutation = useAddTeamMemberMutation()
const removeMemberMutation = useRemoveTeamMemberMutation()
const leaveMutation = useLeaveTeamMutation()
const toggleAdminMutation = useToggleTeamMemberAdminMutation()
const teamLoading = computed(() => updateMutation.isPending.value || deleteMutation.isPending.value)
const userSearch = ref('')
const {users: userResults, isFetching: usersLoading} = useUserSearch(userSearch)
const foundUsers = computed(() => userResults.value.filter(u => u.id !== userInfo.value?.id && !team.value?.members?.some(member => member.id === u.id)))
const newMember = ref<ApiUser | null>(null)
const memberToDelete = ref<TeamUser | null>(null)
const memberToPromote = ref<TeamUser | null>(null)
// Kept after closing so the dialog text doesn't blank during its fade-out.
const removalName = ref('')
const promotionName = ref('')
const showDeleteModal = ref(false)
// Deleting the team also deletes its Compass spaces for good, so the dialog asks for an explicit acknowledgement.
const deleteAcknowledged = ref(false)
const showAcknowledgeError = ref(false)
const showLeaveModal = ref(false)
const showMustSelectUserError = ref(false)
const title = computed(() => t('team.edit.title', {team: team.value?.name ?? ''}))
useTitle(title)

// Team Compass spaces go with the team: deleting it deletes them, leaving it ends access to them.
const compassQuery = useQuery(computed(() => ({...compassSpacesQuery(), enabled: showDeleteModal.value || showLeaveModal.value})))
const teamSpaces = computed(() => (compassQuery.data.value ?? []).filter(space => space.team_id === teamId.value))
const compassStatus = computed(() => {
	if (compassQuery.data.value !== undefined) return 'success'
	return compassQuery.isError.value ? 'error' : 'pending'
})
const spaceList = computed(() => new Intl.ListFormat(locale.value, {type: 'conjunction'}).format(teamSpaces.value.map(space => space.title)))

// Synchronous guards: isPending only flips after the next render, too late for a double click.
let deleting = false
let removing = false
let leaving = false
let promoting = false

function save(draft: Required<TeamWritable>) {
	// A second Enter in the name field would otherwise send the update again.
	if (updateMutation.isPending.value) return
	updateMutation.mutate({id: teamId.value, team: draft})
}

function openDeleteModal() {
	deleteAcknowledged.value = false
	showAcknowledgeError.value = false
	showDeleteModal.value = true
}

function closeDeleteModal() {
	showDeleteModal.value = false
}

async function deleteTeam() {
	if (!deleteAcknowledged.value) {
		showAcknowledgeError.value = true
		return
	}
	if (deleting) return
	deleting = true
	try {
		await deleteMutation.mutateAsync(teamId.value)
	} catch {
		return
	} finally {
		deleting = false
	}
	showDeleteModal.value = false
	await router.push({name: 'teams.index'})
}

function openMemberRemoval(member: TeamUser) {
	removalName.value = getDisplayName(member)
	memberToDelete.value = member
}

async function deleteMember() {
	const member = memberToDelete.value
	if (!member?.username || removing) return
	removing = true
	try {
		await removeMemberMutation.mutateAsync({teamId: teamId.value, username: member.username})
	} catch {
		return
	} finally {
		removing = false
	}
	if (memberToDelete.value === member) memberToDelete.value = null
}

async function addUser() {
	showMustSelectUserError.value = !newMember.value?.username
	if (!newMember.value?.username || addMemberMutation.isPending.value) return
	const member = newMember.value
	try {
		await addMemberMutation.mutateAsync({teamId: teamId.value, username: member.username!})
	} catch {
		return
	}
	if (newMember.value === member) {
		newMember.value = null
		userSearch.value = ''
	}
}

// Only the row being changed shows a spinner.
function isTogglingMember(member: TeamUser) {
	return toggleAdminMutation.isPending.value && toggleAdminMutation.variables.value?.username === member.username
}

function isRemovingMember(member: TeamUser) {
	return removeMemberMutation.isPending.value && removeMemberMutation.variables.value?.username === member.username
}

// Making someone an admin hands them the team, so it asks first; taking it back doesn't.
function toggleUserType(member: TeamUser) {
	if (!member.username) return
	if (!member.admin) {
		promotionName.value = getDisplayName(member)
		memberToPromote.value = member
		return
	}
	toggleAdminMutation.mutate({teamId: teamId.value, username: member.username})
}

async function promote() {
	const member = memberToPromote.value
	if (!member?.username || promoting) return
	promoting = true
	try {
		await toggleAdminMutation.mutateAsync({teamId: teamId.value, username: member.username})
	} catch {
		return
	} finally {
		promoting = false
	}
	if (memberToPromote.value === member) memberToPromote.value = null
}

function findUser(query: string) {
	userSearch.value = query
}

async function leave() {
	if (!userInfo.value?.username || leaving) return
	leaving = true
	try {
		await leaveMutation.mutateAsync({teamId: teamId.value, username: userInfo.value.username})
	} catch {
		return
	} finally {
		leaving = false
	}
	showLeaveModal.value = false
	await router.push({name: 'home'})
}
</script>

<style lang="scss" scoped>
.edit-team {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
}

.card.is-fullwidth {
	margin-block-end: 0;

	.content {
		padding: 0;
	}
}

.team-members__add {
	padding: var(--space-4);
	border-block-end: 1px solid var(--border-subtle);
}

.team-members__table {
	th {
		color: var(--text-tertiary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
	}

	td {
		vertical-align: middle;
	}

	.type {
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.actions {
		text-align: end;
		white-space: nowrap;
	}
}

.team-member {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.team-member__you {
	padding: .0625rem var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

// Out-ranks the tertiary button's inherited colour.
.team-members__table .button.team-member__remove {
	margin-inline-start: var(--space-1);
	color: var(--danger-text);
}

.team-members__help {
	margin-block-start: var(--space-2);
	color: var(--text-secondary);
}

.team-members__external {
	margin: 0;
	padding: var(--space-3) var(--space-4);
	border-block-end: 1px solid var(--border-subtle);
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.team-members__skeleton {
	display: grid;
	gap: var(--space-2);
	padding: var(--space-4);
}

.team-members__skeleton-row {
	block-size: 1.5rem;
	inline-size: 50%;
	border-radius: var(--radius-xs);
	background: var(--surface-active);
}

.team-danger-zone {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3) var(--space-4);
	padding: var(--space-4);
	border: 1px solid var(--border-default);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-md);
	background: var(--surface);
}

.team-danger-zone__title {
	margin: 0;
	font-size: var(--text-lg);
}

.team-danger-zone__hint {
	flex: 1 1 16rem;
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.team-dialog__warning {
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
}

.team-dialog__muted {
	color: var(--text-secondary);
}

.team-dialog__acknowledge {
	margin-block: var(--space-3);
}

.team-dialog__spaces ul {
	margin-block: var(--space-1) 0;
	padding-inline-start: var(--space-5);
}

.team-danger-zone__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.team-danger-zone__actions .button.team-danger-zone__leave {
	color: var(--danger-text);
}
</style>
