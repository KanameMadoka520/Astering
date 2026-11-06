<template>
	<div
		class="content-auth"
		:class="{'is-mobile-assistant': mobileAssistant}"
		:style="mobileAssistant ? viewportStyle : undefined"
	>
		<GuidedTour />
		<FloatingArona />
		<CustomTransition name="fade">
			<!-- The drawer's own close button is the keyboard path; the scrim only catches pointer taps. -->
			<div
				v-if="drawerOpen"
				class="sidebar-scrim d-print-none"
				aria-hidden="true"
				@click="closeDrawer"
			/>
		</CustomTransition>
		<div
			class="app-container"
			:class="{'has-background': background || blurHash}"
		>
			<div
				v-if="blurHash"
				class="app-container-blurhash d-print-none"
				:style="{
					'background-image': `url(${blurHash})`,
					'filter': brightnessFilter,
				}"
			/>
			<div
				:class="{'is-visible': background}"
				class="app-container-background background-fade-in d-print-none"
				:style="{
					'background-image': background && `url(${background})`,
					'filter': brightnessFilter,
				}"
			/>
			<Navigation class="d-print-none" />
			<main
				id="main-content"
				tabindex="-1"
				class="app-content"
				:class="[
					{ 'is-menu-enabled': menuActive },
					$route.name,
				]"
				:style="{'--sidebar-width': sidebarWidthStyle}"
				:inert="drawerOpen"
			>
				<QuickActions />
				<AddToHomeScreen v-if="route.name !== 'tcy-ai'" />

				<RouterView
					v-slot="{ Component }"
					:route="routeWithModal"
				>
					<keep-alive :include="['project.view']">
						<component :is="Component" />
					</keep-alive>
				</RouterView>

				<Modal
					:enabled="typeof currentModal !== 'undefined'"
					variant="scrolling"
					class="task-detail-view-modal"
					:aria-label="$t('task.detail.title')"
					@close="closeModal()"
				>
					<component
						:is="currentModal"
						@close="closeModal()"
					/>
				</Modal>

				<!-- Shift+/ needs a mounted target; the visible entry lives in the account menu. -->
				<button
					v-shortcut="SHORTCUTS.showKeyboardShortcuts"
					type="button"
					class="keyboard-shortcuts-button"
					hidden
					@click="showKeyboardShortcuts()"
				/>
			</main>
		</div>
	</div>
</template>

<script lang="ts" setup>
import AddToHomeScreen from './AddToHomeScreen.vue'
import {watch, computed, nextTick, onBeforeUnmount} from 'vue'
import {useRoute, useRouter} from 'vue-router'

import {SHORTCUTS} from '@/constants/shortcuts'
import Navigation from '@/components/home/Navigation.vue'
import GuidedTour from '@/components/home/GuidedTour.vue'
import FloatingArona from '@/components/ai/FloatingArona.vue'
import QuickActions from '@/components/quick-actions/QuickActions.vue'
import CustomTransition from '@/components/misc/CustomTransition.vue'

import {useBaseStore} from '@/stores/base'

import {useRouteWithModal} from '@/composables/useRouteWithModal'
import {useRenewTokenOnFocus} from '@/composables/useRenewTokenOnFocus'
import {useSidebarResize} from '@/composables/useSidebarResize'
import {useWebSocket} from '@/composables/useWebSocket'
import {useServerCacheEvents} from '@/composables/useServerCacheEvents'
import {useAronaRunObserver} from '@/composables/useAronaRunObserver'
import {useRoutineDayRefresh} from '@/composables/useRoutineDayRefresh'
import {useBodyClass} from '@/composables/useBodyClass'
import {useVisualViewport} from '@/composables/useVisualViewport'
import {useAuthStore} from '@/stores/auth'

const authStore = useAuthStore()
const brightnessFilter = computed(() => {
	const brightness = authStore.settings?.frontend_settings?.background_brightness
	return brightness ? `brightness(${brightness}%)` : undefined
})

const {sidebarWidthStyle, isMobile} = useSidebarResize()
const {style: viewportStyle} = useVisualViewport()

const {routeWithModal, currentModal, closeModal} = useRouteWithModal()

