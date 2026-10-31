<template>
	<section
		v-if="hasPreface"
		class="compass-preface"
		aria-labelledby="compass-preface-title"
	>
		<h2
			id="compass-preface-title"
			class="compass-preface__title"
		>
			{{ t('compass.preface.title') }}
		</h2>
		<div
			:id="bodyId"
			class="compass-preface__frame"
			:class="{
				'is-measuring': !measured,
				'is-collapsed': collapsed,
			}"
			:style="collapsed ? {maxBlockSize: `${clampHeight}px`} : undefined"
		>
			<div ref="content">
				<CompassProse
					:prepared="prepared"
					:font="prefs.font"
					:size="prefs.size"
				/>
			</div>
		</div>
		<button
			v-if="isLong"
			ref="toggle"
			type="button"
			class="compass-preface__toggle d-print-none"
			:aria-expanded="expanded"
			:aria-controls="bodyId"
			@click="toggleExpanded"
		>
			{{ expanded ? t('compass.preface.collapse') : t('compass.preface.expand') }}
			<Icon
				icon="chevron-down"
				class="compass-preface__chevron"
				:class="{'is-flipped': expanded}"
			/>
		</button>
	</section>

	<p
		v-else-if="canAdmin"
		class="compass-preface-empty d-print-none"
	>
		<RouterLink
			class="compass-preface-empty__link"
			:to="{name: 'compass.space.settings', params: {spaceId: space.id}}"
		>
			<Icon
				icon="pen"
				class="compass-preface-empty__icon"
			/>
			{{ t('compass.preface.write') }}
		</RouterLink>
		<span class="compass-preface-empty__hint">{{ t('compass.preface.writeHint') }}</span>
	</p>
</template>

<script setup lang="ts">
import {computed, nextTick, ref, useId, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useResizeObserver} from '@vueuse/core'
import CompassProse from '@/components/compass/base/CompassProse.vue'
import Icon from '@/components/misc/Icon'
import {canAdminCompass, type CompassSpace} from '@/client/queries/compass'
import {useCompassReadingPrefs} from '@/composables/useCompassReadingPrefs'
import {compassPlainText, prepareCompassHtml} from '@/helpers/compass/readerHtml'

const props = defineProps<{
	space: CompassSpace
}>()

// Collapse only what is clearly long, so the toggle never reveals just a line or two.
const LINES_BEFORE_COLLAPSE = 14
const LINES_WHEN_COLLAPSED = 12

const {t} = useI18n({useScope: 'global'})
const {prefs} = useCompassReadingPrefs()
const bodyId = useId()

const prepared = computed(() => prepareCompassHtml(props.space.introduction, 'compass-preface'))
const hasPreface = computed(() => compassPlainText(props.space.introduction).trim() !== '')
const canAdmin = computed(() => canAdminCompass(props.space))

const content = useTemplateRef<HTMLElement>('content')
const toggle = useTemplateRef<HTMLButtonElement>('toggle')
const contentHeight = ref(0)
const lineHeight = ref(0)
const measured = ref(false)
const expanded = ref(false)

useResizeObserver(content, () => {
	const element = content.value
	const prose = element?.firstElementChild
	if (!element || !(prose instanceof HTMLElement)) return
	const style = getComputedStyle(prose)
	const parsed = Number.parseFloat(style.lineHeight)
	lineHeight.value = Number.isFinite(parsed) ? parsed : Number.parseFloat(style.fontSize) * 1.85
	contentHeight.value = element.offsetHeight
	measured.value = true
})

const isLong = computed(() => measured.value &&
	lineHeight.value > 0 &&
	contentHeight.value > lineHeight.value * LINES_BEFORE_COLLAPSE)
const clampHeight = computed(() => Math.round(lineHeight.value * LINES_WHEN_COLLAPSED))
const collapsed = computed(() => isLong.value && !expanded.value)

// The page stays mounted when the switcher opens another cached space; its preface starts folded.
watch(() => props.space.id, () => {
	expanded.value = false
})

async function toggleExpanded() {
	expanded.value = !expanded.value
	if (expanded.value) return
	// Collapsing a long text from its end would leave the reader far below it.
	await nextTick()
	toggle.value?.scrollIntoView({block: 'nearest'})
}
</script>

<style lang="scss" scoped>
.compass-preface {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-4);
}

.compass-preface__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--text-xl);
	font-weight: 600;
}

.compass-preface__frame {
	position: relative;
	inline-size: 100%;
	max-inline-size: var(--compass-measure);

	// Until the first measurement, hold roughly the collapsed height so a long preface does not flash open.
	&.is-measuring {
		max-block-size: 26rem;
		overflow: hidden;
	}

	&.is-collapsed {
		overflow: hidden;
		mask-image: linear-gradient(to bottom, #000000 calc(100% - 5rem), transparent);
	}

	@media print {
		&.is-measuring,
		&.is-collapsed {
			max-block-size: none !important;
			overflow: visible;
			mask-image: none;
		}
	}
}

.compass-preface__toggle {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	padding: var(--space-1) 0;
	border: 0;
	background: none;
	color: var(--compass-accent);
	font: inherit;
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
		text-underline-offset: .22em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-preface__chevron {
	inline-size: .75em;
	transition: transform var(--motion-fast) var(--ease-standard);

	&.is-flipped {
		transform: rotate(180deg);
	}
}

.compass-preface-empty {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-3);
	color: var(--compass-ink-soft);
	font-size: var(--text-md);
}

.compass-preface-empty__link {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
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

.compass-preface-empty__icon {
	inline-size: .875em;
}
</style>
