<template>
	<component
		:is="tag"
		class="compass-sky-header"
		:class="{'has-photo': photo === 'ready'}"
	>
		<!-- Only the sky is clipped: the space switcher's menu must be able to open past the header. -->
		<span
			class="compass-sky-header__sky"
			aria-hidden="true"
		>
			<CompassSky v-if="photo !== 'ready'" />
			<CompassBackdrop
				v-if="background && spaceId > 0 && background.background_file_id > 0"
				:space-id="spaceId"
				:file-id="background.background_file_id"
				:focus-x="background.background_focus_x"
				:focus-y="background.background_focus_y"
				:scrim="background.background_scrim"
				@state="photo = $event"
			/>
		</span>
		<div class="compass-sky-header__content">
			<slot />
		</div>
	</component>
</template>

<script setup lang="ts">
import {ref} from 'vue'
import type {CompassSpaceBackground} from '@/client/queries/compass'
import CompassBackdrop from '@/components/compass/base/CompassBackdrop.vue'
import CompassSky from '@/components/compass/base/CompassSky.vue'
import type {CompassImageUrlState} from '@/components/compass/base/useCompassImageUrl'

withDefaults(defineProps<{
	tag?: string
	// The space's own photo instead of the theme's sky, when it has one.
	spaceId?: number
	background?: CompassSpaceBackground
}>(), {
	tag: 'header',
	spaceId: 0,
	background: undefined,
})

const photo = ref<CompassImageUrlState>('none')
</script>

<style lang="scss" scoped>
// The one bounded exception to "no large gradients" (docs/compass.md): the space's sky band.
.compass-sky-header {
	position: relative;
	display: flex;
	flex-direction: column;
	min-block-size: clamp(13rem, 24vw, 20rem);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background:
		radial-gradient(circle at 82% 18%, var(--compass-glow-a), transparent 52%),
		radial-gradient(circle at 12% 120%, var(--compass-glow-b), transparent 58%),
		linear-gradient(160deg, var(--compass-sky-from), var(--compass-sky-via) 55%, var(--compass-sky-to));
	color: var(--compass-ink);

	@media screen and (max-width: $tablet - 1px) {
		min-block-size: 10.5rem;
		border-radius: var(--radius-md);
	}

	@media print {
		min-block-size: 0;
		border: 0;
		border-radius: 0;
		background: none;
	}
}

// Painted before the content (tree order), so no z-index and no stacking context on the header,
// which would keep an open menu under the sections that follow.
.compass-sky-header__sky {
	position: absolute;
	inset: 0;
	overflow: hidden;
	border-radius: inherit;
	pointer-events: none;

	@media print {
		display: none;
	}

	// On a phone the astrolabe sits behind the text; quieter lines keep the title legible.
	@media screen and (max-width: $tablet - 1px) {
		opacity: .55;
	}

	// The photo carries its own veil.
	.has-photo > & {
		opacity: 1;
	}
}

.compass-sky-header__content {
	position: relative;
	display: flex;
	flex: 1;
	flex-direction: column;
	padding: clamp(1.25rem, 3.4vw, 2.5rem);

	@media print {
		padding: 0;
	}
}
</style>
