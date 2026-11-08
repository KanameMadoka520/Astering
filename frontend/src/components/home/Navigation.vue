<template>
	<aside
		id="app-sidebar"
		ref="sidebar"
		:class="{
			'is-active': baseStore.menuActive,
			'is-resizing': isResizing,
			'is-mobile-assistant': mobileAssistant,
		}"
		class="menu-container"
		:style="{'--sidebar-width': sidebarWidthStyle}"
	>
		<div class="menu-scroll">
			<div class="menu-header">
				<RouterLink
					:to="{name: 'home'}"
					class="logo"
					:aria-label="$t('navigation.home')"
				>
					<Logo
						compact
						width="164"
						height="48"
					/>
				</RouterLink>
				<BaseButton
					v-if="isMobile"
					class="menu-hide-button"
					:aria-label="$t('navigation.closeSidebar')"
					@click="closeDrawer"
				>
					<Icon icon="times" />
				</BaseButton>
			</div>
			<div
				id="mobile-assistant-site-actions"
				class="mobile-assistant-site-actions"
			/>

			<nav
				class="menu top-menu"
				:aria-label="$t('navigation.main')"
			>
				<menu
					class="menu-list other-menu-items"
					:aria-label="t('navigation.groups.daily')"
				>
					<li>
						<RouterLink
							v-shortcut="SHORTCUTS.navigation.overview"
							data-tour="nav-overview"
							:to="{ name: 'home'}"
						>
							<span class="menu-item-icon icon">
								<Icon icon="house" />
							</span>
							<span class="menu-item-label">{{ t('workspace.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							v-shortcut="SHORTCUTS.navigation.upcoming"
							data-tour="nav-upcoming"
							:to="{ name: 'tasks.range'}"
						>
							<span class="menu-item-icon icon">
								<Icon icon="list" />
							</span>
							<span class="menu-item-label">{{ t('navigation.upcoming') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							data-tour="nav-calendar"
							:to="{name: 'calendar'}"
						>
							<span class="menu-item-icon icon">
								<Icon :icon="['far', 'calendar-alt']" />
							</span>
							<span class="menu-item-label">{{ t('calendar.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							v-shortcut="SHORTCUTS.navigation.projects"
							data-tour="nav-projects"
							:to="{ name: 'projects.index'}"
						>
							<span class="menu-item-icon icon">
								<Icon icon="layer-group" />
							</span>
							<span class="menu-item-label">{{ t('project.projects') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							data-tour="nav-ai"
							:to="{name: 'tcy-ai'}"
						>
							<span class="menu-item-icon icon arona-icon"><AronaAvatar size="small" /></span>
							<span class="menu-item-label">{{ t('tcymc.text.ai_task_assistant') }}</span>
						</RouterLink>
					</li>
				</menu>

				<p
					id="nav-group-records"
					class="nav-group-label"
				>
					{{ t('navigation.groups.records') }}
				</p>
				<menu
					class="menu-list other-menu-items"
					aria-labelledby="nav-group-records"
				>
					<li>
						<RouterLink :to="{name: 'notes'}">
							<span class="menu-item-icon icon"><Icon icon="book-open" /></span>
							<span class="menu-item-label">{{ t('notes.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							data-tour="nav-compass"
							:to="{name: 'compass.index'}"
							:class="{'is-current': isCompassRoute}"
							:aria-current="isCompassRoute ? 'page' : undefined"
						>
							<span class="menu-item-icon icon"><Icon icon="compass" /></span>
							<span class="menu-item-label">{{ t('compass.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink :to="{name: 'projects.history'}">
							<span class="menu-item-icon icon"><Icon icon="chart-gantt" /></span>
							<span class="menu-item-label">{{ t('projectHistory.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink :to="{name: 'drive'}">
							<span class="menu-item-icon icon"><Icon icon="folder" /></span>
							<span class="menu-item-label">{{ t('drive.title') }}</span>
						</RouterLink>
					</li>
					<li v-if="timeTrackingEnabled">
						<RouterLink :to="{ name: 'time-tracking'}">
							<span class="menu-item-icon icon">
								<Icon :icon="['far', 'clock']" />
							</span>
							<span class="menu-item-label">{{ t('timeTracking.title') }}</span>
						</RouterLink>
					</li>
				</menu>

				<p
					id="nav-group-organize"
					class="nav-group-label"
				>
					{{ t('navigation.groups.organize') }}
				</p>
				<menu
					class="menu-list other-menu-items"
					aria-labelledby="nav-group-organize"
				>
					<li>
						<RouterLink
							v-shortcut="SHORTCUTS.navigation.labels"
							:to="{ name: 'labels.index'}"
						>
							<span class="menu-item-icon icon">
								<Icon icon="tags" />
							</span>
							<span class="menu-item-label">{{ t('label.title') }}</span>
						</RouterLink>
					</li>
					<li>
						<RouterLink
							v-shortcut="SHORTCUTS.navigation.teams"
							data-tour="nav-teams"
							:to="{ name: 'teams.index'}"
						>
							<span class="menu-item-icon icon">
								<Icon icon="users" />
							</span>
							<span class="menu-item-label">{{ t('team.title') }}</span>
						</RouterLink>
					</li>
				</menu>
			</nav>

			<Loading
				v-if="projectList.isLoading"
				variant="small"
			/>
			<!-- A failed load is not "no projects" (D1). -->
			<LoadError
				v-else-if="projectList.isError && !projectList.hasProjects"
				class="menu-load-error"
				:message="t('navigation.projectsLoadError')"
				:retry="() => projectList.refetch()"
			/>
			<template v-else>
				<nav
					v-if="favoriteProjects.length"
					class="menu project-menu"
					aria-labelledby="nav-group-favorites"
				>
					<p
						id="nav-group-favorites"
						class="nav-group-label"
					>
						{{ t('project.pseudo.favorites.title') }}
					</p>
					<ProjectsNavigation
						:model-value="favoriteProjects"
						:can-edit-order="false"
						:can-collapse="false"
					/>
				</nav>

				<nav
					v-if="savedFilterProjects.length"
					class="menu project-menu"
					aria-labelledby="nav-group-saved-filters"
				>
					<p
						id="nav-group-saved-filters"
						class="nav-group-label"
					>
						{{ t('navigation.savedFilters') }}
					</p>
					<ProjectsNavigation
						:model-value="savedFilterProjects"
						:can-edit-order="false"
						:can-collapse="false"
					/>
				</nav>

				<nav
					class="menu project-menu"
					aria-labelledby="nav-group-projects"
				>
					<p
						id="nav-group-projects"
						class="nav-group-label"
					>
						{{ t('project.projects') }}
					</p>
					<ProjectsNavigation
						:model-value="projects"
						:can-edit-order="true"
						:can-collapse="true"
					/>
				</nav>
			</template>

			<footer class="menu-footer">
				<div class="menu-brand">
					<TcyBrand />
					<span
						class="menu-brand-separator"
						aria-hidden="true"
					>·</span>
					<PoweredByLink utm-medium="navigation" />
				</div>
				<SystemStatus />
			</footer>
		</div>

		<div
			v-if="!isMobile"
			class="resize-handle"
			role="separator"
			tabindex="0"
			aria-orientation="vertical"
			aria-controls="app-sidebar"
			:aria-label="t('navigation.resizeSidebar')"
			:aria-valuenow="currentWidth"
			:aria-valuemin="MIN_SIDEBAR_WIDTH"
			:aria-valuemax="MAX_SIDEBAR_WIDTH"
			@mousedown="startResize"
			@touchstart="startResize"
			@keydown="resizeWithKeyboard"
			@dblclick="resetWidth"
		/>
	</aside>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
const {t} = useI18n({useScope: 'global'})
import {computed, nextTick, ref, watch} from 'vue'
import {useEventListener} from '@vueuse/core'
import {useRoute} from 'vue-router'
import AronaAvatar from '@/components/ai/AronaAvatar.vue'
import SystemStatus from '@/components/home/SystemStatus.vue'
import TcyBrand from '@/components/home/TcyBrand.vue'
import BaseButton from '@/components/base/BaseButton.vue'

import {SHORTCUTS} from '@/constants/shortcuts'
import PoweredByLink from '@/components/home/PoweredByLink.vue'
import Logo from '@/components/home/Logo.vue'
import Loading from '@/components/misc/Loading.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

import {useBaseStore} from '@/stores/base'
import {useProjects} from '@/composables/useProjects'
import {useConfigStore} from '@/stores/config'
import {PRO_FEATURE} from '@/constants/proFeatures'
import ProjectsNavigation from '@/components/home/ProjectsNavigation.vue'
import {MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarResize} from '@/composables/useSidebarResize'

const baseStore = useBaseStore()
const projectList = useProjects()
const route = useRoute()
// Every Compass page (space, entry, editor) belongs to the one sidebar entry.
const isCompassRoute = computed(() => String(route.name ?? '').startsWith('compass.'))
const configStore = useConfigStore()

const timeTrackingEnabled = computed(() => configStore.isProFeatureEnabled(PRO_FEATURE.TIME_TRACKING))

const {
	sidebarWidthStyle,
	currentWidth,
	isResizing,
	startResize,
	resizeWithKeyboard,
	resetWidth,
	isMobile,
} = useSidebarResize()

const sidebar = ref<HTMLElement>()
const drawerOpen = computed(() => isMobile.value && baseStore.menuActive)
const mobileAssistant = computed(() => isMobile.value && route.name === 'tcy-ai')

function focusMenuButton() {
	// The header is inert while the drawer is open, so focus can only move after the next render.
	void nextTick(() => document.querySelector<HTMLElement>(
		mobileAssistant.value ? '[data-mobile-history-toggle]' : '.menu-show-button',
	)?.focus({preventScroll: true}))
}

function closeDrawer() {
	baseStore.setMenuActive(false)
	focusMenuButton()
}

// Opening the drawer moves focus into it; a guide (or any dialog) on top keeps its own focus.
// Closing it after a link was followed hides the focused link: focus goes to the new page's content, not <body>.
watch(drawerOpen, async open => {
	await nextTick()
	if (document.querySelector('dialog[open]')) return
	if (open) {
		sidebar.value?.querySelector<HTMLElement>('.top-menu a')?.focus({preventScroll: true})
		return
	}
	const active = document.activeElement
	if (active === null || active === document.body || sidebar.value?.contains(active)) {
		document.getElementById('main-content')?.focus({preventScroll: true})
	}
})

// The mobile drawer is modal-like; Escape closes it unless a dialog on top owns the key.
useEventListener(document, 'keydown', (event: KeyboardEvent) => {
	if (event.key !== 'Escape' || event.defaultPrevented || !drawerOpen.value) return
	if (document.querySelector('dialog[open]')) return
	closeDrawer()
})

const projects = computed(() => projectList.notArchivedRootProjects)
const favoriteProjects = computed(() => projectList.favoriteProjects)
const savedFilterProjects = computed(() => projectList.savedFilterProjects)
</script>

<style lang="scss" scoped>
.menu-load-error {
	margin: var(--space-2) var(--space-3);
	font-size: var(--text-sm);
}

.menu-container {
	--sidebar-width: #{$navbar-width};

	position: fixed;
	inset-block: var(--header-height) 0;
	inset-inline-start: 0;
	display: flex;
	flex-direction: column;
	inline-size: var(--sidebar-width);
	background: var(--surface-app);
	border-inline-end: 1px solid var(--border-subtle);
	color: var(--text-secondary);
	// Hidden once the slide-out finishes so off-screen links leave the tab order;
	// shortcuts still reach them through programmatic click().
	visibility: hidden;
	transform: translateX(-100%);
	transition:
		transform var(--motion-base) var(--ease-exit),
		visibility 0s linear var(--motion-base);

	[dir="rtl"] & {
		transform: translateX(100%);
	}

	// Phones get a modal drawer over the header, above the scrim.
	@media screen and (max-width: $tablet - 1px) {
		inset-block-start: 0;
		z-index: var(--layer-sidebar);
		background: var(--surface-raised);
		border-inline-end-color: var(--border-default);
		box-shadow: var(--elevation-3);
	}

	&.is-active {
		visibility: visible;
		transform: translateX(0);
		transition:
			transform var(--motion-base) var(--ease-enter),
			visibility 0s;
	}

	&.is-resizing {
		transition: none;
	}

	&.is-mobile-assistant {
		inset-block: var(--visual-viewport-top, 0) auto;
		inset-inline-start: var(--visual-viewport-left, 0);
		max-inline-size: var(--visual-viewport-width, 100%);
		block-size: var(--visual-viewport-height, 100dvh);
		padding-block-start: env(safe-area-inset-top, 0);
		padding-inline-start: env(safe-area-inset-left, 0);

		.menu-header {
			position: sticky;
			inset-block-start: 0;
			z-index: 2;
			flex-shrink: 0;
			padding-block-end: var(--space-2);
			background: var(--surface-raised);
		}
	}
}

.mobile-assistant-site-actions {
	display: none;

	.is-mobile-assistant & {
		display: block;
	}
}

.menu-scroll {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-block-size: 0;
	padding-block: var(--space-3) 0;
	overflow-y: auto;
	overscroll-behavior: contain;

	// Keeps the scrollbar clear of the resize handle on the inline-end edge.
	@media screen and (min-width: $tablet) {
		margin-inline-end: 6px;
	}
}

.menu-header {
	display: none;

	@media screen and (max-width: $tablet - 1px) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding-inline: var(--space-4) var(--space-2);
		margin-block-end: var(--space-2);
	}
}

.logo {
	display: flex;
	align-items: center;
	min-block-size: var(--target-min);

	:deep(.logo) {
		block-size: 1.75rem;
		inline-size: auto;
	}
}

.menu-hide-button {
	display: flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--nav-row-height);
	block-size: var(--nav-row-height);
	border-radius: $radius;
	color: var(--text-secondary);
	font-size: var(--text-lg);

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}
}

.menu {
	font-size: var(--text-md);
}

.top-menu .menu-list li {
	font-weight: var(--weight-medium);
}

.menu-item-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	inline-size: 1rem;
	block-size: 1rem;
}

.arona-icon :deep(img) {
	inline-size: 1.25rem;
	block-size: 1.25rem;
	max-inline-size: none;
}

.menu-item-label {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.nav-group-label {
	margin: var(--space-4) 0 var(--space-1);
	padding-inline: var(--space-5) var(--space-4);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.menu-footer {
	margin-block-start: auto;
	padding: var(--space-4) var(--space-3) var(--space-3);
}

.menu-brand {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-1);
	padding-inline: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	:deep(.tcy-brand),
	:deep(.menu-bottom-link) {
		padding: var(--space-1) 0;
		color: var(--text-tertiary);
		font-size: var(--text-xs);

		&:hover {
			color: var(--text-primary);
		}
	}

	:deep(.tcy-brand svg) {
		inline-size: .875rem;
		block-size: .875rem;
	}
}

.resize-handle {
	position: absolute;
	inset-block: 0;
	// Covers the border too, so the whole hit area stays inside the sidebar box.
	inset-inline-end: -1px;
	z-index: 1;
	inline-size: 7px;
	cursor: ew-resize;
	touch-action: none;

	// The visible line sits on the sidebar edge; the wider hit area is invisible.
	&::after {
		content: '';
		position: absolute;
		inset-block: 0;
		inset-inline-end: 0;
		inline-size: 2px;
		background: var(--primary);
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-standard);
	}

	&:hover::after,
	&:active::after,
	&:focus-visible::after {
		opacity: 1;
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -2px;
	}
}

.menu-container.is-resizing .resize-handle::after {
	opacity: 1;
}
</style>
