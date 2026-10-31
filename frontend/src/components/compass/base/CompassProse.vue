<template>
	<!-- Only prepareCompassHtml() output reaches v-html: sanitized, with our own heading ids and figures. -->
	<!-- eslint-disable vue/no-v-html -->
	<div
		v-bind="$attrs"
		ref="root"
		class="compass-prose"
		:class="[`compass-prose--${font}`, `compass-prose--${size}`]"
		data-user-content
		@click="enlarge"
		v-html="prepared.html"
	/>
	<!-- eslint-enable vue/no-v-html -->
	<ImageLightbox
		v-if="lightbox"
		:key="lightbox.url"
		:blob-url="lightbox.url"
		:alt="lightbox.alt"
		@close="lightbox = null"
	/>
</template>

<script setup lang="ts">
import {ref, useTemplateRef} from 'vue'
import ImageLightbox from '@/components/misc/ImageLightbox.vue'
import {COMPASS_IMAGE_ATTRIBUTE} from '@/helpers/compass/images'
import type {CompassPreparedHtml} from '@/helpers/compass/readerHtml'
import type {CompassReadingFont, CompassReadingSize} from '@/helpers/compass/storage'
import {useCompassImageHydration} from './useCompassImageHydration'

const props = withDefaults(defineProps<{
	prepared: CompassPreparedHtml
	// The space the body belongs to; its images are read through it. 0 for text without images.
	spaceId?: number
	font?: CompassReadingFont
	size?: CompassReadingSize
}>(), {
	spaceId: 0,
	font: 'serif',
	size: 'medium',
})

// The lightbox is a second root; keep reader/history layout attributes on the prose itself.
defineOptions({inheritAttrs: false})

const root = useTemplateRef<HTMLElement>('root')
useCompassImageHydration(root, () => props.spaceId, () => props.prepared.html)

// The lightbox borrows the image's own blob: url; the body releases it.
const lightbox = ref<{url: string, alt: string} | null>(null)

function enlarge(event: MouseEvent) {
	const target = event.target
	if (!(target instanceof HTMLImageElement) || !target.hasAttribute(COMPASS_IMAGE_ATTRIBUTE)) return
	if (!target.currentSrc.startsWith('blob:')) return
	lightbox.value = {
		url: target.currentSrc,
		alt: target.alt,
	}
}
</script>

