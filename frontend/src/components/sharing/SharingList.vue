<template>
	<section
		class="sharing-section"
		:aria-busy="status === 'pending' || undefined"
	>
		<h3 class="sharing-title">
			{{ $t('project.share.userTeam.shared', {type: typeNames}) }}
		</h3>
		<slot name="help" />
		<!-- Adding waits for the list: it filters out people who already have a direct share. -->
		<div
			v-if="userIsAdmin && isListed(status)"
			class="field has-addons sharing-add"
		>
			<p
				class="control is-expanded"
				:class="{ 'is-loading': showSearchLoading }"
			>
				<Multiselect
					v-model="selected"
					:loading="searchLoading"
					:placeholder="$t('misc.searchPlaceholder')"
					:aria-label="$t('project.share.userTeam.search', {type: typeName})"
					:search-results="unsharedCandidates"
					:label="searchLabel"
					@search="search = $event"
				>
					<template #searchResult="{option}">
						<slot
							name="candidate"
							:candidate="option"
						/>
					</template>
				</Multiselect>
			</p>
			<p class="control">
				<XButton
					:loading="isMutating"
					:aria-disabled="!selected || isMutating || undefined"
					@click="addSelected()"
				>
					{{ $t('project.share.share') }}
				</XButton>
			</p>
		</div>

		<div
			v-if="identifiedShares.length > 0"
			class="has-horizontal-overflow"
		>
			<table
				class="sharing-table"
				:class="{'is-admin': userIsAdmin}"
			>
				<thead>
					<tr>
						<th>
							<span class="is-sr-only">{{ $t('admin.users.nameLabel') }}</span>
						</th>
						<th class="type">
							<span class="is-sr-only">{{ $t('project.share.permission.title') }}</span>
						</th>
						<th v-if="userIsAdmin">
							<span class="is-sr-only">{{ $t('project.views.actions') }}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="share in identifiedShares"
						:key="share.id"
					>
						<slot
							name="share"
							:share="share"
						/>
						<td class="type">
							<span class="sharing-permission">
								<Icon :icon="sharePermissionIcon(share.permission)" />
								{{ $t(sharePermissionKey(share.permission)) }}
							</span>
						</td>
						<td
							v-if="userIsAdmin"
							class="actions"
						>
							<div class="sharing-row-actions">
								<div class="select">
									<select
										v-model="selectedPermission[share.id]"
										:aria-disabled="isMutating || undefined"
										:aria-label="$t('project.share.userTeam.permissionFor', {sharable: shareName(share)})"
										@change="changePermission(share)"
									>
										<option
											:selected="share.permission === PERMISSIONS.READ"
											:value="PERMISSIONS.READ"
										>
											{{ $t('project.share.permission.read') }}
										</option>
										<option
											:selected="share.permission === PERMISSIONS.READ_WRITE"
											:value="PERMISSIONS.READ_WRITE"
										>
											{{ $t('project.share.permission.readWrite') }}
										</option>
										<option
											:selected="share.permission === PERMISSIONS.ADMIN"
											:value="PERMISSIONS.ADMIN"
										>
											{{ $t('project.share.permission.admin') }}
										</option>
									</select>
								</div>
								<XButton
									variant="tertiary"
									danger
									icon="trash-alt"
									:shadow="false"
									:aria-label="$t('project.share.userTeam.remove', {type: typeName})"
									@click="openRemoval(share)"
								/>
							</div>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<!-- Rows from an earlier load stay, but they may be out of date. -->
		<LoadError
			v-if="identifiedShares.length > 0 && status === 'error'"
			:message="$t('project.share.refreshError')"
			:retry="retry"
		/>

		<div
			v-else-if="identifiedShares.length === 0 && status === 'pending'"
			class="sharing-skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ $t('project.share.userTeam.loading') }}</span>
			<span
				v-for="row in 2"
				:key="row"
				class="sharing-skeleton__row"
				aria-hidden="true"
			/>
		</div>

		<LoadError
			v-else-if="identifiedShares.length === 0 && status === 'error'"
			:message="$t('project.share.userTeam.loadError')"
			:retry="retry"
		/>

		<p
			v-else-if="identifiedShares.length === 0"
			class="sharing-empty"
		>
			{{ $t('project.share.userTeam.notShared', {type: typeNames}) }}
		</p>

		<Modal
			:enabled="shareToDelete !== null"
			:loading="isMutating"
			:confirm-label="$t('project.share.userTeam.removeConfirm')"
			danger
			@close="shareToDelete = null"
			@submit="removeShare()"
		>
			<template #header>
				<span v-if="removingSelf">{{ $t('project.share.userTeam.removeSelfHeader') }}</span>
				<span v-else>{{ $t('project.share.userTeam.removeHeader', {name: removalName}) }}</span>
			</template>
			<template #text>
				<p v-if="removingSelf">
					{{ $t('project.share.userTeam.removeSelfText', {project: project.title}) }}
				</p>
				<p v-else>
					{{ $t(kind === 'user' ? 'project.share.userTeam.removeUserText' : 'project.share.userTeam.removeTeamText', {
						name: removalName,
						project: project.title,
					}) }}
				</p>
				<p v-if="removalInherited">
					{{ $t(removingSelf ? 'project.share.userTeam.removeSelfStillThrough' : 'project.share.userTeam.removeStillThrough', {
						name: removalName,
						parent: removalInherited.parent.title,
						permission: $t(sharePermissionKey(removalInherited.permission)),
					}) }}
				</p>
				<p v-else-if="!removingSelf">
					{{ $t('project.share.userTeam.removeMayRemain') }}
				</p>
				<ProjectAccessCleanupList
					:intro="$t(removingSelf ? 'project.share.userTeam.removeSelfCleanupText' : 'project.share.userTeam.removeCleanupText')"
					:perspective="removingSelf ? 'self' : 'others'"
				/>
			</template>
		</Modal>

		<!-- Lowering your own share can take away the very control needed to undo it. -->
		<Modal
			:enabled="selfLowering !== null"
			:loading="isMutating"
			:confirm-label="$t('project.share.userTeam.lowerSelfConfirm')"
			danger
			@close="cancelLowering()"
			@submit="confirmLowering()"
		>
			<template #header>
				<span>{{ $t('project.share.userTeam.lowerSelfHeader', {permission: loweringLabel}) }}</span>
			</template>
			<template #text>
				<p>{{ $t('project.share.userTeam.lowerSelfText') }}</p>
			</template>
		</Modal>
	</section>
