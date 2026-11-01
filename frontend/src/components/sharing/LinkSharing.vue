<template>
	<section class="sharing-section">
		<h3 class="sharing-title">
			{{ $t('project.share.links.title') }}
		</h3>
		<p class="sharing-description">
			{{ $t('project.share.links.explanation') }}
			<template v-if="hasSubprojects">
				{{ $t('project.share.links.onlyThisProject') }}
			</template>
		</p>

		<div class="sharables-project">
			<XButton
				v-if="!showNewForm"
				variant="secondary"
				icon="plus"
				:shadow="false"
				class="link-share-create"
				@click="showNewForm = true"
			>
				{{ $t('project.share.links.create') }}
			</XButton>

			<form
				v-else
				class="link-share-form"
				@submit.prevent="add(project.id)"
			>
				<div class="link-share-fields">
					<div class="link-share-field">
						<FormField :label="$t('project.share.permission.title')">
							<template #default="{ id }">
								<div class="select">
									<select
										:id="id"
										v-model="draft.permission"
										:aria-describedby="draft.permission === PERMISSIONS.ADMIN ? adminHelpId : undefined"
									>
										<option :value="PERMISSIONS.READ">
											{{ $t('project.share.permission.read') }}
										</option>
										<option :value="PERMISSIONS.READ_WRITE">
											{{ $t('project.share.permission.readWrite') }}
										</option>
										<option :value="PERMISSIONS.ADMIN">
											{{ $t('project.share.permission.admin') }}
										</option>
									</select>
								</div>
							</template>
						</FormField>
						<p
							v-if="draft.permission === PERMISSIONS.ADMIN"
							:id="adminHelpId"
							class="help link-share-admin-warning"
						>
							<Icon
								icon="exclamation-circle"
								aria-hidden="true"
							/>
							{{ $t('project.share.links.adminWarning') }}
						</p>
					</div>
					<div class="link-share-field">
						<FormField
							id="linkShareName"
							v-model="draft.name"
							:label="$t('project.share.links.name')"
							:placeholder="$t('project.share.links.namePlaceholder')"
							:aria-describedby="nameHelpId"
						/>
						<p
							:id="nameHelpId"
							class="help"
						>
							{{ $t('project.share.links.nameExplanation') }}
						</p>
					</div>
					<div class="link-share-field">
						<FormField
							id="linkSharePassword"
							v-model="draft.password"
							:label="$t('project.share.links.password')"
							type="password"
							:placeholder="$t('user.auth.passwordPlaceholder')"
							autocomplete="new-password"
							:aria-describedby="passwordHelpId"
						/>
						<p
							:id="passwordHelpId"
							class="help"
						>
							{{ $t('project.share.links.passwordExplanation') }}
						</p>
					</div>
				</div>
				<div class="link-share-form-actions">
					<XButton
						variant="tertiary"
						:shadow="false"
						@click="closeForm"
					>
						{{ $t('misc.cancel') }}
					</XButton>
					<XButton
						type="submit"
						icon="plus"
						:shadow="false"
						:loading="isMutating"
						:disabled="isMutating"
					>
						{{ $t('project.share.share') }}
					</XButton>
				</div>
			</form>

			<div
				v-if="linkShares.length > 0"
				class="has-horizontal-overflow"
				:aria-busy="sharesQuery.isFetching.value || undefined"
			>
				<table class="sharing-table">
					<thead>
						<tr>
							<th>
								<span class="is-sr-only">{{ $t('project.share.attributes.link') }}</span>
							</th>
							<th>
								<span class="is-sr-only">{{ $t('project.share.attributes.delete') }}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="s in linkShares"
							:key="s.id"
						>
							<td>
								<div class="link-share-cell">
									<p
										class="link-share-name"
										:class="{'is-unnamed': s.name === ''}"
									>
										{{ s.name !== '' ? s.name : $t('project.share.links.noName') }}
									</p>
									<p class="link-share-meta">
										<span class="link-share-permission">
											<Icon :icon="permissionIcon(s.permission)" />
											{{ permissionLabel(s.permission) }}
										</span>
										<!-- Only the two types the server reports for certain; an unknown type claims nothing. -->
										<span
											v-if="s.sharing_type === SHARING_TYPE.WITH_PASSWORD || s.sharing_type === SHARING_TYPE.WITHOUT_PASSWORD"
											class="link-share-password"
										>
											<Icon :icon="s.sharing_type === SHARING_TYPE.WITH_PASSWORD ? 'lock' : 'globe'" />
											{{ s.sharing_type === SHARING_TYPE.WITH_PASSWORD ? $t('project.share.links.passwordProtected') : $t('project.share.links.noPassword') }}
										</span>
										<span>
											<i18n-t
												keypath="project.share.links.sharedBy"
												scope="global"
											>
												<strong>{{ getDisplayName(s.shared_by) }}</strong>
											</i18n-t>
										</span>
									</p>
									<div class="link-share-controls">
										<div
											v-if="availableViews.length > 0"
											class="select link-share-view"
										>
											<select
												:value="selectedViews[s.id]"
												:aria-label="$t('project.share.links.view')"
												@change="pickedViews[s.id] = Number(($event.target as HTMLSelectElement).value)"
											>
												<option
													v-for="(view) in availableViews"
													:key="view.id"
													:value="view.id"
												>
													{{ view.title }}
												</option>
											</select>
										</div>
										<div class="link-share-url">
											<FormField
												:model-value="shareLinks[s.id]"
												readonly
												type="text"
												:aria-label="$t('project.share.attributes.link')"
												@focus="selectAll"
											>
												<template #addon>
													<XButton
														v-tooltip="$t('misc.copy')"
														variant="secondary"
														icon="copy"
														icon-only
														:shadow="false"
														@click="copy(shareLinks[s.id])"
													>
														{{ $t('misc.copy') }}
													</XButton>
												</template>
											</FormField>
										</div>
									</div>
								</div>
							</td>
							<td class="actions">
								<XButton
									variant="tertiary"
									danger
									icon="trash-alt"
									:shadow="false"
									:aria-label="$t('project.share.links.remove')"
									@click="openRemoval(s)"
								/>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<!-- Rows from an earlier load stay, but they may be out of date. -->
			<LoadError
				v-if="linkShares.length > 0 && sharesStatus === 'error'"
				:message="$t('project.share.refreshError')"
				:retry="() => sharesQuery.refetch()"
			/>
			<div
				v-else-if="linkShares.length === 0 && sharesStatus === 'pending'"
				class="link-share-skeleton"
				role="status"
			>
				<span class="is-sr-only">{{ $t('project.share.links.loading') }}</span>
				<span
					class="link-share-skeleton__row"
					aria-hidden="true"
				/>
			</div>
			<LoadError
				v-else-if="linkShares.length === 0 && sharesStatus === 'error'"
				:message="$t('project.share.links.loadError')"
				:retry="() => sharesQuery.refetch()"
			/>
			<p
				v-else-if="linkShares.length === 0"
				class="link-share-empty"
			>
				{{ $t('project.share.links.empty') }}
			</p>
		</div>

		<Modal
			:enabled="shareToDelete !== null"
			:loading="deleteMutation.isPending.value"
			:confirm-label="$t('project.share.links.removeConfirm')"
			danger
			@close="shareToDelete = null"
			@submit="remove()"
		>
			<template #header>
				<span>{{ removalTitle }}</span>
			</template>

			<template #text>
				<p>{{ $t('project.share.links.removeText', {project: project.title}) }}</p>
			</template>
		</Modal>
	</section>
