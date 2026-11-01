<template>
	<Modal
		:aria-label="title"
		:aria-describedby="bodyId"
		@close="emit('stay')"
	>
		<Card
			:title="title"
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
				<p v-if="unsaved">
					{{ t('compass.leave.text') }}
				</p>
				<p
					v-if="uploading > 0"
					class="compass-leave-dialog__uploads"
				>
					{{ t('compass.leave.uploading', {n: uploading}, uploading) }}
				</p>
				<template v-if="unsaved">
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
				</template>
			</div>
			<template #footer>
				<XButton
					v-if="unsaved"
					variant="tertiary"
					danger
					:shadow="false"
					class="compass-leave-dialog__discard"
					@click="emit('discard')"
				>
					{{ t('compass.leave.discard') }}
				</XButton>
				<!-- With the text saved, only the uploads are at stake: leaving cancels them, nothing else. -->
				<XButton
					variant="secondary"
					:shadow="false"
					@click="emit('keep')"
				>
					{{ unsaved ? t('compass.leave.keep') : t('compass.leave.cancelUploads') }}
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
import {computed, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'

const props = withDefaults(defineProps<{
	// The browser refused to store the draft: leaving keeps it only until this tab closes.
	storeFailed?: boolean
	// The text has changes that are not saved yet.
	unsaved?: boolean
	// Images still queued or uploading; leaving cancels them.
	uploading?: number
}>(), {
	storeFailed: false,
	unsaved: true,
	uploading: 0,
})

const emit = defineEmits<{
	stay: []
	keep: []
	discard: []
}>()

const {t} = useI18n({useScope: 'global'})
const bodyId = useId()
const title = computed(() => props.unsaved ? t('compass.leave.title') : t('compass.leave.uploadingTitle'))
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

.compass-leave-dialog__uploads {
	font-weight: var(--weight-medium);
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
