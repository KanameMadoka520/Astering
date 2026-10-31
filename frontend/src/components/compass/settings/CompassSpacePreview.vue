<template>
	<CompassThemeScope
		tag="figure"
		:theme="theme"
		class="compass-space-preview"
	>
		<figcaption class="compass-space-preview__caption">
			<CompassGlyph kind="guide" />
			<span>{{ t('compass.create.previewLabel') }}</span>
		</figcaption>
		<div class="compass-space-preview__sky">
			<CompassSky class="compass-space-preview__astrolabe" />
			<div class="compass-space-preview__text">
				<p class="compass-space-preview__eyebrow">
					<Icon
						class="compass-space-preview__visibility-icon"
						:icon="sharing === 'team' ? 'users' : 'lock'"
					/>
					<span>{{ sharingLabel }}</span>
				</p>
				<p
					class="compass-space-preview__title"
					:class="{'is-placeholder': shownTitle === ''}"
				>
					{{ shownTitle || t('compass.create.previewUntitled') }}
				</p>
				<p
					v-if="shownMotto"
					class="compass-space-preview__motto is-quoted"
				>
					{{ shownMotto }}
				</p>
				<p
					v-else
					class="compass-space-preview__motto is-placeholder"
				>
					{{ t('compass.create.previewMotto') }}
				</p>
			</div>
		</div>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassSky from '@/components/compass/base/CompassSky.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import type {CompassTheme} from '@/helpers/compass/constants'
import type {CompassSharing} from './sharing'

const props = withDefaults(defineProps<{
	title: string
	motto: string
	theme: CompassTheme
	sharing: CompassSharing
	teamName?: string
}>(), {
	teamName: '',
})

const {t} = useI18n({useScope: 'global'})

const shownTitle = computed(() => props.title.trim())
const shownMotto = computed(() => props.motto.trim())

const sharingLabel = computed(() => props.sharing === 'team'
	? t('compass.space.team', {team: props.teamName || t('compass.space.teamFallback')})
	: t('compass.space.personal'))
</script>

<style lang="scss" scoped>
// A miniature of the space's sky band (CompassSkyHeader + CompassHero), scaled to its container.
.compass-space-preview {
	container-type: inline-size;
	min-inline-size: 0;
	margin: 0;
}

.compass-space-preview__caption {
	--compass-glyph-size: .85rem;

	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin-block-end: var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .08em;
	text-transform: uppercase;
}

.compass-space-preview__sky {
	position: relative;
	isolation: isolate;
	display: flex;
	flex-direction: column;
	min-block-size: clamp(9.5rem, 46cqi, 14rem);
	padding: clamp(1rem, 6cqi, 1.75rem);
	overflow: hidden;
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background:
		radial-gradient(circle at 82% 18%, var(--compass-glow-a), transparent 52%),
		radial-gradient(circle at 12% 120%, var(--compass-glow-b), transparent 58%),
		linear-gradient(160deg, var(--compass-sky-from), var(--compass-sky-via) 55%, var(--compass-sky-to));
	color: var(--compass-ink);
}

.compass-space-preview__astrolabe {
	z-index: -1;
}

// Narrow previews put the astrolabe behind the text; quieter lines keep the title legible.
@container (max-width: 30rem) {
	.compass-space-preview__astrolabe {
		opacity: .55;
	}
}

.compass-space-preview__text {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
	max-inline-size: min(100%, 30rem);
}

.compass-space-preview__eyebrow {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	letter-spacing: .02em;
	overflow-wrap: anywhere;
}

.compass-space-preview__visibility-icon {
	flex: none;
	inline-size: .875em;
	color: var(--compass-accent);
}

.compass-space-preview__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.4rem, 7.5cqi, 2.25rem);
	font-weight: 600;
	line-height: 1.12;
	letter-spacing: -.01em;
	overflow-wrap: anywhere;
	text-wrap: balance;
}

.compass-space-preview__motto {
	display: -webkit-box;
	margin: 0;
	overflow: hidden;
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: clamp(.95rem, 3.8cqi, 1.125rem);
	line-height: 1.6;
	white-space: pre-line;
	overflow-wrap: anywhere;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;

	&.is-quoted {
		quotes: '\201C' '\201D' '\2018' '\2019';

		&::before {
			content: open-quote;
		}

		&::after {
			content: close-quote;
		}
	}
}

.is-placeholder {
	color: var(--compass-ink-faint);
}

.compass-space-preview__title.is-placeholder {
	font-weight: var(--weight-medium);
}

.compass-space-preview__motto.is-placeholder {
	font-family: var(--compass-sans);
	font-size: var(--text-sm);
}
</style>
