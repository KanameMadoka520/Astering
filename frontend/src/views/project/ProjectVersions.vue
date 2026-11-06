<template>
	<div class="project-versions">
		<PageHeader
			:title="t('projectVersions.title')"
			:description="project?.title"
		>
			<template #actions>
				<XButton
					:to="{name: 'project.index', params: {projectId}}"
					variant="secondary"
				>
					{{ t('projectVersions.backToProject') }}
				</XButton>
				<XButton
					v-if="canWrite"
					icon="plus"
					data-cy="version-save"
					@click="openSave"
				>
					{{ t('projectVersions.save') }}
				</XButton>
			</template>
		</PageHeader>
		<p class="project-versions__help">
			{{ t('projectVersions.help') }}
		</p>
		<LoadError
			v-if="projectError"
			:retry="() => refetchProject()"
		/>
		<p
			v-else-if="!project"
			role="status"
		>
			{{ t('misc.loading') }}
		</p>
		<template v-else>
			<Message
				v-if="outcome"
				variant="success"
				role="status"
			>
				{{ outcome }}
			</Message>
			<div
				class="project-versions__layout"
				:class="{'has-selection': selected > 0}"
			>
				<section
					class="project-versions__list"
					:aria-label="t('projectVersions.savedPoints')"
				>
					<h2
						ref="listHeading"
						tabindex="-1"
					>
						{{ t('projectVersions.savedPoints') }}
					</h2>
					<LoadError
						v-if="listError"
						:retry="() => refetchList()"
					/>
					<p
						v-else-if="listPending"
						role="status"
					>
						{{ t('misc.loading') }}
					</p>
					<EmptyState
						v-else-if="!versions?.items.length"
						:title="t('projectVersions.empty')"
						:description="t('projectVersions.emptyHelp')"
					/>
					<ol
						v-else
						class="project-versions__points"
					>
						<li
							v-for="version in versions.items"
							:key="version.id"
						>
							<RouterLink
								:to="selectionRoute(version.id)"
								:aria-current="selected === version.id ? 'page' : undefined"
								data-cy="version-point"
							>
								<strong>{{ version.name }}</strong>
								<span>{{ t(`projectVersions.kinds.${version.kind}`) }} · #{{ version.sequence }}</span>
								<time :datetime="version.created">{{ formatDateLong(version.created) }}</time>
								<span>{{ version.created_by.name || version.created_by.username }}</span>
							</RouterLink>
						</li>
					</ol>
					<Pagination
						:total-pages="versions?.total_pages ?? 0"
						:current-page="page"
					/>
				</section>
				<section
					v-if="selected > 0"
					class="project-versions__detail"
					:aria-label="t('projectVersions.preview')"
				>
					<XButton
						class="project-versions__mobile-back"
						variant="secondary"
						:to="selectionRoute(0)"
					>
						{{ t('projectVersions.savedPoints') }}
					</XButton>
					<LoadError
						v-if="detailError"
						:retry="() => refetchDetail()"
					/>
					<p
						v-else-if="!selectedVersion"
						role="status"
					>
						{{ t('misc.loading') }}
					</p>
					<template v-else>
						<h2
							ref="detailHeading"
							tabindex="-1"
						>
							{{ selectedVersion.name }}
						</h2>
						<p class="project-versions__meta">
							{{ formatDateLong(selectedVersion.created) }} ·
							{{ t('projectVersions.counts', {
								tasks: selectedVersion.task_count,
								views: selectedVersion.view_count,
								attachments: selectedVersion.attachment_count,
							}) }}
						</p>
						<p class="project-versions__meta">
							{{ t('projectVersions.retention') }}
						</p>
						<div class="project-versions__actions">
							<XButton
								v-if="canAdmin"
								:aria-disabled="!restoreAllowed || undefined"
								data-cy="version-restore"
								@click="openRestore"
							>
								{{ t('projectVersions.restore') }}
							</XButton>
							<XButton
								v-if="canAdmin"
								variant="tertiary"
								@click="openDelete"
							>
								{{ t('projectVersions.delete') }}
							</XButton>
						</div>
						<Message
							v-if="project.is_archived"
							variant="warning"
						>
							{{ t('projectVersions.archived') }}
						</Message>
						<p
							v-else-if="!canAdmin"
							class="project-versions__meta"
						>
							{{ t('projectVersions.adminOnly') }}
						</p>
						<div
							class="project-versions__tabs"
							role="group"
							:aria-label="t('projectVersions.display')"
						>
							<XButton
								variant="secondary"
								:aria-pressed="!browseContent"
								@click="browseContent = false"
							>
								{{ t('projectVersions.preview') }}
							</XButton>
							<XButton
								variant="secondary"
								:aria-pressed="browseContent"
								@click="browseContent = true"
							>
								{{ t('projectVersions.browseContent') }}
							</XButton>
						</div>
						<template v-if="!browseContent">
							<LoadError
								v-if="previewError"
								:retry="() => refetchPreview()"
							/>
							<p
								v-else-if="!preview"
								role="status"
							>
								{{ t('projectVersions.loadingPreview') }}
							</p>
							<template v-else>
								<p>{{ t('projectVersions.preserved', preview.preserved) }}</p>
								<Message
									v-if="preview.conflicts?.length"
									variant="warning"
									role="alert"
								>
									<p>{{ t('projectVersions.conflicts') }}</p>
									<ul>
										<li
											v-for="conflict in preview.conflicts"
											:key="`${conflict.kind}:${conflict.entity_id}`"
										>
											{{ projectVersionConflictText(conflict.code) }}
											<details v-if="conflict.message && !te(`projectVersions.errors.${conflict.code}`)">
												<summary>{{ t('projectVersions.serverDetails') }}</summary>
												<p>{{ conflict.message }}</p>
											</details>
										</li>
									</ul>
								</Message>
								<p
									v-if="preview.changes.total === 0"
									class="project-versions__identical"
								>
									{{ t('projectVersions.identical') }}
								</p>
								<p v-else>
									{{ t('projectVersions.changeCount', {count: preview.changes.total}) }}
								</p>
							</template>
						</template>
						<template v-else>
							<LoadError
								v-if="entitiesError"
								:retry="() => refetchEntities()"
							/>
							<p
								v-else-if="entitiesPending"
								role="status"
							>
								{{ t('misc.loading') }}
							</p>
						</template>
						<ul class="project-versions__changes">
							<li
								v-for="change in displayedEntities"
								:key="`${selected}:${change.kind}:${change.entity_id}`"
							>
								<details @toggle="event => toggleEntity(event, change.kind, change.entity_id)">
									<summary>
										<span>{{ t(`projectVersions.entities.${change.kind}`) }}</span>
										<strong>{{ change.title || `#${change.entity_id}` }}</strong>
										<span v-if="'operation' in change">{{ t(`projectVersions.operations.${change.operation}`) }}</span>
									</summary>
									<ProjectVersionEntity
										v-if="openedEntities.has(`${change.kind}:${change.entity_id}`)"
										:project="projectId"
										:version="selected"
										:kind="change.kind"
										:entity="change.entity_id"
										:changed-fields="'fields' in change ? change.fields : undefined"
									/>
								</details>
							</li>
						</ul>
						<nav
							v-if="contentPages > 1"
							class="project-versions__actions"
							:aria-label="t('projectVersions.contentPages')"
						>
							<XButton
								variant="secondary"
								:aria-disabled="contentPage <= 1"
								@click="setContentPage(contentPage - 1)"
							>
								{{ t('misc.previous') }}
							</XButton>
							<span>{{ contentPage }} / {{ contentPages }}</span>
							<XButton
								variant="secondary"
								:aria-disabled="contentPage >= contentPages"
								@click="setContentPage(contentPage + 1)"
							>
								{{ t('misc.next') }}
							</XButton>
						</nav>
					</template>
				</section>
				<EmptyState
					v-else
					class="project-versions__choose"
					:title="t('projectVersions.choose')"
				/>
			</div>
		</template>
		<Modal
			:enabled="dialog !== null"
			:loading="busy"
			:aria-label="dialogTitle"
			@close="closeDialog"
		>
			<Card
				:title="dialogTitle"
				:show-close="true"
				:shadow="false"
				@close="closeDialog"
			>
				<form
					v-if="dialog === 'save'"
					id="version-save-form"
					@submit.prevent="confirmSave"
				>
					<p>{{ t('projectVersions.saveHelp') }}</p>
					<label for="version-name">{{ t('projectVersions.name') }}</label>
					<input
						id="version-name"
						v-model="name"
						class="input"
						maxlength="160"
						:readonly="busy"
						autocomplete="off"
						autofocus
					>
				</form>
				<template v-else-if="dialog === 'restore' && dialogVersion">
					<p><strong>{{ project?.title }} — {{ dialogVersion.name }}</strong></p>
					<p>{{ t('projectVersions.restoreHelp') }}</p>
					<p>{{ t('projectVersions.restoreKeeps') }}</p>
					<p>{{ t('projectVersions.restoreDrafts') }}</p>
				</template>
				<template v-else-if="dialog === 'delete' && dialogVersion">
					<p>{{ t('projectVersions.deleteHelp', {name: dialogVersion.name}) }}</p>
					<label for="version-delete-name">{{ t('projectVersions.confirmName') }}</label>
					<input
						id="version-delete-name"
						v-model="deleteName"
						:readonly="busy"
						class="input"
						autocomplete="off"
					>
				</template>
				<p
					v-if="busy"
					role="status"
				>
					{{ t(dialog === 'restore' ? 'projectVersions.restoring' : 'misc.saving') }}
				</p>
				<Message
					v-if="failure"
					variant="danger"
					role="alert"
				>
					{{ failure }}
				</Message>
				<template #footer>
					<XButton
						variant="secondary"
						:aria-disabled="busy"
						@click="closeDialog"
					>
						{{ t('misc.cancel') }}
					</XButton>
					<XButton
						:aria-disabled="busy || !canConfirm"
						:loading="busy"
						@click="confirmDialog"
					>
						{{ dialogTitle }}
					</XButton>
				</template>
			</Card>
		</Modal>
		<Modal
			:enabled="leaveTarget !== null"
			@close="stay"
			@submit="discardAndLeave"
		>
			<template #header>
				{{ t('projectVersions.unsavedTitle') }}
			</template>
			<template #text>
				{{ t('projectVersions.unsavedHelp') }}
			</template>
		</Modal>
	</div>
