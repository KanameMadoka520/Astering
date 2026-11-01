<template>
	<!-- This is a workaround to get the sw to "see" the to-be-cached version of the offline background image -->
	<div
		class="offline"
		style="height: 0;width: 0;"
	/>
	<div
		v-if="!online && !baseStore.ready"
		class="app offline"
	>
		<div class="offline-message">
			<h1 class="title">
				{{ $t('offline.title') }}
			</h1>
			<p>{{ $t('offline.text') }}</p>
		</div>
	</div>
	<template v-else-if="baseStore.ready">
		<slot />
		<!-- Once the app runs, a lost connection must not unmount it: open forms, drafts and uploads stay put. -->
		<p
			class="offline-banner"
			role="status"
		>
			<template v-if="!online">
				<span class="offline-banner__title">{{ $t('offline.title') }}</span>
				{{ $t('offline.banner') }}
			</template>
		</p>
	</template>
	<section v-else-if="baseStore.error !== ''">
		<NoAuthWrapper>
			<Message
				v-if="baseStore.error === ERROR_RATE_LIMITED"
				variant="danger"
				class="mbe-4"
			>
				{{ $t('ready.rateLimited') }}
			</Message>
			<template v-else>
				<p v-if="baseStore.error === ERROR_NO_API_URL">
					{{ $t('ready.noApiUrlConfigured') }}
				</p>
				<Message
					v-else
					variant="danger"
					class="mbe-4"
				>
					<p>
						{{ $t('ready.errorOccured') }}<br>
						{{ baseStore.error }}
					</p>
					<p>
						{{ $t('ready.checkApiUrl') }}
					</p>
				</Message>
				<ApiConfig
					:configure-open="true"
					@foundApi="baseStore.loadApp()"
				/>
			</template>
		</NoAuthWrapper>
	</section>
	<CustomTransition name="fade">
		<section
			v-if="baseStore.loading"
			class="vikunja-loading"
			role="status"
		>
			<Logo class="logo" />
			<p class="loading-text">
				<span class="loader-container is-loading-small is-loading" />
				{{ $t('ready.loading') }}
			</p>
		</section>
	</CustomTransition>
</template>

<script lang="ts" setup>
import Logo from '@/components/home/Logo.vue'
import ApiConfig from '@/components/misc/ApiConfig.vue'
import Message from '@/components/misc/Message.vue'
import CustomTransition from '@/components/misc/CustomTransition.vue'
import NoAuthWrapper from '@/components/misc/NoAuthWrapper.vue'

import {ERROR_NO_API_URL} from '@/helpers/checkAndSetApiUrl'

import {useOnline} from '@/composables/useOnline'
import {ERROR_RATE_LIMITED, useBaseStore} from '@/stores/base'

const online = useOnline()
const baseStore = useBaseStore()
</script>

<style lang="scss" scoped>
// stylelint-disable no-invalid-position-declaration

.vikunja-loading {
	position: fixed;
	inset: 0;
	// Covers the whole shell, floating dock included, until the app is ready.
	z-index: calc(var(--layer-floating) + 1);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--space-4);
	background: var(--surface-app);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	.logo :deep(.logo) {
		block-size: 2.5rem;
		inline-size: auto;
	}
}

.loading-text {
	display: flex;
	align-items: center;
	gap: var(--space-3);
}

.loader-container {
	display: inline-block;
	inline-size: 1.5rem;
	block-size: 1.5rem;

	&.is-loading::after {
		border-inline-start-color: var(--text-tertiary);
		border-block-end-color: var(--text-tertiary);
	}
}

.offline-banner {
	position: fixed;
	inset-block-start: calc(var(--header-height) + var(--space-2));
	inset-inline: var(--space-3);
	z-index: var(--layer-header);
	max-inline-size: 34rem;
	margin: 0 auto;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-default);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	font-size: var(--text-sm);
	pointer-events: none;

	&:empty {
		display: none;
	}

	@media print {
		display: none;
	}
}

.offline-banner__title {
	font-weight: var(--weight-semibold);
}

.offline {
	background: url('@/assets/llama-nightscape.jpg') no-repeat center;
	background-size: cover;
	block-size: 100dvh;
}

.offline-message {
	position: absolute;
	inset-block-end: 5vh;
	inline-size: 100%;
	padding: 0 var(--space-4);
	color: $white;
	text-align: center;
}

.title {
	color: $white;
	font-size: var(--text-2xl);
	text-align: center;
}
</style>
