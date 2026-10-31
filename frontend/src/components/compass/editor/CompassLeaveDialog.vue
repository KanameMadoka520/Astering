<template>
	<Modal
		:aria-label="t('compass.leave.title')"
		:aria-describedby="bodyId"
		@close="emit('stay')"
	>
		<Card
			:title="t('compass.leave.title')"
			:shadow="false"
			:padding="false"
			:show-close="true"
			class="compass-leave-dialog has-text-start"
			@close="emit('stay')"
		>
			<div
				:id="bodyId"
				class="compass-leave-dialog__body"
			>
				<p>
					{{ t('compass.leave.text') }}
				</p>
				<Message
					v-if="storeFailed"
					variant="warning"
				>
					{{ t('compass.leave.notStored') }}
				</Message>
				<p
					v-else
					class="compass-leave-dialog__note"
				>
					{{ t('compass.leave.keepHint') }}
				</p>
			</div>
			<template #footer>
				<XButton
					variant="tertiary"
					danger
					:shadow="false"
					class="compass-leave-dialog__discard"
					@click="emit('discard')"
				>
					{{ t('compass.leave.discard') }}
				</XButton>
				<XButton
					variant="secondary"
					:shadow="false"
					@click="emit('keep')"
				>
					{{ t('compass.leave.keep') }}
				</XButton>
				<!-- The safe choice takes the initial focus. -->
				<XButton
					variant="primary"
					:shadow="false"
					autofocus
					@click="emit('stay')"
				>
					{{ t('compass.leave.stay') }}
				</XButton>
			</template>
		</Card>
	</Modal>
</template>

<script setup lang="ts">
import {useId} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'

withDefaults(defineProps<{
	// The browser refused to store the draft: leaving keeps it only until this tab closes.
	storeFailed?: boolean
}>(), {
	storeFailed: false,
})

const emit = defineEmits<{
	stay: []
	keep: []
	discard: []
}>()

const {t} = useI18n({useScope: 'global'})
const bodyId = useId()
</script>

<style lang="scss" scoped>
.compass-leave-dialog {
	max-inline-size: 34rem;
	margin-block-end: 0;

	:deep(.card-footer) {
		flex-wrap: wrap;
	}

	@media (width <= 480px) {
		:deep(.card-footer) {
			flex-direction: column-reverse;
			align-items: stretch;
		}
	}
}

.compass-leave-dialog__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);

	p {
		margin: 0;
	}
}

.compass-leave-dialog__note {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

// Discarding sits apart from the two ways of keeping the text.
.compass-leave-dialog__discard {
	margin-inline-end: auto;

	@media (width <= 480px) {
		margin-inline-end: 0;
	}
}

@media (pointer: coarse) {
	.compass-leave-dialog :deep(.card-footer .button) {
		min-block-size: var(--target-min);
	}
}
</style>
