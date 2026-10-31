<template>
	<span
		v-if="state !== 'active'"
		class="compass-state-badge"
		:class="`compass-state-badge--${state}`"
	>
		<Icon
			:icon="state === 'archived' ? 'archive' : 'trash-alt'"
			aria-hidden="true"
		/>
		{{ t(`compass.state.${state}`) }}
	</span>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import type {CompassEntryState} from '@/helpers/compass/constants'

defineProps<{
	state: CompassEntryState
}>()

const {t} = useI18n({useScope: 'global'})
</script>

<style lang="scss" scoped>
.compass-state-badge {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	padding: .1rem var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	white-space: nowrap;
}

.compass-state-badge--trashed {
	border-color: hsla(var(--danger-h), var(--danger-s), var(--danger-l), .4);
	background: var(--tint-danger);
	color: var(--text-primary);
}
</style>
