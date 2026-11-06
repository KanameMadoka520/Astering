<template>
	<Dropdown
		ref="dropdown"
		v-bind="$attrs"
	>
		<template #trigger="triggerProps">
			<slot
				name="trigger"
				v-bind="triggerProps"
			>
				<BaseButton
					class="dropdown-trigger"
					:aria-expanded="triggerProps.open"
					@click="triggerProps.toggleOpen"
				>
					<span class="is-sr-only">{{ $t('project.openSettingsMenu') }}</span>
					<Icon
						icon="ellipsis-h"
						class="icon"
					/>
				</BaseButton>
			</slot>
		</template>

		<template v-if="project.id > 0">
			<DropdownItem
				v-if="typeof project.max_permission === 'number' && project.max_permission >= PERMISSIONS.READ"
				:to="{name: 'project.versions', params: {projectId: project.id}}"
				:icon="['far', 'clock']"
			>
				{{ $t('projectVersions.title') }}
			</DropdownItem>
			<DropdownItem
				:to="{name: 'projects.history', query: {project: project.id}}"
				icon="calendar"
			>
				{{ $t('projectHistory.title') }}
			</DropdownItem>
			<DropdownItem
				v-if="forceAllActions || project.max_permission === PERMISSIONS.ADMIN"
				icon="check"
				@click="confirmCompletion = true"
			>
				{{ $t(project.is_completed ? 'projectHistory.reopen' : 'projectHistory.complete') }}
			</DropdownItem>
		</template>
		<template v-if="canWrite && isSavedFilterProject(project)">
			<DropdownItem
				:to="{ name: 'filter.settings.edit', params: { projectId: project.id } }"
				icon="pen"
			>
				{{ $t('menu.edit') }}
			</DropdownItem>
			<DropdownItem
				:to="{ name: 'project.settings.views', params: { projectId: project.id } }"
				icon="eye"
			>
				{{ $t('menu.views') }}
			</DropdownItem>
			<slot name="before-delete" />
			<DropdownItem
				:to="{ name: 'filter.settings.delete', params: { projectId: project.id } }"
				icon="trash-alt"
				class="has-text-danger"
			>
				{{ $t('misc.delete') }}
			</DropdownItem>
		</template>

		<template v-else-if="canWrite && project.is_archived">
			<DropdownItem
				:to="{ name: 'project.settings.archive', params: { projectId: project.id } }"
				icon="archive"
			>
				{{ $t('menu.unarchive') }}
			</DropdownItem>
		</template>
		<template v-else-if="canWrite">
			<DropdownItem
				:to="{ name: 'project.settings.edit', params: { projectId: project.id } }"
				icon="pen"
			>
				{{ $t('menu.edit') }}
			</DropdownItem>
			<DropdownItem
				:to="{ name: 'project.settings.views', params: { projectId: project.id } }"
				icon="eye"
			>
				{{ $t('menu.views') }}
			</DropdownItem>
			<DropdownItem
				v-if="backgroundsEnabled"
				:to="{ name: 'project.settings.background', params: { projectId: project.id } }"
				icon="image"
			>
				{{ $t('menu.setBackground') }}
			</DropdownItem>
			<DropdownItem
				:to="{ name: 'project.settings.share', params: { projectId: project.id } }"
				icon="share-alt"
			>
				{{ $t('menu.share') }}
			</DropdownItem>
			<DropdownItem
				:to="{ name: 'project.settings.duplicate', params: { projectId: project.id } }"
				icon="paste"
			>
				{{ $t('menu.duplicate') }}
			</DropdownItem>
			<DropdownItem
				v-tooltip="isDefaultProject ? $t('menu.cantArchiveIsDefault') : ''"
				:to="{ name: 'project.settings.archive', params: { projectId: project.id } }"
				icon="archive"
				:disabled="isDefaultProject"
			>
				{{ $t('menu.archive') }}
			</DropdownItem>
			<Subscription
				class="has-no-shadow"
				entity="project"
				:entity-id="project.id"
				:model-value="project.subscription ?? null"
				type="dropdown"
				@toggle="subscribed => subscriptionMutation.mutateAsync({projectId: project.id, subscribed})"
			/>
			<DropdownItem
				:to="{ name: 'project.settings.webhooks', params: { projectId: project.id } }"
				icon="bolt"
			>
				{{ $t('project.webhooks.title') }}
			</DropdownItem>
			<DropdownItem
				:to="{ name: 'project.createFromParent', params: { parentProjectId: project.id } }"
				icon="layer-group"
			>
				{{ $t('menu.createProject') }}
			</DropdownItem>
			<slot name="before-delete" />
			<DropdownItem
				v-if="forceAllActions || project.max_permission === PERMISSIONS.ADMIN"
				v-tooltip="isDefaultProject ? $t('menu.cantDeleteIsDefault') : ''"
				:to="{ name: 'project.settings.delete', params: { projectId: project.id } }"
				icon="trash-alt"
				class="has-text-danger"
				:disabled="isDefaultProject"
			>
				{{ $t('menu.delete') }}
			</DropdownItem>
		</template>
	</Dropdown>
	<Modal
		v-if="confirmCompletion"
		:loading="completionMutation.isPending.value"
		@close="confirmCompletion = false"
		@submit="changeCompletion"
	>
		<template #header>
			{{ $t(project.is_completed ? 'projectHistory.reopen' : 'projectHistory.complete') }}
		</template>
		<template #text>
			<p>{{ project.title }}</p>
			<p>{{ $t(project.is_completed ? 'projectHistory.reopenHelp' : 'projectHistory.completeHelp') }}</p>
			<p>{{ $t('projectHistory.archiveHelp') }}</p>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useRoute} from 'vue-router'
const props = withDefaults(defineProps<{
	project: Project & Required<Pick<Project, 'id'>>
	forceAllActions?: boolean
}>(), {
	forceAllActions: false,
})
defineOptions({inheritAttrs: false})
import Modal from '@/components/misc/Modal.vue'
import {useProjectCompletionMutation} from '@/client/queries/projectHistory'

import BaseButton from '@/components/base/BaseButton.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'
import Subscription from '@/components/misc/Subscription.vue'
import type {Project} from '@/client/generated'

import {isSavedFilterProject, useSetProjectSubscriptionMutation} from '@/client/queries/projects'
import {useConfigStore} from '@/stores/config'
import {useAuthStore} from '@/stores/auth'
import {PERMISSIONS} from '@/constants/permissions'

const dropdown = ref<InstanceType<typeof Dropdown> | null>(null)
const route = useRoute()
watch(() => route.fullPath, () => dropdown.value?.closeMenu())

const confirmCompletion = ref(false)
const completionMutation = useProjectCompletionMutation()
async function changeCompletion() {
	try {
		await completionMutation.mutateAsync({id: props.project.id, completed: !props.project.is_completed})
		confirmCompletion.value = false
	} catch { /* The mutation displays the error and keeps the confirmation open. */ }
}

const subscriptionMutation = useSetProjectSubscriptionMutation()
const canWrite = computed(() => props.forceAllActions || (props.project.max_permission ?? -1) > PERMISSIONS.READ)

const configStore = useConfigStore()
const backgroundsEnabled = computed(() => configStore.enabled_background_providers?.length > 0)

const authStore = useAuthStore()
const isDefaultProject = computed(() => props.project?.id === authStore.settings.default_project_id)
</script>
