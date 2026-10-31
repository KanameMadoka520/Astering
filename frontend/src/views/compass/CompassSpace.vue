<template>
	<div class="compass-space-page">
		<CompassThemeScope
			v-if="space"
			:theme="space.theme"
			class="compass-space"
		>
			<CompassHero :space="space" />
			<CompassGuidingLights :space="space" />
			<CompassPreface :space="space" />
			<CompassLibrary :space="space" />
		</CompassThemeScope>

		<CompassThemeScope
			v-else-if="unavailable"
			theme="aurora"
			tag="section"
			class="compass-space-missing"
			aria-labelledby="compass-space-missing-title"
		>
			<CompassGlyph
				kind="guide"
				class="compass-space-missing__glyph"
			/>
			<h1
				id="compass-space-missing-title"
				class="compass-space-missing__title"
			>
				{{ t('compass.home.missingTitle') }}
			</h1>
			<p class="compass-space-missing__text">
				{{ t('compass.home.missing') }}
			</p>
			<RouterLink
				class="compass-space-missing__link"
				:to="{name: 'compass.index'}"
			>
				<Icon
					icon="arrow-left"
					class="compass-space-missing__icon"
				/>
				{{ t('compass.home.backToCompass') }}
			</RouterLink>
		</CompassThemeScope>

		<template v-else-if="failed">
			<h1 class="is-sr-only">
				{{ t('compass.title') }}
			</h1>
			<LoadError :retry="() => refetch()" />
		</template>

		<div
			v-else
			class="compass-space-skeleton"
			role="status"
		>
			<h1 class="is-sr-only">
				{{ t('compass.title') }}
			</h1>
			<span class="is-sr-only">{{ t('compass.home.loadingSpace') }}</span>
			<div
				class="compass-space-skeleton__sky"
				aria-hidden="true"
			>
				<span class="compass-space-skeleton__line is-short" />
				<span class="compass-space-skeleton__line is-title" />
				<span class="compass-space-skeleton__line is-wide" />
			</div>
			<div
				class="compass-space-skeleton__rows"
				aria-hidden="true"
			>
				<span
					v-for="row in 3"
					:key="row"
					class="compass-space-skeleton__line is-row"
				/>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import {computed, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassLibrary from '@/components/compass/library/CompassLibrary.vue'
import CompassGuidingLights from '@/components/compass/space/CompassGuidingLights.vue'
import CompassHero from '@/components/compass/space/CompassHero.vue'
import CompassPreface from '@/components/compass/space/CompassPreface.vue'
import Icon from '@/components/misc/Icon'
import LoadError from '@/components/misc/state/LoadError.vue'
import {useCompassAccountNamespace, useCompassSpace} from '@/composables/useCompass'
import {useTitle} from '@/composables/useTitle'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {rememberCompassSpace} from '@/helpers/compass/storage'

const props = defineProps<{
	spaceId: number
}>()

const {t} = useI18n({useScope: 'global'})
const namespace = useCompassAccountNamespace()
const {space, error, isError, refetch} = useCompassSpace(() => props.spaceId)

useTitle(() => space.value?.title || t('compass.title'))

watch([() => space.value?.id, namespace], ([id, currentNamespace]) => {
	if (id) rememberCompassSpace(currentNamespace, id)
}, {immediate: true})

// Once the space is on screen a failed background refresh keeps it there.
const failure = computed(() => isError.value && !space.value ? classifyCompassFailure(error.value) : null)
const unavailable = computed(() => failure.value === 'missing' || failure.value === 'forbidden')
const failed = computed(() => failure.value !== null && failure.value !== 'aborted')
</script>

<style lang="scss" scoped>
.compass-space-page {
	max-inline-size: var(--page-max-width);
	margin-inline: auto;
}

.compass-space {
	display: flex;
	flex-direction: column;
	gap: clamp(2rem, 4.5vw, 3.25rem);
}

.compass-space-missing {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-3);
	max-inline-size: 34rem;
	margin-block: clamp(2rem, 8vw, 5rem);
	margin-inline: auto;
	padding-inline: var(--space-2);
}

.compass-space-missing__glyph {
	--compass-glyph-size: 1.75rem;
}

.compass-space-missing__title {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.compass-space-missing__text {
	color: var(--text-secondary);
	line-height: var(--leading-normal);
}

.compass-space-missing__link {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	color: var(--accent-text);
	font-weight: var(--weight-medium);

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-space-missing__icon {
	inline-size: .875em;

	[dir='rtl'] & {
		transform: scaleX(-1);
	}
}

.compass-space-skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-8);
}

.compass-space-skeleton__sky {
	display: flex;
	flex-direction: column;
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

.compass-space-skeleton__rows {
	display: flex;
	flex-direction: column;
	gap: var(--space-5);
}

.compass-space-skeleton__line {
	display: block;
	inline-size: 45%;
	max-inline-size: 24rem;
	block-size: .875rem;
	border-radius: var(--radius-xs);
	background: var(--surface-active);
	animation: compass-space-pulse 1.6s var(--ease-standard) infinite alternate;

	&.is-short {
		inline-size: 20%;
		max-inline-size: 8rem;
	}

	&.is-title {
		inline-size: 55%;
		block-size: 2.25rem;
	}

	&.is-wide {
		inline-size: 70%;
		max-inline-size: 32rem;
	}

	&.is-row {
		inline-size: 100%;
		max-inline-size: 48rem;
		block-size: 3.5rem;
		border-radius: var(--radius-sm);
	}

	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
}

@keyframes compass-space-pulse {
	from {
		opacity: 1;
	}

	to {
		opacity: .5;
	}
}
</style>
