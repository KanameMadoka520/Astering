<template>
	<p
		v-if="sentences.length > 0"
		class="parent-access-note"
		aria-live="polite"
	>
		<Icon
			icon="users"
			class="parent-access-note__icon"
			aria-hidden="true"
		/>
		<span>{{ sentences.join(' ') }}</span>
	</p>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import type {ProjectResponse} from '@/client/queries/projects'
import {getProjectTitle} from '@/helpers/getProjectTitle'

// Everyone with access to a parent project can open the projects inside it (backend project_ancestors), so picking a
// parent changes who can open a project. This says so where the parent is chosen.
const props = withDefaults(defineProps<{
	kind: 'new' | 'copy' | 'move'
	parent: ProjectResponse | null
	/** For a move: the parent before the change. */
	previousParent?: ProjectResponse | null
	/** For a move: how many projects are inside the one being moved. */
	descendantCount?: number
}>(), {
	previousParent: null,
	descendantCount: 0,
})

const {t} = useI18n({useScope: 'global'})

const sentences = computed(() => {
	const parent = props.parent && props.parent.id > 0 ? props.parent : null
	if (props.kind !== 'move') {
		if (!parent) return []
		return [t(props.kind === 'new' ? 'project.parentAccess.newProject' : 'project.parentAccess.copy', {parent: getProjectTitle(parent)})]
	}
	const previous = props.previousParent && props.previousParent.id > 0 ? props.previousParent : null
	if (parent?.id === previous?.id) return []
	const result: string[] = []
	if (parent) {
		result.push(t('project.parentAccess.moveInto', {parent: getProjectTitle(parent), count: props.descendantCount}, props.descendantCount))
	}
	if (previous) {
		result.push(t('project.parentAccess.moveOut', {parent: getProjectTitle(previous)}))
	}
	return result
})
</script>

<style lang="scss" scoped>
.parent-access-note {
	display: flex;
	gap: var(--space-2);
	align-items: baseline;
	margin-block: var(--space-2) 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.parent-access-note__icon {
	flex: none;
	color: var(--text-tertiary);
}
</style>
