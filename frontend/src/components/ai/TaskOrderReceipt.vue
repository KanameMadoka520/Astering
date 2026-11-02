<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import {RouterLink, useRoute} from 'vue-router'
import type {TaskOrderResult} from '@/helpers/taskOrder'

const props = defineProps<{result: TaskOrderResult}>()
const {t} = useI18n({useScope: 'global'})
const route = useRoute()
const target = computed(() => {
	const sameView = route.name === 'project.view'
		&& Number(route.params.projectId) === props.result.project_id
		&& Number(route.params.viewId) === props.result.view_id
	const query = sameView ? {...route.query} : {}
	delete query.page
	return {
		name: 'project.view',
		params: {
			projectId: props.result.project_id,
			viewId: props.result.view_id,
		},
		query: {
			...query,
			sort: 'position:asc',
		},
	}
})
</script>

<template>
	<aside class="task-order-receipt">
		<p>{{ t('agent.taskOrder.saved') }}</p>
		<p class="task-order-hint">
			{{ t('agent.taskOrder.manualHint') }}
		</p>
		<RouterLink
			class="task-order-view-link"
			:to="target"
		>
			{{ t('agent.taskOrder.viewManual') }}
		</RouterLink>
	</aside>
</template>

<style scoped lang="scss">
.task-order-receipt {
	margin-block: var(--space-1) var(--space-3);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 2px solid var(--primary);
	border-radius: var(--radius-sm);
	background: var(--surface-muted);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;

	p { margin: 0; }
}

.task-order-hint {
	margin-block-start: var(--space-1) !important;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.task-order-view-link {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	margin-block-start: var(--space-1);

	&:focus-visible { @include focus-ring; }
}
</style>
