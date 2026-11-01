<template>
	<!-- Only what the project list proves; an own project with direct shares shows nothing here (D2). -->
	<span
		v-if="hint"
		class="project-access-badge"
		:class="{'is-compact': compact}"
		:title="tooltip"
	>
		<Icon
			:icon="hint.kind === 'sharedWithYou' ? 'users' : 'sitemap'"
			class="project-access-badge__icon"
			aria-hidden="true"
		/>
		<span
			class="project-access-badge__label"
			:class="{'is-sr-only': compact}"
		>{{ label }}</span>
		<span
			v-if="parentDetail"
			class="is-sr-only"
		>{{ parentDetail }}</span>
	</span>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {ProjectResponse} from '@/client/queries/projects'
import {useProjects} from '@/composables/useProjects'
import {projectAccessHint} from '@/helpers/projectAccess'
import {useAuthStore} from '@/stores/auth'

const props = defineProps<{
	project: ProjectResponse
	/** Icon only, with the text kept for screen readers and as a tooltip. */
	compact?: boolean
}>()

const {t} = useI18n({useScope: 'global'})
const authStore = useAuthStore()
const projectList = useProjects()

const hint = computed(() => authStore.authUser
	? projectAccessHint(projectList.projects, props.project, authStore.info?.id)
	: null)

const label = computed(() => {
	if (!hint.value) return ''
	return hint.value.kind === 'sharedWithYou'
		? t('project.share.badge.sharedWithYou', {name: hint.value.ownerName})
		: t('project.share.badge.inSharedParent')
})

const parentDetail = computed(() => {
	if (hint.value?.kind !== 'inSharedParent') return ''
	const parent = hint.value.parentTitle
	return parent === null
		? t('project.share.badge.inHiddenParentDetail')
		: t('project.share.badge.inSharedParentDetail', {parent})
})

// A compact badge has no visible text, so the tooltip carries the label too.
const tooltip = computed(() => [props.compact ? label.value : '', parentDetail.value].filter(Boolean).join(' ') || undefined)
</script>

<style lang="scss" scoped>
.project-access-badge {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: 100%;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-tight);
}

.project-access-badge__icon {
	flex: none;
	color: var(--text-tertiary);
}

.project-access-badge__label {
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
</style>