</template>

<script setup lang="ts">
import {
	computed,
	nextTick,
	ref,
	watch,
} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {
	useRoute,
	useRouter,
} from 'vue-router'
import {useMediaQuery} from '@vueuse/core'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import Message from '@/components/misc/Message.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import EmptyState from '@/components/misc/state/EmptyState.vue'
import ProjectVersionEntity from '@/components/project/versions/ProjectVersionEntity.vue'
import {projectQuery} from '@/client/queries/projects'
import {
	projectVersionsQuery,
	projectVersionQuery,
	projectVersionPreviewQuery,
	projectVersionEntitiesQuery,
	projectVersionConflictText,
	projectVersionErrorText,
	useCreateProjectVersionMutation,
	useRestoreProjectVersionMutation,
	useDeleteProjectVersionMutation,
	type ProjectVersion,
	type ProjectVersionPreview,
} from '@/client/queries/projectVersions'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {ApiError} from '@/client/problem'
import {PERMISSIONS} from '@/constants/permissions'
import {useBaseStore} from '@/stores/base'
import {useTitle} from '@/composables/useTitle'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
import {formatDateLong} from '@/helpers/time/formatDate'

const {
	t, te,
} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const baseStore = useBaseStore()
const owner = captureClientRequestContext()
const mobile = useMediaQuery('(max-width: 767px)')
const projectId = computed(() => Number(route.params.projectId))
const page = computed(() => positive(route.query.page))
const selected = computed(() => positive(route.query.version, 0))
const contentPage = ref(1)
const browseContent = ref(false)
const openedEntities = ref(new Set<string>())
const listHeading = ref<HTMLElement>()
const detailHeading = ref<HTMLElement>()
const {
	data: project, isError: projectError, refetch: refetchProject,
} = useQuery(computed(() => ({
	...projectQuery(projectId.value),
	meta: {handlesError: true},
})))
const canWrite = computed(() => (project.value?.max_permission ?? -1) >= PERMISSIONS.READ_WRITE)
const canAdmin = computed(() => project.value?.max_permission === PERMISSIONS.ADMIN)
const {
	data: versions, isPending: listPending, isError: listError, refetch: refetchList,
} = useQuery(computed(() => ({
	...projectVersionsQuery(projectId.value, page.value),
	enabled: !!project.value,
})))
const {
	data: selectedVersion, isError: detailError, refetch: refetchDetail,
} = useQuery(computed(() =>
	projectVersionQuery(projectId.value, selected.value),
))
const {
	data: preview, isError: previewError, isFetching: previewFetching, refetch: refetchPreview,
} = useQuery(computed(() =>
	projectVersionPreviewQuery(projectId.value, selected.value, contentPage.value),
))
const {
	data: entities, isPending: entitiesPending, isError: entitiesError, refetch: refetchEntities,
} = useQuery(computed(() =>
	projectVersionEntitiesQuery(projectId.value, selected.value, contentPage.value, browseContent.value),
))
const restoreAllowed = computed(() => canAdmin.value && !project.value?.is_archived
	&& !previewError.value && !previewFetching.value && preview.value?.can_restore)
