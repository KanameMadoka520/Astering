<template>
	<CreateEdit
		v-model:loading="loadingModel"
		:title="$t('project.edit.header')"
		primary-icon=""
		:primary-label="$t('misc.save')"
		:primary-disabled="Boolean(loadError)"
		:tertiary="project.max_permission === PERMISSIONS.ADMIN ? $t('misc.delete') : undefined"
		@primary="save"
		@tertiary="$router.push({ name: 'project.settings.delete', params: { projectId } })"
	>
		<ErrorMessage v-if="loadError" />
		<template v-else>
			<FormField
				id="title"
				v-model="project.title"
				v-focus
				:label="$t('project.title')"
				:disabled="isLoading"
				:placeholder="$t('project.edit.titlePlaceholder')"
				type="text"
				@keyup.enter="save"
			/>
			<FormField :label="$t('project.parent')">
				<ProjectSearch
					v-if="canMove"
					:model-value="parentProject"
					:filter="canBeParent"
					@update:modelValue="setParentProject"
				/>
				<p
					v-else-if="!hasHiddenParent"
					class="project-edit-parent"
				>
					{{ currentParent ? getProjectTitle(currentParent) : $t('project.parentAccess.noParent') }}
				</p>
			</FormField>
			<!-- Moving changes who can open the project: access comes with the parent chain (D4). -->
			<p
				v-if="hasHiddenParent && !parentProjectChanged"
				class="project-edit-parent-note"
			>
				{{ $t('project.parentAccess.hiddenParent') }}
			</p>
			<p
				v-if="!canMove && isLoaded"
				class="project-edit-parent-note"
			>
				{{ $t('project.parentAccess.adminOnly') }}
			</p>
			<ParentAccessNote
				v-if="parentProjectChanged"
				kind="move"
				:parent="parentProject"
				:previous-parent="currentParent"
				:descendant-count="descendants.length"
			/>
			<FormField :label="$t('project.edit.description')">
				<Editor
					id="projectdescription"
					v-model="project.description"
					:class="{ 'disabled': isLoading}"
					:disabled="isLoading"
					:placeholder="$t('project.edit.descriptionPlaceholder')"
				/>
			</FormField>

			<div class="project-edit-meta">
				<FormField
					id="identifier"
					v-model="project.identifier"
					v-tooltip="$t('project.edit.identifierTooltip')"
					:label="$t('project.edit.identifier')"
					:disabled="isLoading"
					:placeholder="$t('project.edit.identifierPlaceholder')"
					type="text"
					maxlength="10"
					@keyup.enter="save"
				/>

				<FormField :label="$t('project.edit.color')">
					<ColorPicker v-model="project.hex_color" />
				</FormField>
			</div>
		</template>
	</CreateEdit>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import Editor from '@/components/input/AsyncEditor'
import ColorPicker from '@/components/input/ColorPicker.vue'
import CreateEdit from '@/components/misc/CreateEdit.vue'
import FormField from '@/components/input/FormField.vue'
import ProjectSearch from '@/components/tasks/partials/ProjectSearch.vue'
import ErrorMessage from '@/components/misc/Error.vue'
import ParentAccessNote from '@/components/sharing/ParentAccessNote.vue'

import type {ProjectResponse} from '@/client/queries/projects'
import {useUpdateProjectMutation} from '@/client/queries/projects'

import {useBaseStore} from '@/stores/base'
import {useProjects} from '@/composables/useProjects'
import {useProject} from '@/composables/useProject'
import {useGoBack} from '@/composables/useGoBack'
import {useIsAlive} from '@/composables/useIsAlive'
import {getProjectTitle} from '@/helpers/getProjectTitle'
import {descendantProjects} from '@/helpers/projectAccess'

import {useTitle} from '@/composables/useTitle'
import {PERMISSIONS} from '@/constants/permissions'

const props = defineProps<{
	projectId: number,
}>()

defineOptions({name: 'ProjectSettingEdit'})

const goBack = useGoBack()
const projectList = useProjects()
const alive = useIsAlive()
// Taken during setup: a store first created after the await could not set itself up.
const baseStore = useBaseStore()

const {t} = useI18n({useScope: 'global'})

const {project, isLoaded, isLoading, error: loadError} = useProject(() => props.projectId)
const updateProject = useUpdateProjectMutation(t('project.edit.success'))

const parentProject = ref<ProjectResponse | null>(null)
const parentProjectChanged = ref(false)
const isSaving = ref(false)

const loadingModel = computed({
	get: () => isSaving.value || isLoading.value,
	set(value: boolean) {
		isSaving.value = value
	},
})
watch(
	() => [
		props.projectId,
		project.value.id,
		projectList.projects[project.value.parent_project_id],
	] as const,
	([projectId, loadedProjectId, parent], previous) => {
		if (projectId !== previous?.[0] || projectId !== loadedProjectId) {
			parentProjectChanged.value = false
			parentProject.value = null
		}
		if (projectId !== loadedProjectId) {
			return
		}
		if (!parentProjectChanged.value) {
			parentProject.value = parent ?? null
		}
	},
	{immediate: true},
)

// Moving needs admin on this project and write access on the new parent (backend UpdateProject / CanUpdate).
const canMove = computed(() => project.value.max_permission === PERMISSIONS.ADMIN)
const currentParent = computed(() => projectList.projects[project.value.parent_project_id] ?? null)
const hasHiddenParent = computed(() => isLoaded.value
	&& project.value.parent_project_id > 0
	&& !projectList.isLoading
	&& !currentParent.value)
const descendants = computed(() => descendantProjects(projectList.projectsArray, project.value.id))

function canBeParent(candidate: ProjectResponse) {
	return candidate.id !== project.value.id
		&& !descendants.value.some(descendant => descendant.id === candidate.id)
		&& (candidate.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.READ_WRITE
}

function setParentProject(parent: ProjectResponse | null) {
	parentProject.value = parent
	parentProjectChanged.value = true
}

useTitle(() => project.value.title ? t('project.edit.title', {project: project.value.title}) : '')

async function save() {
	if (isSaving.value || !isLoaded.value) {
		return
	}

	isSaving.value = true

	try {
		if (parentProjectChanged.value) {
			project.value.parent_project_id = parentProject.value?.id ?? 0
		}
		await updateProject.mutateAsync(project.value)
		baseStore.setCurrentProject(project.value)
	} catch {
		// The toast says what went wrong; the form keeps the changes.
		return
	} finally {
		isSaving.value = false
	}
	// Leaving mid-save is blocked by the dialog; this still keeps a late save from stepping back a second time.
	if (alive.value) {
		goBack()
	}
}
</script>

<style lang="scss" scoped>
.project-edit-parent {
	margin: 0;
	color: var(--text-primary);
}

.project-edit-parent-note {
	margin-block: calc(-1 * var(--space-2)) var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.project-edit-meta {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
	gap: 0 var(--space-4);
	align-items: start;
}
</style>
