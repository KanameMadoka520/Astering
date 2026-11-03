<template>
	<section
		v-if="failure"
		class="chunk-load-recovery d-print-none"
		role="alert"
		:aria-label="t('loadingError.chunkTitle')"
	>
		<h2>{{ t('loadingError.chunkTitle') }}</h2>
		<p>{{ t('loadingError.chunkText') }}</p>
		<p v-if="failure.retryFailed">
			{{ t('loadingError.chunkRetryFailed') }}
		</p>
		<p v-if="!failure.target">
			{{ t('loadingError.chunkNoTarget') }}
		</p>
		<template v-if="confirmReload">
			<p class="chunk-load-recovery__warning">
				{{ t('loadingError.reloadWarning') }}
			</p>
			<div class="chunk-load-recovery__actions">
				<XButton
					variant="secondary"
					:shadow="false"
					@click="confirmReload = false"
				>
					{{ t('loadingError.keepWorking') }}
				</XButton>
				<XButton
					:shadow="false"
					@click="reloadAfterChunkFailure()"
				>
					{{ t('loadingError.reloadConfirm') }}
				</XButton>
			</div>
		</template>
		<div
			v-else
			class="chunk-load-recovery__actions"
		>
			<XButton
				v-if="failure.target && !failure.retryFailed"
				:shadow="false"
				:loading="failure.retrying"
				:aria-disabled="failure.retrying || undefined"
				@click="retryChunkLoadNavigation(router)"
			>
				{{ t(failure.retrying ? 'loadingError.retrying' : 'loadingError.retryNavigation') }}
			</XButton>
			<XButton
				variant="secondary"
				:shadow="false"
				@click="confirmReload = true"
			>
				{{ t('loadingError.reloadPage') }}
			</XButton>
			<XButton
				variant="tertiary"
				:shadow="false"
				@click="dismissChunkLoadRecovery()"
			>
				{{ t('loadingError.dismiss') }}
			</XButton>
		</div>
	</section>
</template>

<script setup lang="ts">
import {ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'

import XButton from '@/components/input/Button.vue'
import {useAuthStore} from '@/stores/auth'
import {
	chunkLoadRecovery as failure,
	clearStaleChunkLoadRecovery,
	dismissChunkLoadRecovery,
	reloadAfterChunkFailure,
	retryChunkLoadNavigation,
} from '@/helpers/handleChunkLoadErrors'

const {t} = useI18n()
const router = useRouter()
const auth = useAuthStore()
const confirmReload = ref(false)
watch(() => failure.value?.id, () => {confirmReload.value = false})
// A synchronous watch also observes logout followed by the same account logging in again.
watch(() => [auth.session, auth.authenticated], clearStaleChunkLoadRecovery, {flush: 'sync'})
</script>

<style lang="scss" scoped>
.chunk-load-recovery {
	position: fixed;
	z-index: calc(var(--layer-floating) + 1);
	inset-block-start: calc(var(--header-height) + var(--space-3));
	inset-inline-end: var(--space-3);
	inline-size: min(32rem, calc(100vw - var(--space-6)));
	max-block-size: calc(100dvh - var(--header-height) - var(--space-6));
	overflow-y: auto;
	padding: var(--space-4);
	border: 1px solid var(--border-default);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	font-size: var(--text-sm);

	h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
	}

	p {
		margin-block: var(--space-2);
	}
}

.chunk-load-recovery__warning {
	font-weight: var(--weight-medium);
}

.chunk-load-recovery__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-start: var(--space-3);

	:deep(.button) {
		min-block-size: 2.75rem;
	}
}
</style>