const displayedEntities = computed(() => browseContent.value ? entities.value?.items ?? [] : preview.value?.changes.items ?? [])
const contentPages = computed(() => browseContent.value ? entities.value?.total_pages ?? 0 : preview.value?.changes.total_pages ?? 0)
const dialog = ref<'save' | 'restore' | 'delete' | null>(null)
const dialogVersion = ref<ProjectVersion>()
const dialogPreview = ref<ProjectVersionPreview>()
const dialogProject = ref(0)
const dialogRoute = ref('')
const requestId = ref('')
const name = ref('')
const deleteName = ref('')
const failure = ref('')
const outcome = ref('')
const create = useCreateProjectVersionMutation(owner)
const restore = useRestoreProjectVersionMutation(owner)
const remove = useDeleteProjectVersionMutation(owner)
const busy = computed(() => create.isPending.value || restore.isPending.value || remove.isPending.value)
const dialogTitle = computed(() => dialog.value ? t(`projectVersions.${dialog.value}`) : '')
const canConfirm = computed(() => dialog.value === 'save'
	? canWrite.value && name.value.trim() !== ''
	: dialog.value === 'restore'
		? canAdmin.value && !project.value?.is_archived && !!dialogPreview.value?.can_restore
		: canAdmin.value && deleteName.value === dialogVersion.value?.name)
