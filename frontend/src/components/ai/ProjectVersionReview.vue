<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Operation} from '@/client/generated'

const props = defineProps<{operation: Operation}>()
const {t} = useI18n({useScope: 'global'})
function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined
}
function parse(value?: string): unknown {
	try { return JSON.parse(value ?? '') } catch { return undefined }
}
function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
const restoring = computed(() => props.operation.tool === 'restore_project_version')
const args = computed(() => object(parse(props.operation.arguments)))
const before = computed(() => {
	const parsed = parse(props.operation.before)
	if (!Array.isArray(parsed) || parsed.length !== 1) return undefined
	const entity = object(parsed[0])
	return entity?.project_id === args.value?.project_id ? entity : undefined
})
const summary = computed(() => {
	const value = object(before.value?.summary)
	return value && ['added_tasks', 'updated_tasks', 'removed_tasks'].every(key => count(value[key]))
		? value : undefined
})
const preserved = computed(() => {
	const value = object(before.value?.preserved)
	return value?.permissions === true && ['comments', 'checkins', 'progress', 'time_entries'].every(key => count(value[key]))
		? value : undefined
})
const checkpointName = computed(() => restoring.value ? before.value?.version_name : args.value?.name)
</script>

<template>
	<section
		class="version-review"
		:aria-label="t(restoring ? 'projectVersions.review.restoreTitle' : 'projectVersions.review.saveTitle')"
	>
		<dl>
			<dt>{{ t('projectVersions.review.project') }}</dt>
			<dd v-if="typeof before?.title === 'string'">
				{{ before.title }} · #{{ before.project_id }}
			</dd>
			<dd v-else>
				#{{ args?.project_id }}
			</dd>
			<dt>{{ t('projectVersions.review.checkpointName') }}</dt>
			<dd>{{ typeof checkpointName === 'string' ? checkpointName : t('projectVersions.review.checkpoint', {version: args?.version_id}) }}</dd>
			<template v-if="restoring && typeof before?.target_sequence === 'number'">
				<dt>{{ t('projectVersions.savedContent') }}</dt>
				<dd>{{ t('projectVersions.review.checkpoint', {version: before.target_sequence}) }}</dd>
			</template>
		</dl>
		<p>{{ t(restoring ? 'projectVersions.review.restoreHint' : 'projectVersions.review.saveHint') }}</p>
		<template v-if="restoring">
			<template v-if="summary && preserved">
				<p>
					{{ t('projectVersions.review.impact', {
						added: summary.added_tasks,
						updated: summary.updated_tasks,
						removed: summary.removed_tasks,
					}) }}
				</p>
				<p>
					{{ t('projectVersions.review.preserved', {
						comments: preserved.comments,
						checkins: preserved.checkins,
						progress: preserved.progress,
						timeEntries: preserved.time_entries,
					}) }}
				</p>
			</template>
			<p
				v-else
				role="alert"
			>
				{{ t('projectVersions.review.unavailable') }}
			</p>
			<p>{{ t('projectVersions.review.beforeAfter') }}</p>
			<RouterLink
				v-if="typeof args?.project_id === 'number' && typeof args?.version_id === 'number'"
				:to="{name: 'project.versions', params: {projectId: args.project_id}, query: {version: args.version_id}}"
			>
				{{ t('projectVersions.preview') }}
			</RouterLink>
		</template>
	</section>
</template>

<style scoped lang="scss">
.version-review {
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	overflow-wrap: anywhere;

	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2) var(--space-3);
	}
	dd {
		margin: 0;
	}
	p {
		margin-block: var(--space-3);
	}
}
</style>
