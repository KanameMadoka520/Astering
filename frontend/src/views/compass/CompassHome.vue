<template>
	<div class="compass-home">
		<CompassWelcome v-if="loaded && spaces.length === 0" />

		<template v-else-if="!loaded && isError">
			<h1 class="is-sr-only">
				{{ t('compass.title') }}
			</h1>
			<LoadError :retry="() => refetch()" />
		</template>

		<div
			v-else
			class="compass-home__skeleton"
			role="status"
		>
			<h1 class="is-sr-only">
				{{ t('compass.title') }}
			</h1>
			<span class="is-sr-only">{{ t('compass.home.loading') }}</span>
			<div
				class="compass-home__skeleton-sky"
				aria-hidden="true"
			>
				<span class="compass-home__skeleton-line is-title" />
				<span class="compass-home__skeleton-line is-wide" />
				<span class="compass-home__skeleton-line" />
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import {computed, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'
import CompassWelcome from '@/components/compass/space/CompassWelcome.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {CompassSpace} from '@/client/queries/compass'
import {useCompassAccountNamespace, useCompassSpaces} from '@/composables/useCompass'
import {readLastCompassSpace} from '@/helpers/compass/storage'

const {t} = useI18n({useScope: 'global'})
const router = useRouter()
const namespace = useCompassAccountNamespace()
const {data, spaces, isError, refetch} = useCompassSpaces()

const loaded = computed(() => data.value !== undefined)

function preferredSpace(list: CompassSpace[]): CompassSpace {
	const last = readLastCompassSpace(namespace.value)
	return list.find(space => space.id === last)
		?? list.find(space => space.team_id === 0)
		?? list[0]
}

let redirecting = false
watch(spaces, list => {
	if (redirecting || list.length === 0) return
	if (router.currentRoute.value.name !== 'compass.index') return
	redirecting = true
	void router.replace({
		name: 'compass.space',
		params: {spaceId: preferredSpace(list).id},
	})
}, {immediate: true})
</script>

<style lang="scss" scoped>
.compass-home {
	max-inline-size: var(--page-max-width);
	margin-inline: auto;
}

.compass-home__skeleton-sky {
	display: flex;
	flex-direction: column;
	justify-content: flex-start;
	gap: var(--space-3);
	min-block-size: clamp(13rem, 24vw, 20rem);
	padding: clamp(1.25rem, 3.4vw, 2.5rem);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface-sunken);

	@media screen and (max-width: $tablet - 1px) {
		min-block-size: 10.5rem;
		border-radius: var(--radius-md);
	}
}

.compass-home__skeleton-line {
	display: block;
	inline-size: 40%;
	max-inline-size: 22rem;
	block-size: .875rem;
	border-radius: var(--radius-xs);
	background: var(--surface-active);
	animation: compass-home-pulse 1.6s var(--ease-standard) infinite alternate;

	&.is-title {
		inline-size: 55%;
		block-size: 2rem;
		margin-block-end: var(--space-2);
	}

	&.is-wide {
		inline-size: 70%;
		max-inline-size: 30rem;
	}

	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
}

@keyframes compass-home-pulse {
	from {
		opacity: 1;
	}

	to {
		opacity: .5;
	}
}
</style>
