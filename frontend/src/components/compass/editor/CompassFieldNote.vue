<template>
	<p
		:id="id"
		class="compass-field-note"
		:class="{'is-problem': problem !== ''}"
	>
		<span
			v-if="problem !== ''"
			class="compass-field-note__problem"
		>
			<Icon
				icon="exclamation-circle"
				class="compass-field-note__icon"
				aria-hidden="true"
			/>
			<span>{{ problem }}</span>
		</span>
		<span
			v-if="showCount"
			class="compass-field-note__count"
		>{{ t('compass.editor.counter', {count, limit}) }}</span>
	</p>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'

withDefaults(defineProps<{
	id: string
	count: number
	limit: number
	showCount?: boolean
	problem?: string
}>(), {
	showCount: false,
	problem: '',
})

const {t} = useI18n({useScope: 'global'})
</script>

<style lang="scss" scoped>
.compass-field-note {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-1) 0 0;
	color: var(--compass-ink-faint);
	font-family: var(--compass-sans);
	font-size: var(--text-xs);
	line-height: 1.4;
}

.compass-field-note__problem {
	display: inline-flex;
	align-items: baseline;
	gap: var(--space-1);
	color: var(--danger-text);
	font-weight: var(--weight-medium);
}

.compass-field-note__icon {
	flex: none;
	align-self: center;
}

.compass-field-note__count {
	margin-inline-start: auto;
	font-variant-numeric: tabular-nums;

	.is-problem & {
		color: var(--danger-text);
	}
}
</style>
