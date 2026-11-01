<template>
	<div class="teams-page is-max-width-desktop">
		<PageHeader
			:title="$t('team.title')"
			:description="$t('team.description')"
		>
			<template #actions>
				<XButton
					:to="{name:'teams.create'}"
					icon="plus"
				>
					{{ $t('team.create.title') }}
				</XButton>
			</template>
		</PageHeader>

		<LoadError
			v-if="isError && teams.length === 0"
			:retry="() => refetch()"
		/>

		<div
			v-else-if="isPending"
			class="teams-skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ $t('misc.loading') }}</span>
			<span
				v-for="row in 3"
				:key="row"
				class="teams-skeleton__row"
				aria-hidden="true"
			/>
		</div>

		<Card
			v-else-if="teams.length > 0"
			:padding="false"
			:has-content="false"
			class="teams-card"
			:class="{'is-refreshing': isFetching}"
			:aria-busy="isFetching"
		>
			<ul class="teams">
				<li
					v-for="team in teams"
					:key="team.id"
				>
					<RouterLink :to="{name: 'teams.edit', params: {id: team.id}}">
						{{ team.name }}
					</RouterLink>
				</li>
			</ul>
		</Card>

		<EmptyState
			v-else
			icon="users"
			:title="$t('team.noTeams')"
		>
			<XButton
				:to="{name: 'teams.create'}"
				variant="secondary"
				icon="plus"
				:shadow="false"
			>
				{{ $t('team.create.title') }}
			</XButton>
		</EmptyState>

		<Pagination
			:total-pages="totalPages"
			:current-page="page"
		/>
	</div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {useRouteQuery} from '@vueuse/router'

import Card from '@/components/misc/Card.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import EmptyState from '@/components/misc/state/EmptyState.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {normalizePageNumber} from '@/client/queries/pagination'
import {useClampedPage} from '@/composables/useClampedPage'
import {useTeamsPage} from '@/composables/useTeams'
import { useTitle } from '@/composables/useTitle'

const { t } = useI18n({useScope: 'global'})
useTitle(() => t('team.title'))

const page = useRouteQuery('page', '1', {transform: normalizePageNumber})
const teamsPage = useTeamsPage(page)
const {teams, totalPages, isFetching, isPending, isError, refetch} = teamsPage
useClampedPage(page, teamsPage)
</script>

<style lang="scss" scoped>
.teams-card {
	transition: opacity var(--motion-base) var(--ease-standard);

	&.is-refreshing {
		opacity: .85;
	}
}

ul.teams {
	margin: 0;
	padding: var(--space-1);
	list-style: none;

	li {
		margin: 0;

		& + li {
			border-block-start: 1px solid var(--border-subtle);
		}
	}

	a {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-block-size: 2.5rem;
		padding: var(--space-2) var(--space-3);
		border-radius: $radius;
		color: var(--text-primary);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;

		// A chevron from CSS keeps the item's text exactly the team name.
		&::after {
			content: '';
			flex: none;
			inline-size: .45rem;
			block-size: .45rem;
			border-block-start: 2px solid var(--text-tertiary);
			border-inline-end: 2px solid var(--text-tertiary);
			transform: rotate(45deg);
		}

		&:hover {
			background: var(--surface-hover);
		}

		&:focus-visible {
			outline-offset: -2px;
		}

		@media (pointer: coarse) {
			min-block-size: var(--target-min);
		}
	}
}

[dir="rtl"] ul.teams a::after {
	transform: rotate(-45deg);
}

.teams-skeleton {
	display: grid;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
}

.teams-skeleton__row {
	block-size: 1.75rem;
	inline-size: 40%;
	border-radius: var(--radius-xs);
	background: var(--surface-active);

	&:nth-child(2n) {
		inline-size: 55%;
	}
}
</style>