</template>

<script setup lang="ts">
import {ref, watch, computed, useId, type Ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'
import type {LinkSharing} from '@/client/generated'
import {linkSharesQuery, createLinkShareDraft, useCreateLinkShareMutation, useDeleteLinkShareMutation} from '@/client/queries/linkShares'
import type {ProjectResponse} from '@/client/queries/projects'
import {PERMISSIONS} from '@/constants/permissions'
import FormField from '@/components/input/FormField.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {sharePermissionIcon as permissionIcon, sharePermissionKey} from '@/components/sharing/sharePermission'
import {queryStatus} from '@/components/sharing/useProjectAccess'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import {getDisplayName} from '@/helpers/user'
import {useConfigStore} from '@/stores/config'
import {useProjectViews} from '@/composables/useProjectViews'

const props = withDefaults(defineProps<{
	project: ProjectResponse
	hasSubprojects?: boolean
}>(), {hasSubprojects: false})
const {t} = useI18n({useScope: 'global'})
const projectId = computed(() => props.project.id)
const sharesQuery = useQuery(computed(() => ({...linkSharesQuery(projectId.value), enabled: projectId.value > 0})))
const sharesStatus = computed(() => queryStatus(sharesQuery.data.value, sharesQuery.isError.value, sharesQuery.isFetching.value))
type VisibleShare = LinkSharing & Required<Pick<LinkSharing, 'id' | 'hash'>>
const linkShares = computed(() => (sharesQuery.data.value ?? []).filter((share): share is VisibleShare => typeof share.id === 'number' && typeof share.hash === 'string'))
const createMutation = useCreateLinkShareMutation()
const deleteMutation = useDeleteLinkShareMutation()
const isMutating = computed(() => createMutation.isPending.value || deleteMutation.isPending.value)
const draft = ref(createLinkShareDraft())
const shareToDelete = ref(null) as Ref<VisibleShare | null>
// Kept after closing so the dialog title doesn't blank during its fade-out.
const removalSubject = ref(null) as Ref<VisibleShare | null>
const removalTitle = computed(() => {
	const share = removalSubject.value
	if (!share) return ''
	return share.name
		? t('project.share.links.removeHeader', {name: share.name})
		: t('project.share.links.removeHeaderUnnamed', {permission: t(sharePermissionKey(share.permission))})
})
const showNewForm = ref(false)
const {views: availableViews} = useProjectViews(projectId)
const copy = useCopyToClipboard()
const pickedViews = ref<Record<number, number>>({})
const configStore = useConfigStore()
const nameHelpId = useId()
const passwordHelpId = useId()
const adminHelpId = useId()
// LinkSharing.sharing_type, from the generated API docs.
const SHARING_TYPE = {WITHOUT_PASSWORD: 1, WITH_PASSWORD: 2} as const

watch(projectId, () => {
	draft.value = createLinkShareDraft()
	showNewForm.value = false
	shareToDelete.value = null
}, {flush: 'sync'})

function closeForm() {
	draft.value = createLinkShareDraft()
	showNewForm.value = false
}

// Synchronous guards: isPending only flips after the next render, too late for a double click.
let adding = false
let removing = false

async function add(targetProjectId: number) {
	if (targetProjectId <= 0 || isMutating.value || adding) return
	adding = true
	try {
		await createMutation.mutateAsync({projectId: targetProjectId, share: draft.value})
	} catch {
		return
	} finally {
		adding = false
	}
	if (projectId.value === targetProjectId) {
		draft.value = createLinkShareDraft()
		showNewForm.value = false
	}
}

function openRemoval(share: VisibleShare) {
	removalSubject.value = share
	shareToDelete.value = share
}

// The dialog stays open on failure: the toast says what went wrong and the link can be removed again or kept.
async function remove() {
	const share = shareToDelete.value
	if (!share || isMutating.value || removing) return
	removing = true
	try {
		await deleteMutation.mutateAsync({projectId: projectId.value, id: share.id})
	} catch {
		return
	} finally {
		removing = false
	}
	if (shareToDelete.value === share) shareToDelete.value = null
}

function permissionLabel(permission?: number) {
	return t(sharePermissionKey(permission))
}

// A focused read-only link is selected whole, so it can be copied by hand when the clipboard API is unavailable.
function selectAll(event: FocusEvent) {
	(event.target as HTMLInputElement).select()
}

const selectedViews = computed(() => {
	const viewIds = availableViews.value.flatMap(view => view.id === undefined ? [] : [view.id])
	return Object.fromEntries(linkShares.value.map(share => {
		const picked = pickedViews.value[share.id]
		return [share.id, picked !== undefined && viewIds.includes(picked) ? picked : viewIds[0] ?? null]
	}))
})

const shareLinks = computed(() => Object.fromEntries(linkShares.value.map(share => {
	const viewId = selectedViews.value[share.id]
	return [share.id, `${configStore.frontend_url}share/${share.hash}/auth${viewId ? `?view=${viewId}` : ''}`]
})))
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

	.sharing-description,
	.help {
		margin: 0;
	}

	.sharing-description {
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.sharables-project {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
}

.link-share-create {
	justify-self: start;
}

.sharing-section .link-share-empty {
	margin: 0;
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.link-share-skeleton__row {
	display: block;
	block-size: 2.5rem;
	inline-size: 60%;
	border-radius: var(--radius-xs);
	background: var(--surface-active);
}

.link-share-form {
	display: grid;
	gap: var(--space-3);
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);

	:deep(.field) {
		margin-block-end: 0;
	}

	.select,
	select {
		inline-size: 100%;
	}
}

.link-share-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
	gap: var(--space-3);
	align-items: start;
}

.link-share-field {
	display: grid;
	gap: var(--space-1);
}

.link-share-form-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-2);
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
		padding: var(--space-3) var(--space-1);
		border: 0;
		border-block-start: 1px solid var(--border-subtle);
		color: var(--text-primary);
		vertical-align: top;
	}

	td.actions {
		inline-size: 1%;
		padding-inline-end: 0;
		text-align: end;
		white-space: nowrap;
	}
}

.link-share-cell {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
}

.sharing-section .link-share-name {
	margin: 0;
	font-weight: var(--weight-semibold);

	&.is-unnamed {
		color: var(--text-tertiary);
		font-style: italic;
		font-weight: var(--weight-regular);
	}
}

.sharing-section .link-share-meta {
	display: flex;
	margin: 0;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.link-share-permission,
.link-share-password {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
}

.sharing-section .link-share-admin-warning {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	margin-block-start: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-sm);
	background: var(--tint-warning);
	color: var(--text-primary);
}

.link-share-controls {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	min-inline-size: 0;

	:deep(.field) {
		margin-block-end: 0;
	}
}

.link-share-view {
	flex: 0 1 10rem;
	min-inline-size: 0;

	select {
		inline-size: 100%;
	}
}

.link-share-url {
	flex: 1 1 14rem;
	min-inline-size: 0;
}
</style>
