<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import {RouterLink} from 'vue-router'
import type {ProjectVersionReceipt} from '@/helpers/projectVersionReceipt'

defineProps<{receipt: ProjectVersionReceipt}>()
const {t} = useI18n({useScope: 'global'})
</script>

<template>
	<p class="version-receipt">
		<span>{{ t(`projectVersions.receipt.${receipt.kind}`, {name: receipt.name}) }}</span>
		<span v-if="receipt.kind === 'restored'">{{ t('projectVersions.receipt.summary', {active: receipt.activeTasks, removed: receipt.removedTasks}) }}</span>
		<RouterLink :to="{name: 'project.versions', params: {projectId: receipt.projectId}, query: {version: receipt.versionId}}">
			{{ t('projectVersions.receipt.openSaved') }}
		</RouterLink>
		<RouterLink
			v-if="receipt.beforeVersionId"
			:to="{name: 'project.versions', params: {projectId: receipt.projectId}, query: {version: receipt.beforeVersionId}}"
		>
			{{ t('projectVersions.receipt.openBefore') }}
		</RouterLink>
	</p>
</template>

<style scoped lang="scss">
.version-receipt {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	min-inline-size: 0;
	margin-block: 0 var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	a {
		display: inline-flex;
		align-items: center;
		min-block-size: 2.75rem;
		padding-inline: var(--space-1);
		border-radius: var(--radius-sm);

		&:focus-visible { @include focus-ring; }
	}
}
</style>
