<template>
	<Ready>
		<RouterView v-if="route.name === 'tcy-public'" />
		<template v-else-if="isQuickAddMode && authStore.authUser">
			<QuickAddOverlay />
		</template>
		<template v-else-if="isQuickAddMode">
			<div class="quick-add-not-logged-in">
				<p>{{ $t('quickActions.notLoggedIn') }}</p>
			</div>
		</template>
		<template v-else>
			<a
				href="#main-content"
				class="skip-to-content"
				@click.prevent="skipToMainContent"
			>
				{{ $t('misc.skipToContent') }}
			</a>
			<template v-if="showAuthLayout">
				<AppHeader />
				<ContentAuth />
			</template>
			<ContentLinkShare v-else-if="authStore.authLinkShare" />
			<NoAuthWrapper
				v-else
				show-api-config
			>
				<RouterView v-if="showNoAuthRoute" />
			</NoAuthWrapper>
		</template>

		<KeyboardShortcuts v-if="keyboardShortcutsActive && !isQuickAddMode" />

		<Teleport to="body">
			<ChunkLoadRecovery />
			<NetworkActivity />
			<UpdateNotification v-if="!isQuickAddMode" />
			<Notification />
			<DiagnosticWindow />
			<UploadCenter />
			<DemoMode v-if="!isQuickAddMode" />
		</Teleport>
	</Ready>
</template>

<script lang="ts" setup>
import {computed, watch, onBeforeUnmount} from 'vue'
import {clearUploads} from '@/helpers/uploadTransport'
import UploadCenter from '@/components/misc/UploadCenter.vue'
import ChunkLoadRecovery from '@/components/misc/ChunkLoadRecovery.vue'
import NetworkActivity from '@/components/misc/NetworkActivity.vue'
import DiagnosticWindow from '@/components/ai/DiagnosticWindow.vue'
import {clearDiagnostics, installBrowserDiagnostics} from '@/helpers/diagnostics'
import {useRoute, useRouter} from 'vue-router'
import isTouchDevice from 'is-touch-device'

import Notification from '@/components/misc/Notification.vue'
import UpdateNotification from '@/components/home/UpdateNotification.vue'
import KeyboardShortcuts from '@/components/misc/keyboard-shortcuts/index.vue'

import AppHeader from '@/components/home/AppHeader.vue'
import ContentAuth from '@/components/home/ContentAuth.vue'
import ContentLinkShare from '@/components/home/ContentLinkShare.vue'
import NoAuthWrapper from '@/components/misc/NoAuthWrapper.vue'
import Ready from '@/components/misc/Ready.vue'

import {DEFAULT_LANGUAGE, setLanguage} from '@/i18n'

import {useAuthStore} from '@/stores/auth'
import {useBaseStore} from '@/stores/base'

import {useColorScheme} from '@/composables/useColorScheme'
import {useTimeTrackingFavicon} from '@/composables/useTimeTrackingFavicon'
import {useBodyClass} from '@/composables/useBodyClass'
import QuickAddOverlay from '@/components/quick-actions/QuickAddOverlay.vue'
import DemoMode from '@/components/home/DemoMode.vue'
import {AUTH_ROUTE_NAMES} from '@/constants/authRouteNames'
import {AUTH_TYPES} from '@/constants/auth'
import {useQuickAddMode} from '@/composables/useQuickAddMode'

import {useConfirmDeletionMutation} from '@/client/queries/accountDeletion'
import {getSensitiveParam} from '@/helpers/sensitiveQueryParams'

const COLOR_SCHEME_CACHE_KEY = 'vikunja-color-scheme'

const authStore = useAuthStore()
const baseStore = useBaseStore()
// Only an identity change: every auth check stores a fresh session object for the same account, and clearing
// then would abort uploads and drop a selection's image-format choice midway.
watch(() => authStore.identityKey, () => {clearDiagnostics(); clearUploads()})
onBeforeUnmount(installBrowserDiagnostics())

const {isQuickAddMode} = useQuickAddMode()

// Activating #main-content only scrolls natively, so focus has to be moved explicitly.
// Deferred a frame because a synchronous focus() did not stick in Safari.
function skipToMainContent() {
	requestAnimationFrame(() => document.getElementById('main-content')?.focus())
}

// Make the Electron frameless window transparent
if (isQuickAddMode) {
	document.documentElement.style.background = 'transparent'
	document.body.style.background = 'transparent'
}

const route = useRoute()

const showAuthLayout = computed(() => authStore.authUser && typeof route.name === 'string' && !AUTH_ROUTE_NAMES.has(route.name))

// The router guard bounces every other route to /login while logged out, so anything
// else reaching the logged-out shell means the auth state was cleared mid-navigation
// (logout, expired session) while the old route is still current. Mounting it there
// would run app components against a null `authStore.info`.
const showNoAuthRoute = computed(() => typeof route.name === 'string' && AUTH_ROUTE_NAMES.has(route.name))

useBodyClass('is-touch', isTouchDevice())
const keyboardShortcutsActive = computed(() => baseStore.keyboardShortcutsActive)

const router = useRouter()
const confirmDeletion = useConfirmDeletionMutation()

// Without a session the token would burn on an unauthenticated request, so keep it in the URL until login lands.
const accountDeletionToken = computed(() => {
	const token = getSensitiveParam(route, 'accountDeletionConfirm')
	return authStore.authUser && token ? token : ''
})

watch(accountDeletionToken, async token => {
	if (!token) return
	// The URL reaches Sentry replays and lastVisited, so drop the single-use token before spending it.
	const query = {...route.query}
	delete query.accountDeletionConfirm
	const hash = new URLSearchParams(route.hash.slice(1)).has('accountDeletionConfirm') ? '' : route.hash
	// A failed strip must not skip spending the token.
	await router.replace({path: route.path, query, hash}).catch(() => {})
	confirmDeletion.mutate({
		id: authStore.session?.id ?? 0,
		type: authStore.session?.type ?? AUTH_TYPES.USER,
		token,
	})
}, {immediate: true})

setLanguage(authStore.settings.language ?? DEFAULT_LANGUAGE)
const {isDark, isStarlight} = useColorScheme()
// Until checkAuth resolves the first route, keep index.html's cached appearance. The cache only paints
// startup; once navigation is ready the account's saved preference owns both classes and the next hint.
watch([isDark, isStarlight, () => route.name], ([dark, starlight, name]) => {
	if (!name) return
	const root = document.documentElement
	root.classList.toggle('dark', dark)
	root.classList.toggle('light', !dark)
	root.classList.toggle('theme-starlight', starlight)
	try {
		localStorage.setItem(COLOR_SCHEME_CACHE_KEY, starlight ? 'starlight' : dark ? 'dark' : 'light')
	} catch { /* Storage is optional; the theme still applies. */ }
}, {
	immediate: true,
	flush: 'post',
})
useTimeTrackingFavicon()
</script>

<style src="@/styles/tailwind.css" />

<style lang="scss" src="@/styles/global.scss" />
