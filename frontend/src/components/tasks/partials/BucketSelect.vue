<template>
	<template v-if="kanbanView">
		<Icon
			icon="chevron-right"
			class="bucket-separator"
		/>
		<template v-if="canWrite">
			<Dropdown>
				<template #trigger="{toggleOpen, open}">
					<BaseButton
						class="bucket-name"
						:aria-expanded="open"
						:aria-label="$t('task.detail.bucketSelectLabel', {bucket: currentBucketTitle})"
						@click="toggleOpen"
					>
						{{ currentBucketTitle }}
						<Icon
							icon="pencil-alt"
							class="change-indicator d-print-none"
						/>
					</BaseButton>
				</template>
				<template #default="{close}">
					<div @click="close">
						<DropdownItem
							v-for="bucket in buckets"
							:key="bucket.id"
							:class="{'is-active': currentBucket?.id === bucket.id}"
							@click="changeBucket(bucket)"
						>
							{{ bucket.title }}
						</DropdownItem>
					</div>
				</template>
			</Dropdown>
		</template>
		<span
			v-else
			class="bucket-name"
		>
			{{ currentBucketTitle }}
		</span>
	</template>
</template>

<script lang="ts" setup>
import {bucketsQuery} from '@/client/queries/kanban'
import {useMoveTaskMutation} from '@/client/queries/taskMutations'
import {useQuery} from '@tanstack/vue-query'
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import type {Task as ITask} from '@/client/generated'
import type {Bucket as IBucket} from '@/client/generated'

import {PROJECT_VIEW_KINDS} from '@/constants/projectView'

import {useProjects} from '@/composables/useProjects'
import {isRoutineTask} from '@/helpers/taskRoutine'
import {useBaseStore} from '@/stores/base'

import BaseButton from '@/components/base/BaseButton.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'


import {error, success, translatedError} from '@/message'

const props = defineProps<{
	task: ITask
	canWrite: boolean
}>()


const {t} = useI18n({useScope: 'global'})

const projectList = useProjects()
const moveMutation = useMoveTaskMutation()
const baseStore = useBaseStore()

const project = computed(() => projectList.projects[props.task.project_id ?? 0])

// If the project has exactly one manual kanban view, always use it.
// If there are multiple, only show the selector when the active view is one of them.
const kanbanView = computed(() => {
	if (!project.value?.views) {
		return null
	}

	const manualKanbanViews = project.value.views.filter(
		view => view.view_kind === PROJECT_VIEW_KINDS.KANBAN
			&& view.bucket_configuration_mode === 'manual',
	)

	if (manualKanbanViews.length === 1) {
		return manualKanbanViews[0]
	}

	if (manualKanbanViews.length > 1) {
		const activeViewId = baseStore.currentProjectViewId
		return manualKanbanViews.find(v => v.id === activeViewId) || null
	}

	return null
})

const bucketsQueryResult = useQuery(computed(() => bucketsQuery(props.task.project_id ?? 0, kanbanView.value?.id ?? 0)))
const buckets = computed(() => bucketsQueryResult.data.value ?? [])

const currentBucket = computed(() => {
	if (!kanbanView.value) {
		return undefined
	}
	return props.task.buckets?.find(b => b.project_view_id === kanbanView.value?.id)
})

const currentBucketTitle = computed(() => {
	return currentBucket.value?.title || t('task.detail.noBucket')
})

async function changeBucket(bucket: IBucket) {
	if (!kanbanView.value || currentBucket.value?.id === bucket.id) {
		return
	}
	// Same guard as dragging on the board: a routine is checked in, never moved into done.
	if (bucket.id === kanbanView.value.done_bucket_id && isRoutineTask(props.task)) {
		error(translatedError('task.routine.doneBucketBlocked'))
		return
	}

	try {
		await moveMutation.mutateAsync({
			project: props.task.project_id!,
			view: kanbanView.value.id!,
			bucket: bucket.id!,
			task: props.task,
		})
	} catch {
		return // The task stays in its bucket; the mutation reports the error.
	}

	success({message: t('task.detail.bucketChangedSuccess')})
}
</script>

<style lang="scss" scoped>
.bucket-separator {
	font-size: var(--text-2xs);
	color: var(--text-tertiary);
}

.bucket-name {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--target-min);
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);
}

button.bucket-name:hover {
	background: var(--surface-hover);
	color: var(--text-primary);
}

.change-indicator {
	font-size: var(--text-2xs);
	color: var(--text-tertiary);
}

:deep(.dropdown) {
	display: inline-flex;
}

:deep(.dropdown-trigger) {
	display: inline-flex;
	padding: 0;
}
</style>
