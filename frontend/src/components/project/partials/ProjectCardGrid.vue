<template>
	<ul
		class="project-grid"
		:class="{ 'show-even-number-of-projects': showEvenNumberOfProjects }"
	>
		<li
			v-for="item in filteredProjects"
			:key="item.id"
			class="project-grid-item"
		>
			<ProjectCard :project="item" />
		</li>
	</ul>
</template>

<script lang="ts" setup>
import {computed} from 'vue'
import type {ProjectResponse} from '@/client/queries/projects'

import ProjectCard from './ProjectCard.vue'

const props = withDefaults(defineProps<{
	projects: ProjectResponse[],
	showArchived?: boolean,
	itemLimit?: boolean,
	showEvenNumberOfProjects?: boolean,
}>(), {
	showArchived: false,
	itemLimit: false,
	showEvenNumberOfProjects: false,
})

const filteredProjects = computed(() => {
	return props.showArchived
		? props.projects
		: props.projects.filter(project => !project.is_archived)
})
</script>

<style lang="scss" scoped>
.project-grid {
	--project-grid-item-height: 7.25rem;
	--project-grid-gap: var(--space-3);
	--project-grid-min-column: 14rem;

	display: grid;
	// min() keeps a single column from overflowing containers narrower than the minimum.
	grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--project-grid-min-column)), 1fr));
	// Rows grow past the minimum instead of clipping long (for example Chinese) titles.
	grid-auto-rows: minmax(var(--project-grid-item-height), auto);
	gap: var(--project-grid-gap);
	margin: 0; // reset li
	padding: 0;
	list-style-type: none;

	@media screen and (max-width: $tablet) {
		--project-grid-item-height: 6.25rem;
		--project-grid-gap: var(--space-2);
	}

	&.show-even-number-of-projects {
		@media screen and (min-width: $widescreen) {
			.project-grid-item:nth-child(5) {
				display: none;
			}
		}
	}
}

.project-grid-item {
	display: grid;
	min-inline-size: 0;
	margin-block-start: 0; // remove padding coming form .content li + li
}
</style>
