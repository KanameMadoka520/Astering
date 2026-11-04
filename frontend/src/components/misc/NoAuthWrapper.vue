<template>
	<div class="no-auth-wrapper">
		<div class="noauth-container">
			<div
				class="image"
				aria-hidden="true"
			>
				<p
					v-if="heroText !== ''"
					class="image-title"
				>
					{{ heroText }}
				</p>
			</div>
			<main
				id="main-content"
				tabindex="-1"
				class="content"
			>
				<div class="noauth-body">
					<Logo
						class="noauth-logo"
						width="200"
						height="58"
					/>
					<h1
						v-if="title"
						class="noauth-title"
					>
						{{ title }}
					</h1>
					<Message
						v-if="motd !== ''"
						class="noauth-motd"
					>
						{{ motd }}
					</Message>
					<ApiConfig v-if="shouldShowApiConfig" />
					<slot />
				</div>
				<Legal />
			</main>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import Logo from '@/components/home/Logo.vue'
import Message from '@/components/misc/Message.vue'
import Legal from '@/components/misc/Legal.vue'
import ApiConfig from '@/components/misc/ApiConfig.vue'

import { useTitle } from '@/composables/useTitle'
import { useConfigStore } from '@/stores/config'
import { isDesktopApp } from '@/helpers/desktopAuth'

const props = withDefaults(
	defineProps<{
		showApiConfig?: boolean;
	}>(),
	{
		showApiConfig: false,
	},
)

const isDesktop = isDesktopApp()
const hasStoredApiUrl = isDesktop && localStorage.getItem('API_URL') !== null
const shouldShowApiConfig = computed(() => props.showApiConfig && (!isDesktop || hasStoredApiUrl))

const configStore = useConfigStore()
const motd = computed(() => configStore.motd)

const route = useRoute()
const { t } = useI18n({ useScope: 'global' })
const title = computed(() =>
	route.meta?.title ? t(route.meta.title as string) : '',
)
useTitle(() => title.value)

const HERO_KEYS: Record<string, string> = {
	'user.login': 'misc.welcomeBack',
	'user.register': 'user.auth.hero.register',
	'user.password-reset.request': 'user.auth.hero.reset',
	'user.password-reset.reset': 'user.auth.hero.reset',
}

const heroText = computed(() => {
	const key = typeof route.name === 'string' ? HERO_KEYS[route.name] : undefined
	return key ? t(key) : ''
})
</script>

<style lang="scss" scoped>
.no-auth-wrapper {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	min-block-size: 100dvh;
	padding: var(--space-8) var(--space-4);
	background-color: var(--site-background);

	@media screen and (min-width: $tablet) {
		background: radial-gradient(ellipse at bottom left, color-mix(in srgb, var(--primary) 10%, transparent), transparent 55%), var(--site-background);
	}

	@media screen and (max-width: $tablet) {
		justify-content: flex-start;
		padding: var(--space-4) var(--space-3);
	}
}

.noauth-container {
	display: flex;
	inline-size: 100%;
	max-inline-size: 28rem;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
	box-shadow: var(--elevation-2);
	overflow: hidden;

	@media screen and (min-width: $desktop) {
		max-inline-size: 58rem;
		min-block-size: min(36rem, 80dvh);
	}
}

.image {
	display: none;

	@media screen and (min-width: $desktop) {
		position: relative;
		display: flex;
		flex: 0 0 45%;
		flex-direction: column;
		justify-content: flex-end;
		padding: var(--space-6);
		background: #080a32 url("/images/brand/avatar.webp?v=aster50") no-repeat center / cover;

		// The brand portrait is shared by both themes; keep the overlaid welcome text readable.
		// Two layers keep the lower third dark enough for the heading without dimming the whole image.
		&::before {
			content: "";
			position: absolute;
			inset: 0;
			background-image:
				linear-gradient(to top, var(--scrim), transparent 70%),
				linear-gradient(to top, var(--scrim), transparent 40%);
		}

		> * {
			position: relative;
		}
	}
}

.image-title {
	color: hsl(0deg 0% 100%);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	text-wrap: balance;
}

.content {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	justify-content: space-between;
	gap: var(--space-6);
	min-inline-size: 0;
	padding: var(--space-8) var(--space-8) var(--space-5);

	@media screen and (max-width: $tablet) {
		padding: var(--space-6) var(--space-5) var(--space-4);
	}
}

.noauth-body {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
}

.noauth-logo {
	margin-block-end: var(--space-6);

	:deep(.logo) {
		display: block;
		max-inline-size: min(168px, 100%);
		block-size: auto;
	}
}

.noauth-title {
	margin-block-end: var(--space-5);
	color: var(--text-primary);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.noauth-motd {
	margin-block-end: var(--space-4);
}
</style>