const {
	leaveTarget, stay, discardAndLeave,
} = useUnsavedLeaveGuard(computed(() =>
	dialog.value === 'save' && name.value.trim() !== '',
))
useTitle(computed(() => `${t('projectVersions.title')} — ${project.value?.title ?? ''}`))

watch(project, value => {
	if (value && route.name === 'project.versions') baseStore.setCurrentProject(value)
}, {immediate: true})
watch([projectId, selected, browseContent], async () => {
	contentPage.value = 1
	openedEntities.value = new Set()
	if (!busy.value) dialog.value = null
	await nextTick()
	if (mobile.value) (selected.value > 0 ? detailHeading.value : listHeading.value)?.focus()
})
watch(selectedVersion, async value => {
	if (!value || !mobile.value) return
	await nextTick()
	detailHeading.value?.focus()
})
watch([versions, dialog], ([value, open]) => {
	if (open !== null || !value || page.value <= Math.max(1, value.total_pages)) return
	void router.replace({
		query: {
			...route.query,
			page: Math.max(1, value.total_pages),
		},
	})
})
watch(busy, pending => {
	if (!pending && dialog.value !== null && route.fullPath !== dialogRoute.value) dialog.value = null
})
watch(name, () => {
	if (dialog.value === 'save' && !busy.value) requestId.value = crypto.randomUUID()
})

