<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {marked, type Token, type TokensList} from 'marked'
import {sanitizeAronaContent} from '@/helpers/sanitizeAronaContent'
import {useAronaLinks} from '@/composables/useAronaLinks'

const props = withDefaults(defineProps<{
	source: string
	streaming?: boolean
}>(), {
	streaming: false,
})

// Streamed text re-parses at most this often, with a trailing render so the last delta always lands.
const STREAM_INTERVAL_MS = 120
const followLink = useAronaLinks()
const root = ref<HTMLElement>()
let timer: ReturnType<typeof setTimeout> | undefined
let renderedAt = 0
// While streaming, finished top-level blocks keep their DOM: a selection, focus or hover inside them survives,
// and only the growing tail is parsed, sanitized and laid out again.
let blocks: {raw: string, nodes: ChildNode[]}[] = []
let linkKey = ''

function renderAll(el: HTMLElement) {
	blocks = []
	linkKey = ''
	const html = sanitizeAronaContent(marked.parse(props.source, {async: false}))
	// The settled answer usually equals what streaming built; keeping that DOM keeps the reader's selection.
	if (el.innerHTML !== html) el.innerHTML = html
}

function hasRawHtml(tokens: TokensList) {
	let found = false
	marked.walkTokens(tokens, token => {
		if (token.type === 'html') found = true
	})
	return found
}

function renderBlocks(el: HTMLElement) {
	const tokens = marked.lexer(props.source)
	// Raw HTML can open in one block and close in a later one, and a reference definition can change any earlier
	// block, so neither may be rendered block by block.
	if (hasRawHtml(tokens)) return renderAll(el)
	const links = JSON.stringify(tokens.links)
	if (links !== linkKey) {
		blocks = []
		linkKey = links
		el.textContent = ''
	}
	let kept = 0
	while (kept < blocks.length && kept < tokens.length - 1 && blocks[kept].raw === tokens[kept].raw) kept++
	if (kept === 0) el.textContent = ''
	else for (const block of blocks.slice(kept)) block.nodes.forEach(node => node.remove())
	blocks.length = kept
	for (const token of tokens.slice(kept)) {
		const single = Object.assign([token] as Token[], {links: tokens.links}) as TokensList
		const before = el.lastChild
		el.insertAdjacentHTML('beforeend', sanitizeAronaContent(marked.parser(single)))
		const nodes: ChildNode[] = []
		for (let node = before ? before.nextSibling : el.firstChild; node; node = node.nextSibling) nodes.push(node)
		blocks.push({raw: token.raw, nodes})
	}
}

function render() {
	clearTimeout(timer)
	timer = undefined
	renderedAt = performance.now()
	const el = root.value
	if (!el) return
	if (props.streaming) renderBlocks(el)
	else renderAll(el)
}

onMounted(render)
watch([() => props.source, () => props.streaming], ([, streaming]) => {
	if (!streaming) return render()
	if (timer !== undefined) return
	const wait = renderedAt + STREAM_INTERVAL_MS - performance.now()
	if (wait <= 0) render()
	else timer = setTimeout(render, wait)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
	<div
		ref="root"
		class="markdown-block content"
		:class="{'is-streaming': streaming}"
		@click="followLink"
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
