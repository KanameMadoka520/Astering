<template>
	<component
		:is="tag"
		class="compass-sky-header"
	>
		<!-- Only the sky is clipped: the space switcher's menu must be able to open past the header. -->
		<span
			class="compass-sky-header__sky"
			aria-hidden="true"
		>
			<CompassSky />
		</span>
		<div class="compass-sky-header__content">
			<slot />
		</div>
	</component>
</template>

<script setup lang="ts">
import CompassSky from '@/components/compass/base/CompassSky.vue'

withDefaults(defineProps<{
	tag?: string
}>(), {
	tag: 'header',
})
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