<style lang="scss" scoped>
// Long-form reading: a book measure, generous leading for CJK, quiet ornaments.
.compass-prose {
	--compass-reading-size: 1.125rem;

	max-inline-size: var(--compass-measure);
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: var(--compass-reading-size);
	line-height: 1.85;
	overflow-wrap: break-word;
	text-wrap: pretty;
	font-kerning: normal;

	@media screen and (max-width: $tablet) {
		--compass-reading-size: 1.0625rem;

		line-height: 1.8;
	}

	:deep(:where(p)) {
		margin-block: 0 1.15em;
	}

	:deep(:where(h1, h2, h3, h4, h5, h6)) {
		margin-block: 2em .65em;
		color: var(--compass-ink);
		font-family: var(--compass-serif);
		font-weight: var(--weight-semibold);
		line-height: 1.35;
		letter-spacing: .005em;
		scroll-margin-block-start: calc(var(--header-height) + var(--space-6));
	}

	:deep(:where(h1, h2, h3, h4, h5, h6):first-child) {
		margin-block-start: 0;
	}

	:deep(h1) {
		font-size: 1.55em;
	}

	:deep(h2) {
		font-size: 1.35em;
	}

	:deep(h3) {
		font-size: 1.17em;
	}

	:deep(:where(h4, h5, h6)) {
		font-size: 1.03em;
	}

	:deep(:where(strong, b)) {
		font-weight: var(--weight-bold);
	}

	:deep(a) {
		color: var(--compass-accent);
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

	:deep(blockquote) {
		margin: 1.5em 0;
		padding-inline-start: 1.1em;
		border-inline-start: 2px solid var(--compass-accent);
		color: var(--compass-ink-soft);

		> :last-child {
			margin-block-end: 0;
		}
	}

	:deep(:where(ul, ol)) {
		margin-block: 0 1.15em;
		padding-inline-start: 1.5em;
	}

	:deep(ul) {
		list-style: disc;
	}

	:deep(ol) {
		list-style: decimal;
	}

	:deep(li) {
		margin-block: .3em;

		> p {
			margin-block: 0;
		}
	}

	:deep(li::marker) {
		color: var(--compass-ink-faint);
	}

	:deep(hr) {
		block-size: 1px;
		margin: 2.4em auto;
		border: 0;
		background: linear-gradient(to right, transparent, var(--compass-rule-strong) 20%, var(--compass-rule-strong) 80%, transparent);
	}

	:deep(code) {
		padding: .1em .35em;
		border-radius: var(--radius-xs);
		background: var(--surface-sunken);
		color: var(--compass-ink);
		font-family: var(--font-mono);
		font-size: .86em;
	}

	:deep(pre) {
		margin-block: 0 1.15em;
		padding: var(--space-4);
		overflow-x: auto;
		border: 1px solid var(--compass-rule);
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		font-size: .85em;
		line-height: 1.6;

		code {
			padding: 0;
			background: none;
			font-size: inherit;
		}
	}

	:deep(mark) {
		padding: 0 .1em;
		border-radius: 2px;
		background: hsla(48, 100%, 58%, .36);
		color: inherit;
	}

	// Wide tables scroll inside themselves; the page never overflows.
	:deep(table) {
		display: block;
		max-inline-size: 100%;
		margin-block: 0 1.15em;
		overflow-x: auto;
		border-collapse: collapse;
		font-family: var(--compass-sans);
		font-size: .88em;
		line-height: 1.55;
	}

	:deep(:where(th, td)) {
		padding: .5em .75em;
		border: 1px solid var(--compass-rule-strong);
		text-align: start;
		vertical-align: top;

		> p {
			margin: 0;
		}
	}

	:deep(th) {
		background: var(--surface-sunken);
		font-weight: var(--weight-semibold);
	}

	// Pictures sit in the text column at their own size, never wider; the frame keeps the space while
	// the bytes arrive, so the text below does not jump.
	:deep(figure.compass-figure) {
		margin: 1.6em 0;
	}

	:deep(span.compass-figure) {
		display: block;
		margin-block: .6em;
	}

	:deep(.compass-figure img) {
		display: block;
		max-inline-size: 100%;
		block-size: auto;
		margin-inline: auto;
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		cursor: zoom-in;
	}

	// Width and height attributes size the frame before loading; without them it is a plain placeholder.
	:deep(.compass-figure img:not([src])) {
		cursor: default;
	}

	:deep(.compass-figure img:not([src], [width])) {
		inline-size: min(100%, 32rem);
		min-block-size: 6rem;
	}

	:deep(.compass-figure img[data-compass-state='failed']) {
		display: none;
	}

	:deep(.compass-figure__caption) {
		display: block;
		margin-block-start: .6em;
		color: var(--compass-ink-soft);
		font-family: var(--compass-sans);
		font-size: .85em;
		line-height: 1.55;
		text-align: center;
	}

	:deep(.compass-figure__missing) {
		display: flex;
		align-items: center;
		justify-content: center;
		min-block-size: 6rem;
		padding: var(--space-4);
		border: 1px dashed var(--compass-rule-strong);
		border-radius: var(--radius-md);
		color: var(--compass-ink-faint);
		font-family: var(--compass-sans);
		font-size: .85em;
		text-align: center;
		overflow-wrap: anywhere;
	}

	> :deep(:last-child) {
		margin-block-end: 0;
	}
}

.compass-prose--sans {
	font-family: var(--compass-sans);
	line-height: 1.75;
}

.compass-prose--small {
	--compass-reading-size: 1rem;
}

.compass-prose--large {
	--compass-reading-size: 1.25rem;

	@media screen and (max-width: $tablet) {
		--compass-reading-size: 1.1875rem;
	}
}

@media print {
	.compass-prose {
		max-inline-size: none;
		color: #000000;
		font-size: 11.5pt;
		line-height: 1.7;

		:deep(a) {
			color: #000000;
		}

		:deep(a[href^='http'])::after {
			content: ' (' attr(href) ')';
			font-size: .85em;
			overflow-wrap: anywhere;
		}

		:deep(:where(h1, h2, h3, h4)) {
			break-after: avoid;
		}

		:deep(:where(blockquote, pre, tr, li, .compass-figure)) {
			break-inside: avoid;
		}

		:deep(.compass-figure img) {
			max-block-size: 90vh;
			object-fit: contain;
		}

		:deep(table) {
			display: table;
			overflow: visible;
		}

		// Paper cannot scroll horizontally: preserve long code instead of clipping it.
		:deep(pre),
		:deep(pre code) {
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			overflow: visible;
		}
	}
}
</style>
