<template>
	<div
		v-if="shouldShowMessage"
		class="add-to-home-screen"
	>
		<Icon
			icon="arrow-up-from-bracket"
			class="add-icon"
			aria-hidden="true"
		/>
		<p>
			{{ $t('home.addToHomeScreen') }}
		</p>
		<BaseButton
			:aria-label="$t('misc.closeBanner')"
			class="hide-button"
			@click="() => hideMessage = true"
		>
			<Icon icon="x" />
		</BaseButton>
	</div>
</template>

<script lang="ts" setup>
import BaseButton from '@/components/base/BaseButton.vue'
import {useLocalStorage} from '@vueuse/core'
import {computed} from 'vue'
import {useAuthStore} from '@/stores/auth'
import {isNativeAndroid} from '@/helpers/nativeAndroid'

const authStore = useAuthStore()

const hideMessage = useLocalStorage('hideAddToHomeScreenMessage', false)

const shouldShowMessage = computed(() => {
	if (!authStore.authenticated || isNativeAndroid()) {
		return false
	}

	if (hideMessage.value) {
		return false
	}

	if (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches) {
		return false
	}

	return true
})
</script>

<style lang="scss" scoped>
// A quiet dismissible chip at the top of the page, not a dark band.
.add-to-home-screen {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-block-end: var(--space-4);
	padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-tight);

	p {
		flex: 1 1 auto;
		min-inline-size: 0;
	}

	@media screen and (min-width: $tablet) {
		display: none;
	}

	@media print {
		display: none;
	}
}

.add-icon {
	flex-shrink: 0;
	color: var(--accent-text);
}

.hide-button {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	min-inline-size: var(--target-min);
	min-block-size: var(--target-min);
	border-radius: $radius;
	color: var(--text-secondary);
	cursor: pointer;

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}
}
</style>
