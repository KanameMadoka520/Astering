<template>
	<Modal
		:enabled="open"
		:aria-label="$t('user.settings.leave.title')"
		@close="emit('stay')"
		@opened="focusStay"
	>
		<Card
			:title="$t('user.settings.leave.title')"
			:shadow="false"
			:padding="false"
			:show-close="true"
			class="unsaved-leave has-text-start"
			@close="emit('stay')"
		>
			<p
				ref="text"
				class="unsaved-leave__text"
			>
				{{ $t('user.settings.leave.text') }}
			</p>
			<template #footer>
				<XButton
					variant="secondary"
					:shadow="false"
					data-leave-stay
					@click="emit('stay')"
				>
					{{ $t('user.settings.leave.stay') }}
				</XButton>
				<XButton
					variant="primary"
					danger
					:shadow="false"
					@click="emit('discard')"
				>
					{{ $t('user.settings.leave.discard') }}
				</XButton>
			</template>
		</Card>
	</Modal>
</template>

<script setup lang="ts">
import {useTemplateRef} from 'vue'

import Modal from '@/components/misc/Modal.vue'

defineProps<{open: boolean}>()
const emit = defineEmits<{stay: [], discard: []}>()

const text = useTemplateRef<HTMLElement>('text')

// "Keep editing" is the safe answer, so it gets the focus (Enter must not discard anything).
function focusStay() {
	text.value?.closest('.unsaved-leave')?.querySelector<HTMLElement>('[data-leave-stay]')?.focus()
}
</script>

<style lang="scss" scoped>
.unsaved-leave__text {
	padding: var(--space-4);
}
</style>
