<template>
	<div
		ref="bar"
		class="compass-reading-progress d-print-none"
		aria-hidden="true"
	/>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onMounted, useTemplateRef, watch} from 'vue'
import {useEventListener, useResizeObserver} from '@vueuse/core'

const props = withDefaults(defineProps<{
	// The article whose length is measured; the bar stays empty until it exists.
	target?: HTMLElement | null
}>(), {
	target: null,
})

const bar = useTemplateRef<HTMLElement>('bar')
let frame = 0

// Written straight to a custom property: a reactive value would re-render the component on every frame.
function update() {
	frame = 0
	const article = props.target
	const element = bar.value
	if (!element) return
	let progress = 0
	if (article) {
		// The bar sits right under the fixed header, so its own top is where reading starts.
		const top = element.getBoundingClientRect().top
		const rect = article.getBoundingClientRect()
		const scrollable = rect.height - (window.innerHeight - top)
		if (scrollable > 0) progress = Math.min(1, Math.max(0, (top - rect.top) / scrollable))
	}
	element.style.setProperty('--compass-progress', progress.toFixed(4))
}

function schedule() {
	if (frame !== 0) return
	frame = requestAnimationFrame(update)
}

useEventListener(window, 'scroll', schedule, {passive: true})
useEventListener(window, 'resize', schedule, {passive: true})
// Fonts, reading preferences and refetched bodies change the article's length without a scroll.
useResizeObserver(() => props.target, schedule)
watch(() => props.target, schedule)
onMounted(schedule)
onBeforeUnmount(() => {
	if (frame !== 0) cancelAnimationFrame(frame)
})
</script>

<style lang="scss" scoped>
.compass-reading-progress {
	--compass-progress: 0;

	position: fixed;
	inset-block-start: var(--header-height);
	inset-inline: 0;
	z-index: var(--layer-sticky);
	block-size: 2px;
	background: var(--compass-accent);
	transform: scaleX(var(--compass-progress));
	transform-origin: left center;
	pointer-events: none;
	transition: transform var(--motion-fast) linear;

	[dir='rtl'] & {
		transform-origin: right center;
	}

	@media (prefers-reduced-motion: reduce) {
		transition: none;
	}
}
</style>
