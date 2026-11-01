<template>
	<li
		class="list-menu loader-container is-loading-small"
		:class="{
			'is-loading': showLoading,
			'is-drop-target': isDropTarget,
		}"
		:data-project-id="project.id"
	>
		<div
			class="navigation-item"
			:class="{'is-current': isCurrent}"
		>
			<BaseButton
				v-if="canCollapse && childProjects?.length > 0"
				class="collapse-project-button"
				:aria-label="$t('navigation.toggleChildProjects')"
				:aria-expanded="childProjectsOpen"
				@click="childProjectsOpen = !childProjectsOpen"
			>
				<Icon
					icon="chevron-down"
					:class="{ 'project-is-collapsed': !childProjectsOpen }"
				/>
			</BaseButton>
			<BaseButton
				:to="{ name: 'project.index', params: { projectId: project.id} }"
				class="list-menu-link"
				:class="{'router-link-exact-active': isCurrent}"
				:aria-current="isCurrent ? 'page' : undefined"
			>
				<span
					v-if="!canCollapse || childProjects?.length === 0"
					class="collapse-project-button-placeholder"
				/>
				<div class="color-bubble-wrapper">
					<ColorBubble
						v-if="project.hex_color !== ''"
						:color="project.hex_color"
					/>
					<span
						v-else-if="project.id < -1"
						class="saved-filter-icon icon menu-item-icon"
					>
						<Icon icon="filter" />
					</span>
					<span
						v-if="canEditOrder && project.id > 0 && typeof project.max_permission === 'number' && project.max_permission > PERMISSIONS.READ"
						class="icon menu-item-icon handle drag-handle"
						@mousedown.stop
						@click.stop.prevent
						@touchstart.stop
					>
						<Icon icon="grip-lines" />
					</span>
				</div>
				<span class="project-menu-title">{{ getProjectTitle(project) }}</span>
			</BaseButton>
			<BaseButton
				v-if="canToggleFavorite"
				class="favorite"
				:class="{'is-favorite': project.is_favorite}"
				@click="toggleProjectFavorite"
			>
				<span class="is-sr-only">{{ project.is_favorite ? $t('project.unfavorite') : $t('project.favorite') }}</span>
				<Icon :icon="project.is_favorite ? 'star' : ['far', 'star']" />
			</BaseButton>
			<ProjectSettingsDropdown
				v-if="typeof project.max_permission === 'number' && project.max_permission > PERMISSIONS.READ"
				class="menu-list-dropdown"
				:project="project"
			>
				<template #trigger="{toggleOpen, open}">
					<BaseButton
						class="menu-list-dropdown-trigger"
						:aria-expanded="open"
						@click="toggleOpen"
					>
						<span class="is-sr-only">{{ $t('project.openSettingsMenu') }}</span>
						<Icon
							icon="ellipsis-h"
							class="icon"
						/>
					</BaseButton>
				</template>
			</ProjectSettingsDropdown>
		</div>
		<ProjectsNavigation
			v-if="childProjectsOpen && canCollapse"
			:model-value="childProjects"
			:can-edit-order="true"
			:can-collapse="canCollapse"
		/>
	</li>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useProjects} from '@/composables/useProjects'
import {useBaseStore} from '@/stores/base'
import {useTaskDragState} from '@/composables/useTaskDragState'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useStorage} from '@vueuse/core'

import type {ProjectResponse} from '@/client/queries/projects'

import BaseButton from '@/components/base/BaseButton.vue'
import ProjectSettingsDropdown from '@/components/project/ProjectSettingsDropdown.vue'
import {getProjectTitle} from '@/helpers/getProjectTitle'
import ColorBubble from '@/components/misc/ColorBubble.vue'
import ProjectsNavigation from '@/components/home/ProjectsNavigation.vue'
import {PERMISSIONS} from '@/constants/permissions'
import {
	getSavedFilterIdFromProjectId,
	isSavedFilterProject,
	usePatchProjectFavoriteMutation,
} from '@/client/queries/projects'
import {usePatchSavedFilterFavoriteMutation} from '@/client/queries/savedFilters'

const props = defineProps<{
	project: ProjectResponse,
	isLoading?: boolean,
	canCollapse?: boolean,
	canEditOrder?: boolean,
}>()

const showLoading = useDelayedLoading(() => props.isLoading)

// The drag state tracks the hovered project once for all rows.
const {draggedTask, hoveredProjectId} = useTaskDragState()

