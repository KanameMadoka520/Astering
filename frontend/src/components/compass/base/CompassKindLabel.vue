<template>
	<span class="compass-kind-label">
		<CompassGlyph :kind="kind" />
		<span class="compass-kind-label__text">{{ t(`compass.kind.${kind}`) }}</span>
	</span>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import CompassGlyph from './CompassGlyph.vue'
import type {CompassKind} from '@/helpers/compass/constants'

defineProps<{
	kind: CompassKind
}>()

const {t} = useI18n({useScope: 'global'})
</script>

<style lang="scss" scoped>
.compass-kind-label {
	display: inline-flex;
	align-items: center;
	gap: .4em;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	letter-spacing: .02em;
	white-space: nowrap;
}
</style>