function positive(value: unknown, fallback = 1) {
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
function selectionRoute(version: number) {
	return {
		name: 'project.versions',
		params: {projectId: projectId.value},
		query: {
			...route.query,
			version: version || undefined,
		},
	}
}
function toggleEntity(event: Event, kind: string, entity: string) {
	const next = new Set(openedEntities.value)
	const key = `${kind}:${entity}`
	if ((event.target as HTMLDetailsElement).open) next.add(key)
	else next.delete(key)
	openedEntities.value = next
}
function setContentPage(value: number) {
	if (value < 1 || value > contentPages.value) return
	contentPage.value = value
	openedEntities.value = new Set()
}
function prepareDialog(type: 'save' | 'restore' | 'delete') {
	if (busy.value) return
	dialogProject.value = projectId.value
	dialogRoute.value = route.fullPath
	dialogVersion.value = selectedVersion.value
	dialogPreview.value = preview.value
	requestId.value = crypto.randomUUID()
	failure.value = ''
	deleteName.value = ''
	dialog.value = type
}
function openSave() {
	if (!canWrite.value) return
	prepareDialog('save')
}
function openRestore() {
	if (!restoreAllowed.value) return
	prepareDialog('restore')
}
function openDelete() {
	if (!canAdmin.value || !selectedVersion.value) return
	prepareDialog('delete')
}
function closeDialog() {
	if (busy.value) return
	dialog.value = null
}
function currentTarget(type: string, target: number) {
	return isClientRequestContextCurrent(owner) && dialog.value === type && dialogProject.value === target
		&& projectId.value === target && route.fullPath === dialogRoute.value
}
function showFailure(cause: unknown) {
	if (isRequestContextAbort(cause)) return
	if (cause instanceof ApiError && cause.status === 409) {
		failure.value = cause.detail === 'project_version_stale_preview'
			? t('projectVersions.stale') : projectVersionErrorText(cause)
		if (dialog.value === 'restore') dialogPreview.value = undefined
		void refetchPreview()
	} else if (cause instanceof ApiError && cause.status === 403) {
		failure.value = t('projectVersions.permissionChanged')
		void refetchProject()
	} else {
		failure.value = projectVersionErrorText(cause)
	}
}
async function confirmSave() {
	if (busy.value || !canConfirm.value || dialog.value !== 'save') return
	const target = dialogProject.value
	failure.value = ''
	try {
		const saved = await create.mutateAsync({
			project: target,
			name: name.value.trim(),
			requestId: requestId.value,
		})
		if (!currentTarget('save', target)) return
		dialog.value = null
		name.value = ''
		outcome.value = t('projectVersions.saved')
		await router.replace({
			...selectionRoute(saved.id),
			query: {version: saved.id},
		})
	} catch (cause) {
		if (currentTarget('save', target)) showFailure(cause)
	}
}
async function confirmDialog() {
	if (busy.value || !canConfirm.value) return
	if (dialog.value === 'save') return confirmSave()
	const type = dialog.value
	const target = dialogProject.value
	const version = dialogVersion.value
	if (!type || !version) return
	failure.value = ''
	try {
		if (type === 'restore') {
			const plan = dialogPreview.value
			if (!plan) return
			const restored = await restore.mutateAsync({
				project: target,
				version: version.id,
				currentHash: plan.current_hash,
				planHash: plan.plan_hash,
				requestId: requestId.value,
			})
			if (!currentTarget(type, target)) return
			outcome.value = t('projectVersions.restored', {before: restored.before_version_id})
		} else {
			await remove.mutateAsync({
				project: target,
				version: version.id,
				confirmName: deleteName.value,
			})
			if (!currentTarget(type, target)) return
			outcome.value = t('projectVersions.deleted')
			await router.replace(selectionRoute(0))
		}
		dialog.value = null
	} catch (cause) {
		if (currentTarget(type, target)) showFailure(cause)
	}
}
</script>

<style scoped lang="scss">
.project-versions {
	max-inline-size: 90rem;
	margin-inline: auto;
	padding: var(--space-4);

	h2 {
		margin-block: var(--space-3);
		overflow-wrap: anywhere;
	}
	p {
		margin-block-end: var(--space-3);
	}
}

.project-versions__help, .project-versions__meta {
	color: var(--text-secondary);
}
.project-versions__layout {
	display: grid;
	grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr);
	gap: var(--space-5);
}
.project-versions__list, .project-versions__detail {
	min-inline-size: 0;
}
.project-versions__points, .project-versions__changes {
	list-style: none;
	margin: 0;
	padding: 0;
}
.project-versions__points a {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	margin-block-end: var(--space-2);
	overflow-wrap: anywhere;
	color: var(--text-primary);

	span, time {
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
	&[aria-current] {
		border-color: var(--primary);
		background: var(--tint-primary);
	}
}
.project-versions__actions, .project-versions__tabs {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin-block: var(--space-4);
}
.project-versions__changes li {
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	margin-block-end: var(--space-2);
	overflow: hidden;
}
.project-versions__changes summary {
	cursor: pointer;
	padding: var(--space-3);
	overflow-wrap: anywhere;
	min-block-size: 2.75rem;
}
.project-versions__changes summary span {
	margin-inline: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.project-versions__mobile-back {
	display: none;
}
.project-versions__identical {
	padding: var(--space-4);
	background: var(--surface);
	border-radius: var(--radius-md);
}

@media (width <= 767px) {
	.project-versions {
		padding: var(--space-2);
	}
	.project-versions__layout {
		grid-template-columns: minmax(0, 1fr);
	}
	.project-versions__choose, .has-selection > .project-versions__list {
		display: none;
	}
	.project-versions__mobile-back {
		display: inline-flex;
	}
}
</style>
