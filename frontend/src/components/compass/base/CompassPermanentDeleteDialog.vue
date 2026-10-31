<template>
	<Modal
		:enabled="enabled"
		:loading="loading"
		:aria-label="t('compass.delete.title')"
		@close="emit('close')"
	>
		<Card
			:title="t('compass.delete.title')"
			:shadow="false"
			:padding="false"
			:show-close="true"
			class="compass-delete-dialog has-text-start"
			@close="emit('close')"
		>
			<div class="compass-delete-dialog__body">
				<p class="compass-delete-dialog__entry">
					{{ entryTitle }}
				</p>
				<p id="compass-delete-meaning">
					{{ t('compass.delete.meaning') }}
				</p>
				<p class="compass-delete-dialog__note">
					{{ t('compass.delete.note') }}
				</p>
				<label class="compass-delete-dialog__confirm">
					<input
						v-model="understood"
						type="checkbox"
						aria-describedby="compass-delete-meaning"
					>
					<span>{{ t('compass.delete.understand') }}</span>
				</label>
			</div>
			<template #footer>
				<XButton
					variant="secondary"
					:shadow="false"
					@click="emit('close')"
				>
					{{ t('misc.cancel') }}
				</XButton>
				<!-- aria-disabled, not disabled: the button keeps focus while the request runs. -->
				<XButton
					variant="primary"
					danger
					:shadow="false"
					:loading="loading"
					:aria-disabled="!understood || loading"
					@click="confirm"
				>
					{{ t('compass.delete.confirm') }}
				</XButton>
			</template>
		</Card>
	</Modal>
</template>

<script setup lang="ts">
import {ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'

const props = defineProps<{
	enabled: boolean
	entryTitle: string
	loading?: boolean
}>()

const emit = defineEmits<{
	close: []
	confirm: []
}>()

const {t} = useI18n({useScope: 'global'})

const understood = ref(false)

// Every opening asks again; an earlier tick must not carry over to another entry.
watch(() => props.enabled, enabled => {
	if (enabled) understood.value = false
})

function confirm() {
	if (!understood.value || props.loading) return
	emit('confirm')
}
</script>

<style lang="scss" scoped>
.compass-delete-dialog__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);
	max-inline-size: 32rem;
}

.compass-delete-dialog__entry {
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;
}

.compass-delete-dialog__note {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.compass-delete-dialog__confirm {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid hsla(var(--danger-h), var(--danger-s), var(--danger-l), .4);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	cursor: pointer;

	input {
		flex: none;
		inline-size: 1.125rem;
		block-size: 1.125rem;
		margin-block-start: .15rem;
		accent-color: var(--danger);
	}
}
</style>
