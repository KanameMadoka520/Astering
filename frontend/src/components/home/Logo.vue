<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useConfigStore } from '@/stores/config'
import { useColorScheme } from '@/composables/useColorScheme'

import LogoFull from '@/assets/logo-full.svg?component'
import LogoFullPride from '@/assets/logo-full-pride.svg?component'
import {MILLISECONDS_A_HOUR} from '@/constants/date'

defineProps<{compact?: boolean}>()
const {t} = useI18n({useScope: 'global'})

const now = useNow({
	interval: MILLISECONDS_A_HOUR,
})

const authStore = useAuthStore()
const configStore = useConfigStore()
const { isDark } = useColorScheme()

const Logo = computed(() => configStore.allow_icon_changes
	&& authStore.settings.frontend_settings.allow_icon_changes
	&& now.value.getMonth() === 5
	? LogoFullPride
	: LogoFull)

const CustomLogo = computed(() => {
	const lightLogo = window.CUSTOM_LOGO_URL
	const darkLogo = window.CUSTOM_LOGO_URL_DARK

	if (!lightLogo && !darkLogo) return ''
	if (!darkLogo) return lightLogo
	if (!lightLogo) return darkLogo

	return isDark.value ? darkLogo : lightLogo
})
</script>

<template>
	<div
		class="brand-logo"
		:class="{'is-compact': compact}"
	>
		<Logo
			v-if="!CustomLogo"
			aria-label="vikunja-x"
			class="logo"
		/>
		<img
			v-else
			:src="CustomLogo"
			alt="vikunja-x"
			class="logo"
		>
		<span class="brand-subtitle">{{ t('brand.subtitle') }}</span>
	</div>
</template>

<style lang="scss" scoped>
.brand-logo {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: 24rem;

	&.is-compact {
		gap: 0;
		max-inline-size: 10.5rem;

		.brand-subtitle {
			font-size: .625rem;
			line-height: 1.1;
		}
	}
}

.logo {
	display: block;
	color: var(--logo-text-color);
	max-inline-size: min(168px, 100%);
	max-block-size: 48px;
}

.brand-subtitle {
	max-inline-size: 100%;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;
	text-wrap: balance;
}
</style>