</template>

<script setup lang="ts" generic="Candidate extends Record<string, unknown> & {id?: number}, Share extends {id?: number, permission?: number}">
import {computed, ref, watch, type Ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {normalizeSharePermission} from '@/client/queries/projectShares'
import type {ProjectResponse} from '@/client/queries/projects'
import {PERMISSIONS, type Permission} from '@/constants/permissions'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import Multiselect from '@/components/input/Multiselect.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import ProjectAccessCleanupList from '@/components/sharing/ProjectAccessCleanupList.vue'
import {sharePermissionIcon, sharePermissionKey} from '@/components/sharing/sharePermission'
import {isListed, type AccessStatus, type InheritedGrant} from '@/components/sharing/useProjectAccess'

type Identified<T extends {id?: number}> = T & {id: number}

const props = defineProps<{
	kind: 'user' | 'team'
	project: ProjectResponse
	userIsAdmin: boolean
	shares: Share[]
	status: AccessStatus
	retry: () => unknown
	candidates: Candidate[]
	searchLoading: boolean
	searchLabel: string
	isMutating: boolean
	typeName: string
	typeNames: string
	shareName: (share: Identified<Share>) => string
	inheritedGrant: (share: Identified<Share>) => InheritedGrant | null
	add: (projectId: number, candidate: Identified<Candidate>) => Promise<unknown>
	updatePermission: (projectId: number, share: Identified<Share>, permission: Permission) => Promise<unknown>
	remove: (projectId: number, share: Identified<Share>) => Promise<unknown>
	/** The share is the current user's own. */
	isSelf?: (share: Identified<Share>) => boolean
}>()

const emit = defineEmits<{
	/** The current user removed their own direct share. */
	removedSelf: []
}>()

const {t} = useI18n({useScope: 'global'})
const showSearchLoading = useDelayedLoading(() => props.searchLoading)

const search = defineModel<string>('search', {required: true})

defineSlots<{
	help?(): unknown
	candidate(props: {candidate: Identified<Candidate>}): unknown
	share(props: {share: Identified<Share>}): unknown
}>()

function hasId<T extends {id?: number}>(item: T): item is Identified<T> {
	return typeof item.id === 'number'
}

const identifiedShares = computed(() => props.shares.filter(hasId))
const unsharedCandidates = computed(() => props.candidates.filter(hasId).filter(candidate => !identifiedShares.value.some(share => share.id === candidate.id)))
const selected = ref(null) as Ref<Identified<Candidate> | null>
const selectedPermission = ref<Record<number, Permission>>({})
const shareToDelete = ref(null) as Ref<Identified<Share> | null>
// Kept after closing so the dialog text doesn't blank during its fade-out.
const removalSubject = ref(null) as Ref<Identified<Share> | null>
const removalName = computed(() => removalSubject.value ? props.shareName(removalSubject.value) : '')
const removalInherited = computed(() => removalSubject.value ? props.inheritedGrant(removalSubject.value) : null)
const removingSelf = computed(() => removalSubject.value !== null && isOwnShare(removalSubject.value))
const selfLowering = ref(null) as Ref<{share: Identified<Share>, permission: Permission} | null>
// Kept after closing so the dialog title doesn't blank during its fade-out.
const loweringLabel = ref('')

function isOwnShare(share: Identified<Share>) {
	return props.isSelf?.(share) ?? false
}

watch(identifiedShares, shares => {
	selectedPermission.value = Object.fromEntries(shares.map(share => [share.id, normalizeSharePermission(share.permission)]))
}, {immediate: true})
watch(() => props.project.id, () => {
	selected.value = null
	search.value = ''
	shareToDelete.value = null
})

function openRemoval(share: Identified<Share>) {
	removalSubject.value = share
	shareToDelete.value = share
}

// Synchronous guards: isMutating only flips after the next render, too late for a double click.
let adding = false
let removing = false

async function addSelected() {
	const candidate = selected.value
	const projectId = props.project.id
	if (!candidate || props.isMutating || adding) return
	adding = true
	try {
		await props.add(projectId, candidate)
	} catch {
		return
	} finally {
		adding = false
	}
	if (props.project.id === projectId && selected.value === candidate) {
		selected.value = null
		search.value = ''
	}
}

function currentPermission(share: Identified<Share>) {
	return normalizeSharePermission(identifiedShares.value.find(item => item.id === share.id)?.permission)
}

async function changePermission(share: Identified<Share>) {
	const permission = normalizeSharePermission(selectedPermission.value[share.id])
	if (isOwnShare(share) && permission < currentPermission(share)) {
		loweringLabel.value = t(sharePermissionKey(permission))
		selfLowering.value = {share, permission}
		return
	}
	await applyPermission(share)
}

function cancelLowering() {
	const lowering = selfLowering.value
	selfLowering.value = null
	if (lowering) selectedPermission.value[lowering.share.id] = currentPermission(lowering.share)
}

async function confirmLowering() {
	const lowering = selfLowering.value
	if (!lowering) return
	await applyPermission(lowering.share)
	if (selfLowering.value === lowering) selfLowering.value = null
}

async function applyPermission(share: Identified<Share>) {
	const projectId = props.project.id
	if (!props.isMutating) {
		await props.updatePermission(projectId, share, normalizeSharePermission(selectedPermission.value[share.id])).catch(() => {})
	}
	if (props.project.id === projectId) {
		selectedPermission.value[share.id] = normalizeSharePermission(identifiedShares.value.find(item => item.id === share.id)?.permission)
	}
}

// The dialog stays open on failure: the toast says what went wrong and the person can retry or cancel.
async function removeShare() {
	const share = shareToDelete.value
	if (!share || props.isMutating || removing) return
	removing = true
	try {
		await props.remove(props.project.id, share)
	} catch {
		return
	} finally {
		removing = false
	}
	if (shareToDelete.value === share) shareToDelete.value = null
	if (isOwnShare(share)) emit('removedSelf')
}
</script>

<style lang="scss" scoped>
// The share dialog wraps everything in a Bulma .content card; the root class keeps these rules ahead of it.
.sharing-section {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;

	&:not(:first-child) {
		padding-block-start: var(--space-5);
		border-block-start: 1px solid var(--border-subtle);
	}

	.sharing-title {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-tight);
	}

	.sharing-add {
		margin: 0;
	}

	.sharing-empty {
		margin: 0;
		color: var(--text-tertiary);
		font-size: var(--text-sm);
	}

	:deep(.sharing-help) {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.sharing-skeleton {
	display: grid;
	gap: var(--space-2);
}

.sharing-skeleton__row {
	block-size: 1.5rem;
	inline-size: 45%;
	border-radius: var(--radius-xs);
	background: var(--surface-active);

	&:nth-child(2n) {
		inline-size: 30%;
	}
}

.sharing-section .sharing-table {
	inline-size: 100%;
	margin: 0;
	border-collapse: collapse;
	background: transparent;

	th {
		padding: 0;
		border: 0;
	}

	td {
		padding: var(--space-2) var(--space-1);
		border: 0;
		border-block-start: 1px solid var(--border-subtle);
		color: var(--text-primary);
		vertical-align: middle;
	}

	td.type {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	td.actions {
		inline-size: 1%;
		padding-inline-end: 0;
		white-space: nowrap;
	}

	// The permission select already shows the level to admins; phones keep the row to one line.
	@media screen and (width <= 480px) {
		&.is-admin .type {
			display: none;
		}
	}
}

.sharing-permission {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.sharing-row-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-1);
}
</style>