const baseStore = useBaseStore()
const background = computed(() => baseStore.background)
const blurHash = computed(() => baseStore.blurHash)
const menuActive = computed(() => baseStore.menuActive)
// On phones the open sidebar is a modal drawer: the page behind it is inert.
const drawerOpen = computed(() => isMobile.value && menuActive.value)

function closeDrawer() {
	baseStore.setMenuActive(false)
	// The header stays inert until the next render, so focus can only move afterwards.
	void nextTick(() => document.querySelector<HTMLElement>(
		mobileAssistant.value ? '[data-mobile-history-toggle]' : '.menu-show-button',
	)?.focus({preventScroll: true}))
}

function showKeyboardShortcuts() {
	baseStore.setKeyboardShortcutsActive(true)
}

const route = useRoute()
const router = useRouter()
const mobileAssistant = computed(() => isMobile.value && route.name === 'tcy-ai')
const mobileAssistantBodyClass = useBodyClass('has-mobile-assistant')
watch(mobileAssistant, active => { mobileAssistantBodyClass.value = active }, {immediate: true})

// Project controls and backgrounds belong only to project routes and task details.
// Use a positive context check so newly added global pages cannot inherit a stale project.
watch(() => route.fullPath, () => {
	if (route.params.projectId) {
		baseStore.setCurrentProject({id: Number(route.params.projectId)}, route.params.viewId ? Number(route.params.viewId) : undefined)
	} else if (route.name !== 'task.detail') {
		baseStore.setCurrentProject(null)
	}
}, {immediate: true})

// TODO: Reset the title if the page component does not set one itself

useRenewTokenOnFocus()

useServerCacheEvents()
// Arona receipts keep applying after leaving the assistant, with or without the floating panel open.
useAronaRunObserver()
// One app-level clock re-reads visible routines when a new local day starts or the window regains focus.
useRoutineDayRefresh()
const {connect} = useWebSocket()
connect()

// Listen for task creation from the quick-entry window
const taskUpdateChannel = new BroadcastChannel('vikunja-task-updates')
taskUpdateChannel.onmessage = (event) => {
	if (event.data?.type === 'task-created-open' && event.data?.taskId) {
		router.push({name: 'task.detail', params: {id: event.data.taskId}})
	}
}

onBeforeUnmount(() => {
	taskUpdateChannel.close()
})
</script>

<style lang="scss" scoped>
.sidebar-scrim {
	position: fixed;
	inset: 0;
	// Above the header, below the drawer.
	z-index: calc(var(--layer-sidebar) - 1);
	background: var(--scrim);

	@media screen and (min-width: $tablet) {
		display: none;
	}
}

.app-container {
	min-block-size: 100dvh;
}

.app-content {
	--sidebar-width: #{$navbar-width};

	position: relative;
	z-index: 1;
	display: flow-root;
	overflow-wrap: anywhere;
	min-block-size: 100dvh;
	padding-block: calc(var(--header-height) + var(--space-6)) calc(var(--dock-reserve) + var(--app-update-banner-height, 0px));
	padding-inline: var(--page-gutter);

	@media screen and (max-width: $tablet - 1px) {
		padding-block-start: calc(var(--header-height) + var(--space-4));
	}

	// Content snaps to the sidebar edge instead of animating its margin: a margin transition
	// would re-layout Gantt and Kanban on every frame while the sidebar slides.
	&.is-menu-enabled {
		@media screen and (min-width: $tablet) {
			margin-inline-start: var(--sidebar-width);
		}
	}

	// Used to make sure the spinner is always in the middle while loading
	> .loader-container {
		min-block-size: calc(100dvh - var(--header-height) - var(--space-6) - var(--space-4));
	}
}

.app-content.tcy-ai {
	block-size: 100dvh;
	min-block-size: 0;
	padding: var(--header-height) 0 0;
}

.content-auth.is-mobile-assistant {
	position: fixed;
	inset-block-start: var(--visual-viewport-top, 0);
	inset-inline-start: var(--visual-viewport-left, 0);
	inline-size: var(--visual-viewport-width, 100%);
	block-size: var(--visual-viewport-height, 100dvh);
	padding-block-start: env(safe-area-inset-top, 0);
	padding-inline: env(safe-area-inset-left, 0) env(safe-area-inset-right, 0);

	.app-container {
		block-size: 100%;
		min-block-size: 0;
	}

	.app-content.tcy-ai {
		block-size: 100%;
		padding: 0;
	}
}
</style>
