<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import {RouterLink} from 'vue-router'
import type {ChatImageReceipt} from './chatImageReceipt'

defineProps<{receipt: ChatImageReceipt}>()
const {t} = useI18n({useScope: 'global'})
const MESSAGES: Record<ChatImageReceipt['kind'], string> = {
	inserted: 'tcy.chatImages.receiptInserted',
	removed: 'tcy.chatImages.receiptRemoved',
	replaced: 'tcy.chatImages.receiptReplaced',
	moved: 'tcy.chatImages.receiptMoved',
	updated: 'tcy.chatImages.receiptUpdated',
}
</script>

<template>
	<p class="chat-image-receipt">
		<span>{{ t(MESSAGES[receipt.kind]) }}</span>
		<RouterLink
			class="chat-image-task-link"
			:to="{
				name: 'task.detail',
				params: {id: receipt.taskId},
			}"
		>
			{{ t('agent.taskOrder.taskId', {id: receipt.taskId}) }}
		</RouterLink>
	</p>
</template>

<style scoped lang="scss">
.chat-image-receipt {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	column-gap: var(--space-2);
	min-inline-size: 0;
	margin-block: 0 var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

.chat-image-task-link {
	display: inline-flex;
	align-items: center;
	min-block-size: 2.75rem;
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);

	&:focus-visible { @include focus-ring; }
}
</style>
