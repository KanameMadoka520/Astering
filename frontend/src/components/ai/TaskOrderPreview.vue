<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Operation} from '@/client/generated'

const props = defineProps<{operation: Operation}>()
const {t} = useI18n({useScope: 'global'})
function snapshot(raw?: string): Record<string, unknown> {
	try {
		const value = JSON.parse(raw ?? '')
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	} catch {
		return {}
	}
}
const before = computed(() => snapshot(props.operation.before))
const after = computed(() => snapshot(props.operation.after))
const oldItems = computed(() => (Array.isArray(before.value.items) ? before.value.items : [])
	.filter((item): item is {id: number; title?: string} => item && typeof item === 'object'
		&& Number.isSafeInteger(item.id) && item.id > 0))
const nextIds = computed(() => (Array.isArray(after.value.task_ids) ? after.value.task_ids : [])
	.filter((id): id is number => Number.isSafeInteger(id) && id > 0))
function taskLabel(id: number) {
	const title = oldItems.value.find(item => item.id === id)?.title
	return title ? `#${id} ${title}` : t('agent.taskOrder.taskId', {id})
}
</script>

<template>
	<section class="task-order-preview">
		<p>{{ t('agent.taskOrder.reviewHint') }}</p>
		<dl class="order-scope">
			<dt>{{ t('agent.taskOrder.project') }}</dt>
			<dd>#{{ after.project_id }}</dd>
			<dt>{{ t('agent.taskOrder.view') }}</dt>
			<dd>#{{ after.view_id }}</dd>
			<template v-if="Number(after.bucket_id) > 0">
				<dt>{{ t('agent.taskOrder.bucket') }}</dt>
				<dd>#{{ after.bucket_id }}</dd>
			</template>
		</dl>
		<div class="order-columns">
			<div>
				<strong>{{ t('agent.taskOrder.before') }}</strong>
				<ol>
					<li
						v-for="item in oldItems"
						:key="item.id"
					>
						{{ taskLabel(item.id) }}
					</li>
				</ol>
			</div>
			<div>
				<strong>{{ t('agent.taskOrder.after') }}</strong>
				<ol>
					<li
						v-for="id in nextIds"
						:key="id"
					>
						{{ taskLabel(id) }}
					</li>
				</ol>
			</div>
		</div>
		<p>
			{{ Number(after.after_task_id) > 0
				? t('agent.taskOrder.afterTask', {task: taskLabel(Number(after.after_task_id))})
				: t('agent.taskOrder.first') }}
		</p>
		<p>
			{{ Number(after.before_task_id) > 0
				? t('agent.taskOrder.beforeTask', {task: taskLabel(Number(after.before_task_id))})
				: t('agent.taskOrder.last') }}
		</p>
	</section>
</template>

<style scoped lang="scss">
.task-order-preview {
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-muted);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;

	p { margin-block: var(--space-2); }
}

.order-scope {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	gap: var(--space-1) var(--space-3);

	dd { margin: 0; }
}

.order-columns {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-3);

	ol {
		max-block-size: 16rem;
		padding-inline-start: var(--space-5);
		overflow: auto;
	}
}

@media (width <= 400px) {
	.order-columns { grid-template-columns: 1fr; }
}
</style>
