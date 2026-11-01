<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'

import {aiSettingsQuery} from '@/client/queries/tcyAi'
import TcyAISettingsForm from '@/components/ai/TcyAISettingsForm.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import SettingsScope from './SettingsScope.vue'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('tcymc.text.ai_and_voice')} - ${t('user.settings.title')}`)

const authStore = useAuthStore()
const settings = useQuery({
	...aiSettingsQuery(),
	meta: {handlesError: true},
})
const saved = computed(() => settings.data.value)
// The draft is seeded once per account, so another identity always gets a fresh form.
const identityKey = computed(() => authStore.session ? `${authStore.session.type}:${authStore.session.id}` : '')
</script>

<template>
	<div class="settings-page">
		<PageHeader :title="t('tcymc.text.ai_and_voice')">
			<template #description>
				{{ t('tcymc.text.connect_your_own_models_and_choose_one_for') }}
				<SettingsScope scope="account">
					{{ t('user.settings.scope.aiAccount') }}
				</SettingsScope>
			</template>
			<template #actions>
				<XButton
					variant="secondary"
					icon="robot"
					:to="{name: 'tcy-ai'}"
				>
					{{ t('tcymc.text.open_ai_assistant') }}
				</XButton>
			</template>
		</PageHeader>
		<TcyAISettingsForm
			v-if="saved"
			:key="identityKey"
			:initial="saved"
		/>
		<LoadError
			v-else-if="settings.isError.value"
			:message="t('modelSettings.loadFailed')"
			:retry="() => settings.refetch()"
		/>
		<div
			v-else
			class="settings-page__skeleton"
			role="status"
			:aria-label="t('tcymc.text.loading_model_settings')"
		>
			<span class="settings-page__skeleton-bar is-short" />
			<span class="settings-page__skeleton-block" />
		</div>
	</div>
</template>

<style lang="scss" scoped>
.settings-page__skeleton {
	display: grid;
	gap: var(--space-4);
}

.settings-page__skeleton-bar,
.settings-page__skeleton-block {
	display: block;
	border-radius: var(--radius-md);
	background: var(--surface-active);
}

.settings-page__skeleton-bar {
	block-size: var(--control-height);
	inline-size: min(26rem, 100%);
}

.settings-page__skeleton-block {
	block-size: 14rem;
}
</style>