// Show drop target highlight when a task is being dragged and this project is hovered
const isDropTarget = computed(() => {
	if (!draggedTask.value || hoveredProjectId.value !== props.project.id) {
		return false
	}
	// Highlight any valid project (not a pseudo project, has write permission)
	// The actual drop logic will handle the case when it's the same project (no-op)
	return props.project.id > 0
		&& typeof props.project.max_permission === 'number'
		&& props.project.max_permission > PERMISSIONS.READ
})

const projectList = useProjects()
const projectFavoriteMutation = usePatchProjectFavoriteMutation()
const savedFilterFavoriteMutation = usePatchSavedFilterFavoriteMutation()
const baseStore = useBaseStore()
// Every view of the current project highlights its row, not only the exact project route. The id is enough: loading
// the current project in every row would add two queries per row and wait for them.
const isCurrent = computed(() => baseStore.currentProjectId === props.project.id)

// Persist open state across browser reloads. Using a separate ref for the state 
// allows us to use only one entry in local storage instead of one for every project id.
type OpenState = { [key: number]: boolean }
const childProjectsOpenState = useStorage<OpenState>('navigation-child-projects-open', {})
const childProjectsOpen = computed({
	get() {
		return childProjectsOpenState.value[props.project.id] ?? true
	},
	set(open) {
		childProjectsOpenState.value[props.project.id] = open
	},
})

const childProjects = computed(() => {
	return projectList.getChildProjects(props.project.id)
		.filter(p => !p.is_archived)
})

const canToggleFavorite = computed(() => {
	// Allow favorite toggle for:
	// 1. Regular projects (id > 0) with write permission
	// 2. Saved filters (id < -1) - user owns their own filters
	if (props.project.id === -1) return false  // Favorites pseudo-project
	if (props.project.id > 0) {
		return typeof props.project.max_permission === 'number' &&
			props.project.max_permission > PERMISSIONS.READ
	}
	// Saved filters (negative IDs except -1)
	return isSavedFilterProject(props.project)
})

async function toggleProjectFavorite() {
	const project = props.project
	if (!canToggleFavorite.value || project.is_archived) {
		return
	}

	const isFavorite = !project.is_favorite
	if (isSavedFilterProject(project)) {
		await savedFilterFavoriteMutation.mutateAsync({
			id: getSavedFilterIdFromProjectId(project.id),
			isFavorite,
		})
		return
	}
	await projectFavoriteMutation.mutateAsync({id: project.id, isFavorite})
}
</script>

<style lang="scss" scoped>
.list-menu {
	border-radius: var(--radius-sm);
}

.project-is-collapsed {
	transform: rotate(-90deg);

	[dir="rtl"] & {
		transform: rotate(90deg);
	}
}

.favorite {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	inline-size: var(--control-height-sm);
	block-size: var(--control-height-sm);
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	transition:
		opacity var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover,
	&.is-favorite {
		color: var(--warning);
	}
}

// Fine pointers reveal the star on hover; touch keeps it visible so it can be reached at all.
@media (hover: hover) and (pointer: fine) {
	.favorite:not(.is-favorite) {
		opacity: 0;
	}

	.list-menu:hover > div > .favorite {
		opacity: 1;
	}
}

.list-menu:hover .color-bubble-wrapper > .drag-handle {
	opacity: 1;
}

.list-menu:hover .color-bubble-wrapper > .color-bubble {
	opacity: 0;
}

.color-bubble-wrapper {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	inline-size: 1rem;
	block-size: 1rem;

	.color-bubble,
	.icon {
		position: absolute;
		margin: 0 !important;
		padding: 0 !important;
		transition: opacity var(--motion-fast) var(--ease-standard);
	}

	.color-bubble {
		inline-size: .625rem;
		block-size: .625rem;
	}
}

.drag-handle {
	opacity: 0;
	cursor: grab;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;

	&:active {
		cursor: grabbing;
	}
}

.project-menu-title {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.saved-filter-icon {
	color: var(--text-tertiary) !important;
	font-size: var(--text-xs);
}

@media (pointer: coarse) {
	.drag-handle {
		display: none !important;
	}

	.color-bubble {
		opacity: 1 !important;
	}
}

// The link is the row's main control, so its focus ring outlines the whole row.
.navigation-item:has(> .list-menu-link:focus-visible) {
	@include focus-ring;

	outline-offset: 0;
}

.navigation-item:has(*:focus-visible) {
	.favorite,
	.menu-list-dropdown {
		opacity: 1;
	}
}

.navigation-item > .list-menu-link:focus-visible {
	outline: none;
}

.is-drop-target {
	background-color: var(--surface-selected);

	.navigation-item {
		background-color: var(--surface-selected-strong);
		box-shadow: inset 0 0 0 2px var(--primary);
	}
}
</style>
