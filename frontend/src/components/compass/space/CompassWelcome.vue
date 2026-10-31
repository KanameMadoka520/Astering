<template>
	<CompassThemeScope
		theme="aurora"
		tag="section"
		class="compass-welcome"
		aria-labelledby="compass-welcome-title"
	>
		<CompassSkyHeader>
			<div class="compass-welcome__intro">
				<p class="compass-welcome__eyebrow">
					<CompassGlyph kind="guide" />
					{{ t('compass.home.eyebrow') }}
				</p>
				<h1
					id="compass-welcome-title"
					class="compass-welcome__title"
				>
					{{ t('compass.title') }}
				</h1>
				<p class="compass-welcome__lead">
					{{ t('compass.home.lead') }}
				</p>
			</div>
		</CompassSkyHeader>

		<div class="compass-welcome__body">
			<h2 class="compass-welcome__heading">
				{{ t('compass.home.kindsTitle') }}
			</h2>
			<ul class="compass-welcome__kinds">
				<li
					v-for="kind in COMPASS_KINDS"
					:key="kind"
					class="compass-welcome__kind"
				>
					<CompassGlyph
						class="compass-welcome__glyph"
						:kind="kind"
					/>
					<span class="compass-welcome__kind-name">{{ t(`compass.kind.${kind}`) }}</span>
					<span class="compass-welcome__kind-hint">{{ t(`compass.kindHint.${kind}`) }}</span>
				</li>
			</ul>

			<p class="compass-welcome__privacy">
				<Icon
					icon="lock"
					class="compass-welcome__privacy-icon"
				/>
				<span>{{ t('compass.home.privacy') }}</span>
			</p>

			<div class="compass-welcome__actions">
				<XButton
					icon="feather"
					:shadow="false"
					:loading="createSpace.isPending.value"
					@click="createPrivateSpace"
				>
					{{ t('compass.home.create') }}
				</XButton>
				<RouterLink
					class="compass-welcome__customize"
					:to="{name: 'compass.space.new'}"
				>
					{{ t('compass.home.customize') }}
				</RouterLink>
			</div>
			<p class="compass-welcome__note">
				{{ t('compass.home.createHint', {title: defaultTitle}) }}
			</p>
		</div>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import CompassSkyHeader from './CompassSkyHeader.vue'
import {useCreateCompassSpaceMutation} from '@/client/queries/compass'
import {COMPASS_KINDS} from '@/helpers/compass/constants'

const {t} = useI18n({useScope: 'global'})
const router = useRouter()
const createSpace = useCreateCompassSpaceMutation()

const defaultTitle = computed(() => t('compass.home.defaultTitle'))

async function createPrivateSpace() {
	if (createSpace.isPending.value) return
	let spaceId: number
	try {
		const space = await createSpace.mutateAsync({
			title: defaultTitle.value,
			motto: '',
			introduction: '',
			theme: 'aurora',
			team_id: 0,
		})
		spaceId = space.id
	} catch {
		// The mutation toasts the failure; an account switch mid-request needs nothing at all.
		return
	}
	// The home view may already have followed the new space in; never pull someone back who left.
	if (router.currentRoute.value.name !== 'compass.index') return
	await router.replace({
		name: 'compass.space',
		params: {spaceId},
	})
}
</script>

<style lang="scss" scoped>
.compass-welcome {
	display: flex;
	flex-direction: column;
	gap: clamp(1.75rem, 4vw, 2.75rem);
}

.compass-welcome__intro {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-inline-size: 38rem;
}

.compass-welcome__eyebrow {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	letter-spacing: .04em;
}

.compass-welcome__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(2.25rem, 5vw, 3.25rem);
	font-weight: 600;
	line-height: 1.1;
	letter-spacing: -.01em;
}

.compass-welcome__lead {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.075rem, 1.6vw, 1.25rem);
	line-height: 1.7;
	text-wrap: pretty;
}

.compass-welcome__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-5);
	max-inline-size: 46rem;
	padding-inline: clamp(0rem, 2vw, var(--space-4));
}

.compass-welcome__heading {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-xl);
	font-weight: 600;
}

.compass-welcome__kinds {
	margin: 0;
	padding: 0;
	list-style: none;
	border-block-start: 1px solid var(--compass-rule);
}

.compass-welcome__kind {
	--compass-glyph-size: 1.5rem;

	display: grid;
	grid-template-columns: auto 9rem minmax(0, 1fr);
	align-items: baseline;
	gap: var(--space-1) var(--space-4);
	padding-block: var(--space-3);
	border-block-end: 1px solid var(--compass-rule);

	@media screen and (max-width: $tablet - 1px) {
		grid-template-columns: auto minmax(0, 1fr);
		grid-template-areas:
			'glyph name'
			'. hint';
		row-gap: var(--space-1);
		column-gap: var(--space-3);
	}
}

.compass-welcome__glyph {
	align-self: center;

	@media screen and (max-width: $tablet - 1px) {
		grid-area: glyph;
	}
}

.compass-welcome__kind-name {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.1rem;
	font-weight: 600;

	@media screen and (max-width: $tablet - 1px) {
		grid-area: name;
	}
}

.compass-welcome__kind-hint {
	color: var(--compass-ink-soft);
	line-height: 1.6;

	@media screen and (max-width: $tablet - 1px) {
		grid-area: hint;
	}
}

.compass-welcome__privacy {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	color: var(--compass-ink-soft);
	line-height: 1.6;
}

.compass-welcome__privacy-icon {
	flex: none;
	color: var(--compass-accent);
}

.compass-welcome__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3) var(--space-5);
}

.compass-welcome__customize {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: .22em;

	&:hover {
		text-decoration-thickness: 2px;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-welcome__note {
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
	line-height: 1.6;
}
</style>
