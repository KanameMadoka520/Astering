<template>
	<Message variant="danger">
		<i18n-t
			keypath="loadingError.failedRetry"
			scope="global"
		>
			<ButtonLink @click="tryAgain">
				{{ $t('loadingError.tryAgain') }}
			</ButtonLink>
		</i18n-t>
	</Message>
</template>

<script lang="ts" setup>
import Message from '@/components/misc/Message.vue'
import ButtonLink from '@/components/misc/ButtonLink.vue'

// With `retry` only the failed request runs again, so nothing typed elsewhere on the page is lost;
// without it the page reloads, as before.
const props = defineProps<{
	retry?: () => unknown,
}>()

defineOptions({
	inheritAttrs: false,
})

function tryAgain() {
	if (props.retry) {
		void props.retry()
		return
	}
	window.location.reload()
}
</script>
