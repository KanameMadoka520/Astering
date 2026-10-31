<template>
	<span
		v-if="url"
		class="compass-backdrop"
		:data-scrim="scrim"
		aria-hidden="true"
	>
		<img
			class="compass-backdrop__image"
			:src="url"
			alt=""
			decoding="async"
			:style="{objectPosition: `${focusX}% ${focusY}%`}"
		>
		<span class="compass-backdrop__scrim" />
	</span>
</template>

<script setup lang="ts">
import {watch} from 'vue'
import type {CompassBackgroundScrim} from '@/helpers/compass/constants'
import {useCompassImageUrl, type CompassImageUrlState} from './useCompassImageUrl'

const props = withDefaults(defineProps<{
	spaceId: number
	// 0: no photo, the theme's sky shows.
	fileId: number
	focusX?: number
	focusY?: number
	scrim?: CompassBackgroundScrim
}>(), {
	focusX: 50,
	focusY: 50,
	scrim: 'medium',
})

const emit = defineEmits<{
	state: [state: CompassImageUrlState]
}>()

const {url, state} = useCompassImageUrl(() => props.spaceId, () => props.fileId)

watch(state, value => emit('state', value), {immediate: true})
</script>

<style lang="scss" scoped>
// A space's photo, cropped around its focal point and veiled in the theme's own sky color, so the ink of
// the title keeps its contrast in light and dark themes alike. Until it loads (or when it cannot), the
// theme's sky underneath simply stays.
.compass-backdrop {
	--compass-scrim-start: 74%;
	--compass-scrim-middle: 54%;
	--compass-scrim-end: 34%;

	position: absolute;
	inset: 0;
	overflow: hidden;
	border-radius: inherit;
	pointer-events: none;

	&[data-scrim='soft'] {
		--compass-scrim-start: 58%;
		--compass-scrim-middle: 38%;
		--compass-scrim-end: 18%;
	}

	&[data-scrim='strong'] {
		--compass-scrim-start: 88%;
		--compass-scrim-middle: 74%;
		--compass-scrim-end: 58%;
	}

	@media print {
		display: none;
	}
}

.compass-backdrop__image {
	position: absolute;
	inset: 0;
	inline-size: 100%;
	block-size: 100%;
	object-fit: cover;
}

// Strongest behind the text at the start edge, lighter where only the picture is.
.compass-backdrop__scrim {
	position: absolute;
	inset: 0;
	background: linear-gradient(
		to right,
		color-mix(in srgb, var(--compass-sky-from) var(--compass-scrim-start), transparent) 0%,
		color-mix(in srgb, var(--compass-sky-from) var(--compass-scrim-middle), transparent) 55%,
		color-mix(in srgb, var(--compass-sky-from) var(--compass-scrim-end), transparent) 100%
	);

	[dir='rtl'] & {
		transform: scaleX(-1);
	}

	// Text covers the whole width of a narrow band.
	@media screen and (max-width: $tablet - 1px) {
		background: color-mix(in srgb, var(--compass-sky-from) var(--compass-scrim-start), transparent);
	}
}
</style>
