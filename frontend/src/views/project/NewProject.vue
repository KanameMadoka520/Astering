<template>
	<CreateEdit
		v-model:loading="isSubmitting"
		:title="$t('project.create.header')"
		:primary-disabled="project.title === ''"
		@create="createProject()"
	>
		<FormField
			v-model="project.title"
			v-focus
			:label="$t('project.title')"
			:disabled="isSubmitting"
			:loading="isSubmitting"
			:placeholder="$t('project.create.titlePlaceholder')"
			type="text"
			name="projectTitle"
			:error="showError && project.title === '' ? $t('project.create.addTitleRequired') : null"
			@keyup.enter="createProject()"
			@keyup.esc="goBack()"
		/>
		<FormField
			v-if="projectList.hasProjects"
			:label="$t('project.parent')"
		>
			<ProjectSearch
				:model-value="parentProject"
				:filter="canHoldProject"
				@update:modelValue="chooseParent"
			/>
		</FormField>
		<ParentAccessNote
			kind="new"
			:parent="parentProject"
		/>
		<FormField :label="$t('project.color')">
			<ColorPicker v-model="project.hex_color" />
		</FormField>
	</CreateEdit>
</template>

<script setup lang="ts">
import {ref, reactive, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'

import CreateEdit from '@/components/misc/CreateEdit.vue'
import ColorPicker from '@/components/input/ColorPicker.vue'
import FormField from '@/components/input/FormField.vue'

import {useTitle} from '@/composables/useTitle'
import {useProjects} from '@/composables/useProjects'
import {useGoBack} from '@/composables/useGoBack'
import ProjectSearch from '@/components/tasks/partials/ProjectSearch.vue'
import ParentAccessNote from '@/components/sharing/ParentAccessNote.vue'
import {PERMISSIONS} from '@/constants/permissions'
import {createProjectDraft, useCreateProjectMutation, type ProjectResponse} from '@/client/queries/projects'

const props = defineProps<{
	parentProjectId?: number,
}>()

const {t} = useI18n({useScope: 'global'})
const router = useRouter()
const goBack = useGoBack()
const createMutation = useCreateProjectMutation()

useTitle(() => t('project.create.header'))

const showError = ref(false)
const project = reactive(createProjectDraft())
const projectList = useProjects()
const parentProject = ref<ProjectResponse | null>(null)
const isSubmitting = ref(false)

// The preselected parent may only arrive with the project list; a parent picked by hand wins.
const parentChosen = ref(false)
watch(() => props.parentProjectId, () => parentChosen.value = false)
watch(
	() => projectList.projects[props.parentProjectId ?? 0],
	parent => {
		if (!parentChosen.value) parentProject.value = parent ?? null
	},
	{immediate: true},
)

function chooseParent(parent: ProjectResponse | null) {
	parentChosen.value = true
	parentProject.value = parent
}

// Creating a project inside another needs write access there.
function canHoldProject(candidate: ProjectResponse) {
	return (candidate.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.READ_WRITE
}

async function createProject() {
	if (project.title === '') {
		showError.value = true
		return
	}
	showError.value = false

	if (isSubmitting.value) {
		return
	}

	isSubmitting.value = true

	// A parent cleared after a failed attempt must not stick.
	project.parent_project_id = parentProject.value?.id ?? 0

	try {
		const created = await createMutation.mutateAsync(project)
		await router.push({name: 'project.index', params: {projectId: created.id}})
	} catch {
		// The toast says what went wrong; the form keeps what was typed.
	} finally {
		isSubmitting.value = false
	}
}
</script>
