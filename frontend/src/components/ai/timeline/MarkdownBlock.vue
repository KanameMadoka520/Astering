<script setup lang="ts">
import {onBeforeUnmount, shallowRef, watch} from 'vue'
import {marked} from 'marked'
import {sanitizeProjectDescription} from '@/helpers/sanitizeProjectDescription'

const props = withDefaults(defineProps<{
	source: string
	streaming?: boolean
}>(), {
	streaming: false,
})

// Streamed text re-parses at most this often, with a trailing render so the last delta always lands.
const STREAM_INTERVAL_MS = 120
const html = shallowRef('')
let timer: ReturnType<typeof setTimeout> | undefined
let renderedAt = 0

function render() {
	clearTimeout(timer)
	timer = undefined
	renderedAt = performance.now()
	html.value = sanitizeProjectDescription(marked.parse(props.source, {async: false}))
}

watch([() => props.source, () => props.streaming], ([, streaming]) => {
	if (!streaming) return render()
	if (timer !== undefined) return
	const wait = renderedAt + STREAM_INTERVAL_MS - performance.now()
	if (wait <= 0) render()
	else timer = setTimeout(render, wait)
}, {immediate: true})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
	<div
		class="markdown-block content"
		:class="{'is-streaming': streaming}"
		v-html="html"
	/>
</template>

<style scoped lang="scss">
.markdown-block {
	// Bulma's .content adds a block gap below; the timeline spaces blocks itself.
	--block-spacing: 0;

	color: var(--text-primary);
	font-size: var(--text-base);
	line-height: 1.65;
	overflow-wrap: anywhere;

	// Replies are part of a dense column, not a document: headings stay close to body size.
	:deep(h1),
	:deep(h2) {
		margin-block: var(--space-4) var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	:deep(h3),
	:deep(h4),
	:deep(h5),
	:deep(h6) {
		margin-block: var(--space-3) var(--space-1);
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	:deep(p),
	:deep(ul),
	:deep(ol) {
		margin-block-end: var(--space-3);
	}

	> :deep(:last-child) {
		margin-block-end: 0;
	}

	:deep(pre) {
		max-inline-size: 100%;
		overflow-x: auto;
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		font-size: var(--text-sm);
	}

	:deep(code) {
		font-family: var(--font-mono);
	}

	:deep(table) {
		display: block;
		max-inline-size: 100%;
		overflow-x: auto;
		font-size: var(--text-md);
	}

	:deep(img) {
		max-inline-size: 100%;
	}
}

// The cursor follows the last block inline, so it never adds or removes a line while streaming.
.markdown-block.is-streaming > :deep(:last-child)::after {
	content: '';
	display: inline-block;
	inline-size: .45em;
	block-size: 1em;
	margin-inline-start: .15em;
	vertical-align: text-bottom;
	border-radius: var(--radius-xs);
	background: var(--primary);
	animation: cursor-breathe 1s ease-in-out infinite;
}

@keyframes cursor-breathe {
	50% {
		opacity: .2;
	}
}

@media (prefers-reduced-motion: reduce) {
	.markdown-block.is-streaming > :deep(:last-child)::after {
		animation: none;
	}
}
</style>
