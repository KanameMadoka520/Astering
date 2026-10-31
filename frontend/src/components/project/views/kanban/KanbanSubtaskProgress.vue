<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {SubtaskProgress} from '@/helpers/kanbanHierarchy'

const props = withDefaults(defineProps<{
	progress: SubtaskProgress | null
	compact?: boolean
}>(), {compact: false})

const {t} = useI18n({useScope: 'global'})
const percent = computed(() => props.progress && props.progress.total > 0
	? Math.round(props.progress.done / props.progress.total * 100)
	: 0)
</script>

<template>
	<span
		v-if="progress === null"
		class="kanban-progress is-unknown"
		:title="t('project.kanban.hierarchy.progressUnknownHint')"
	>
		<Icon icon="circle-question" />
		<span>{{ t('project.kanban.hierarchy.progressUnknown') }}</span>
		<span class="is-sr-only">{{ t('project.kanban.hierarchy.progressUnknownHint') }}</span>
	</span>
	<span
		v-else-if="progress.total > 0"
		class="kanban-progress"
		:class="{'is-compact': compact, 'is-complete': progress.done === progress.total}"
		:title="t('project.kanban.hierarchy.progressHint')"
	>
		<Icon
			v-if="compact"
			icon="sitemap"
		/>
		<span
			v-else
			class="kanban-progress__bar"
			aria-hidden="true"
		>
			<span :style="{inlineSize: `${percent}%`}" />
		</span>
		<span aria-hidden="true">{{ compact ? `${progress.done}/${progress.total}` : t('project.kanban.hierarchy.progress', progress) }}</span>
		<span class="is-sr-only">{{ t('project.kanban.hierarchy.progressLabel', progress) }}</span>
	</span>
</template>

<style scoped lang="scss">
.kanban-progress {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	white-space: nowrap;

	svg {
		flex-shrink: 0;
		color: var(--text-tertiary);
		font-size: var(--text-2xs);
	}

	&.is-unknown {
		color: var(--text-tertiary);
		font-style: italic;
	}

	&.is-complete svg {
		color: var(--success);
	}
}

.kanban-progress__bar {
	display: inline-block;
	inline-size: 3rem;
	block-size: .375rem;
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-active);

	> span {
		display: block;
		block-size: 100%;
		border-radius: inherit;
		background: var(--success);
	}
}
</style>
