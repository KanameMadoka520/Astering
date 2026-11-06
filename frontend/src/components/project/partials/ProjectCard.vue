<template>
	<div
		class="project-card"
		:class="{
			'has-light-text': Boolean(background),
			'has-background': Boolean(blurHashUrl || background),
			'has-status': hasStatus,
			'has-color': Boolean(project.hex_color),
		}"
		:style="{
			'--project-color': project.hex_color || undefined,
			'background-image': blurHashUrl ? `url(${blurHashUrl})` : undefined,
		}"
	>
		<div
			class="project-background background-fade-in"
			:class="{'is-visible': background}"
			:style="{'background-image': background ? `url(${background})` : undefined}"
		/>
		<span
			v-if="hasStatus"
			class="project-card-status"
		>
			<ProjectStatusBadges
				:is-completed="isCompleted"
				:is-archived="project.is_archived"
			/>
		</span>

		<div class="project-card-text">
			<p
				v-if="parentPath"
				class="project-parent"
			>
				{{ $t('projectList.parentPath', {path: parentPath}) }}
			</p>
			<div
				class="project-title"
				aria-hidden="true"
			>
				<span
					v-if="project.id < -1"
					class="saved-filter-icon icon"
				>
					<Icon icon="filter" />
				</span>
				{{ getProjectTitle(project) }}
			</div>
			<ProjectAccessBadge
				class="project-access"
				:project="project"
			/>
		</div>
		<BaseButton
			class="project-button"
			:aria-label="project.title"
			:title="textOnlyDescription"
			:to="{
				name: 'project.index',
				params: { projectId: project.id}
			}"
		/>
		<div class="project-actions">
			<BaseButton
				v-if="!project.is_archived && project.id > -1"
				class="favorite"
				:aria-label="project.is_favorite ? $t('project.unfavorite') : $t('project.favorite')"
				:class="{'is-favorite': project.is_favorite}"
				@click.prevent.stop="toggleProjectFavorite"
			>
				<Icon :icon="project.is_favorite ? 'star' : ['far', 'star']" />
			</BaseButton>
			<ProjectSettingsDropdown
				v-if="typeof project.max_permission === 'number' && (project.id > 0 || project.max_permission > PERMISSIONS.READ) && project.id !== -1"
				class="settings-dropdown"
				:project="project"
			/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import {computed} from 'vue'
import {usePatchProjectFavoriteMutation, type ProjectResponse} from '@/client/queries/projects'

import BaseButton from '@/components/base/BaseButton.vue'
import ProjectSettingsDropdown from '@/components/project/ProjectSettingsDropdown.vue'
import ProjectStatusBadges from '@/components/project/partials/ProjectStatusBadges.vue'
import ProjectAccessBadge from '@/components/sharing/ProjectAccessBadge.vue'
import {PERMISSIONS} from '@/constants/permissions'

import {useProjectBackground} from '@/composables/useProjectBackground'
import {useProjects} from '@/composables/useProjects'
import {getProjectTitle} from '@/helpers/getProjectTitle'

const props = defineProps<{
	project: ProjectResponse,
}>()

const {background, blurHashUrl} = useProjectBackground(() => props.project)
const projectList = useProjects()

const favoriteMutation = usePatchProjectFavoriteMutation()

async function toggleProjectFavorite() {
	if (props.project.id <= 0 || props.project.is_archived) {
		return
	}
	await favoriteMutation.mutateAsync({id: props.project.id, isFavorite: !props.project.is_favorite})
}

const textOnlyDescription = computed(() => {
	return props.project.description ? props.project.description.replace(/<[^>]*>/g, '') : ''
})

const isCompleted = computed(() => Boolean(props.project.is_completed))
const hasStatus = computed(() => isCompleted.value || props.project.is_archived)

const parentPath = computed(() => {
	if (props.project.parent_project_id <= 0) {
		return ''
	}
	return projectList.getAncestors(props.project)
		.slice(0, -1)
		.map(ancestor => getProjectTitle(ancestor))
		.join(' / ')
})
</script>

