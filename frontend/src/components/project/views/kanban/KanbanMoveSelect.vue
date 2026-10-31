<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import type {BucketResponse} from '@/client/queries/kanban'
import type {TaskResponse} from '@/client/queries/tasks'
import {useKanbanTree, useTaskLabel} from './kanbanTreeContext'

const props = defineProps<{
	task: TaskResponse
	bucketId: number
}>()

const {t} = useI18n({useScope: 'global'})
const tree = useKanbanTree()
const label = useTaskLabel()
const moving = ref(false)

const current = computed(() => tree.buckets.value.find(bucket => bucket.id === props.bucketId))
const isFull = (bucket: BucketResponse) => bucket.limit > 0 && bucket.count >= bucket.limit
const optionLabel = (bucket: BucketResponse) => isFull(bucket)
	? t('project.kanban.hierarchy.moveFull', {bucket: bucket.title})
	: bucket.id === tree.doneBucketId.value
		? t('project.kanban.hierarchy.moveDone', {bucket: bucket.title})
		: bucket.title

// Not natively disabled while saving: a disabled select drops keyboard focus to the page.
async function onChange(event: Event) {
	const select = event.target as HTMLSelectElement
	const target = Number(select.value)
	// The card stays where it is until the server agrees, so the select shows the real column meanwhile.
	select.value = String(props.bucketId)
	if (moving.value || target === props.bucketId) return
	moving.value = true
	try {
		await tree.move(props.task, props.bucketId, target)
	} finally {
		moving.value = false
	}
}
</script>

<template>
	<label
		class="kanban-move"
		:class="{'is-busy': moving}"
	>
		<Icon icon="arrow-right-arrow-left" />
		<select
			:value="bucketId"
			:aria-label="t('project.kanban.hierarchy.move', {title: label(task)})"
			:aria-busy="moving || undefined"
			:aria-disabled="moving || undefined"
			@change="onChange"
		>
			<option :value="bucketId">
				{{ t('project.kanban.hierarchy.moveCurrent', {bucket: current?.title ?? ''}) }}
			</option>
			<template
				v-for="bucket in tree.buckets.value"
				:key="bucket.id"
			>
				<option
					v-if="bucket.id !== bucketId"
					:value="bucket.id"
					:disabled="isFull(bucket)"
				>
					{{ optionLabel(bucket) }}
				</option>
			</template>
		</select>
	</label>
</template>

<style scoped lang="scss">
.kanban-move {
	position: relative;
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: var(--kanban-tree-target, var(--control-height-sm));
	block-size: var(--kanban-tree-target, var(--control-height-sm));
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-within {
		@include focus-ring;
		outline-offset: 0;
		color: var(--text-primary);
	}

	&.is-busy {
		opacity: .5;
	}

	// The native picker stays: it is reachable by keyboard and opens the system sheet on phones.
	select {
		position: absolute;
		inset: 0;
		inline-size: 100%;
		block-size: 100%;
		opacity: 0;
		cursor: pointer;
		font-size: var(--text-md);
	}
}
</style>