<style lang="scss" scoped>
.project-card {
	--project-card-padding: var(--space-3);
	--project-card-action-size: var(--control-height-sm);
	--project-title-lines: 2;

	position: relative;
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
	padding: var(--project-card-padding);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	// No overflow clipping here: the settings menu opens out of the card.
	&.has-color {
		border-inline-start: 4px solid var(--project-color);
	}

	&:hover {
		border-color: var(--border-default);
		box-shadow: var(--elevation-2);
	}

	> * {
		// so the elements are on top of the background
		position: relative;
	}

	// Always-visible touch actions need a full-size target.
	@media (pointer: coarse) {
		--project-card-action-size: var(--target-min);
	}
}

.has-background,
.project-background {
	background-size: cover;
	background-repeat: no-repeat;
	background-position: center;
}

.project-background,
.project-button {
	position: absolute;
	inset: 0;
}

// Clip here instead of on the card so the settings dropdown can overflow it.
.project-background {
	border-radius: inherit;
}

// Photos get a bottom scrim so the title keeps its contrast in both colour schemes.
.has-background .project-background::after {
	content: '';
	position: absolute;
	inset: 0;
	border-radius: inherit;
	background: linear-gradient(to top, var(--scrim), transparent 75%);
}

.project-card-status {
	align-self: flex-start;
	max-inline-size: calc(100% - 2 * var(--project-card-action-size));
	border-radius: var(--radius-full);
}

// The tinted badges are translucent and would be unreadable on a photo.
.has-background .project-card-status {
	background: var(--surface);
}

.project-card-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-block-size: 0;
	margin-block-start: auto;
	pointer-events: none;
}

.project-parent {
	margin: 0;
	overflow: hidden;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-tight);
	white-space: nowrap;
	text-overflow: ellipsis;
}

.project-title {
	display: -webkit-box;
	min-block-size: 0;
	margin-block-end: 0;
	overflow: hidden;
	color: var(--text-primary);
	font-family: $vikunja-font;
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	text-overflow: ellipsis;
	word-break: break-word;
	-webkit-line-clamp: var(--project-title-lines);
	-webkit-box-orient: vertical;
}

.project-access {
	align-self: flex-start;
}

// Fixed white, not var(--white): that turns near-black in dark mode and the photo stays as bright as it is.
.has-background .project-title,
.has-background .project-parent,
.has-background .project-access,
.has-background .project-access :deep(.project-access-badge__icon) {
	color: var(--text-on-accent);
	text-shadow: 0 1px 3px hsla(220, 30%, 6%, .6);
}

.project-button {
	border-radius: inherit;

	&:focus-visible {
		@include focus-ring;
		outline-offset: -2px;
	}
}

.project-actions {
	position: absolute;
	inset-block-start: var(--space-2);
	inset-inline-end: var(--space-2);
	display: flex;
	align-items: center;
	gap: 2px;
}

.favorite,
.settings-dropdown :deep(.dropdown-trigger) {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-inline-size: var(--project-card-action-size);
	min-block-size: var(--project-card-action-size);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);

	&:hover {
		background: var(--surface-hover);
	}
}

.has-background .favorite,
.has-background .settings-dropdown :deep(.dropdown-trigger) {
	background: var(--surface);
	color: var(--text-primary);
}

.favorite,
.settings-dropdown {
	transition: opacity var(--motion-fast) var(--ease-standard);
	opacity: 1;
}

.favorite {
	&:hover {
		color: var(--warning);
	}

	&.is-favorite {
		opacity: 1;
		color: var(--warning);
	}
}

@media(hover: hover) and (pointer: fine) {
	.project-card .favorite,
	.project-card .settings-dropdown {
		opacity: 0;
	}

	// Keyboard users reach the actions by tabbing into the card.
	.project-card:hover .favorite,
	.project-card:hover .settings-dropdown,
	.project-card:focus-within .favorite,
	.project-card:focus-within .settings-dropdown,
	.project-card .favorite.is-favorite,
	.settings-dropdown:has([aria-expanded="true"]) {
		opacity: 1;
	}
}

.background-fade-in {
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-standard) var(--motion-base);

	&.is-visible {
		opacity: 1;
	}
}

.saved-filter-icon {
	color: var(--text-tertiary);
	font-size: .75em;
}
</style>
