<template>
	<component
		:is="layout === 'disclosure' ? 'details' : 'div'"
		v-if="visible"
		class="compass-toc d-print-none"
		:class="`compass-toc--${layout}`"
	>
		<summary
			v-if="layout === 'disclosure'"
			class="compass-toc__summary"
		>
			<Icon
				icon="list-ul"
				aria-hidden="true"
			/>
			<span>{{ t('compass.toc.title') }}</span>
			<span class="compass-toc__count">{{ t('compass.toc.count', {count: headings.length}) }}</span>
			<Icon
				icon="chevron-down"
				class="compass-toc__chevron"
				aria-hidden="true"
			/>
		</summary>
		<nav
			class="compass-toc__nav"
			:aria-label="t('compass.toc.title')"
		>
			<p
				v-if="layout === 'rail'"
				class="compass-toc__title"
				aria-hidden="true"
			>
				{{ t('compass.toc.title') }}
			</p>
			<ol class="compass-toc__list">
				<li
					v-for="heading in headings"
					:key="heading.id"
					class="compass-toc__item"
					:style="{'--compass-toc-depth': depthOf(heading)}"
				>
					<a
						class="compass-toc__link"
						:href="`#${heading.id}`"
						:aria-current="heading.id === active ? 'location' : undefined"
						@click="jump($event, heading)"
					>{{ heading.text }}</a>
				</li>
			</ol>
		</nav>
	</component>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useEventListener} from '@vueuse/core'
import Icon from '@/components/misc/Icon'
import type {CompassHeading} from '@/helpers/compass/readerHtml'
import {smoothScrollBehavior} from '@/helpers/scrollIntoView'

const props = withDefaults(defineProps<{
	headings: readonly CompassHeading[]
	// The wide reader shows a sticky rail; narrower ones fold the contents above the body.
	layout?: 'rail' | 'disclosure'
}>(), {
	layout: 'rail',
})

const {t} = useI18n({useScope: 'global'})

const visible = computed(() => props.headings.length >= 2)
const active = ref('')

// h1 and h2 are the top level; deeper headings indent from there. A body that starts at h3 starts flush.
const baseLevel = computed(() => Math.max(2, Math.min(...props.headings.map(heading => heading.level))))

function depthOf(heading: CompassHeading): number {
	return Math.max(0, heading.level - baseLevel.value)
}

// The section being read is the last heading above this line (40% down the viewport).
const READING_LINE = .4

function updateActive() {
	// A short last section never reaches the reading line; once the page cannot scroll further,
	// the last heading in view is the one being read.
	const atEnd = window.scrollY > 0
		&& window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
	const line = atEnd ? window.innerHeight : window.innerHeight * READING_LINE
	let current = ''
	for (const heading of props.headings) {
		const element = document.getElementById(heading.id)
		if (!element) continue
		if (element.getBoundingClientRect().top > line) break
		current = heading.id
	}
	active.value = current
}

let frame = 0

// The observer only reports crossings, and reaching the end of the page crosses nothing.
function scheduleUpdate() {
	if (frame !== 0 || !visible.value) return
	frame = requestAnimationFrame(() => {
		frame = 0
		updateActive()
	})
}

useEventListener(window, 'scroll', scheduleUpdate, {passive: true})

function headerHeight(): number {
	const root = document.documentElement
	const raw = getComputedStyle(root).getPropertyValue('--header-height').trim()
	const value = parseFloat(raw)
	if (Number.isNaN(value)) return 0
	return raw.endsWith('rem') ? value * parseFloat(getComputedStyle(root).fontSize) : value
}

let observer: IntersectionObserver | null = null

// Headings only cross the reading line by scrolling or reflow, and each crossing is an intersection change
// of the band between the fixed header and that line; the observer is only the trigger, geometry decides.
function observe() {
	observer?.disconnect()
	observer = null
	if (!visible.value || typeof IntersectionObserver === 'undefined') return
	const bottom = Math.round((1 - READING_LINE) * 100)
	observer = new IntersectionObserver(updateActive, {
		rootMargin: `-${Math.round(headerHeight())}px 0px -${bottom}% 0px`,
	})
	for (const heading of props.headings) {
		const element = document.getElementById(heading.id)
		if (element) observer.observe(element)
	}
	updateActive()
}

onMounted(observe)
// Post flush: the new body has replaced the old headings in the DOM by then.
watch(() => props.headings, observe, {flush: 'post'})
onBeforeUnmount(() => {
	observer?.disconnect()
	if (frame !== 0) cancelAnimationFrame(frame)
})

function jump(event: MouseEvent, heading: CompassHeading) {
	// Modified clicks keep their browser meaning (new tab, copy link).
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
	const target = document.getElementById(heading.id)
	if (!target) return
	// The URL stays as it is: the router would treat a hash change as a navigation and scroll on its own.
	event.preventDefault()
	if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
	target.focus({preventScroll: true})
	target.scrollIntoView({
		behavior: smoothScrollBehavior(),
		block: 'start',
	})
	active.value = heading.id
}
</script>

<style lang="scss" scoped>
.compass-toc__list {
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-toc__item {
	margin: 0;
	padding-inline-start: calc(var(--compass-toc-depth, 0) * var(--space-4));
}

.compass-toc__link {
	display: block;
	padding-block: .3rem;
	padding-inline: var(--space-3) var(--space-2);
	border-inline-start: 2px solid var(--compass-rule);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: 1.45;
	text-decoration: none;
	overflow-wrap: anywhere;
	transition:
		color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-inline-start-color: var(--compass-rule-strong);
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}

	// Colour plus weight and the marker: the current section never relies on hue alone.
	&[aria-current='location'] {
		border-inline-start-color: var(--compass-accent);
		color: var(--compass-ink);
		font-weight: var(--weight-semibold);
	}

	@media (pointer: coarse) {
		display: flex;
		align-items: center;
		min-block-size: var(--target-min);
	}
}

.compass-toc--rail {
	position: sticky;
	inset-block-start: calc(var(--header-height) + var(--space-6));
	max-block-size: calc(100dvh - var(--header-height) - var(--space-6) * 2);
	overflow-y: auto;
	overscroll-behavior: contain;
	padding-block-end: var(--space-2);
}

.compass-toc__title {
	margin: 0 0 var(--space-3);
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .08em;
	text-transform: uppercase;
}

.compass-toc--disclosure {
	margin-block-end: var(--space-8);
	border-block: 1px solid var(--compass-rule);
}

.compass-toc__summary {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: max(var(--control-height), var(--target-min));
	padding-block: var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	list-style: none;
	cursor: pointer;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-toc__count {
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
	font-weight: var(--weight-regular);
}

.compass-toc__chevron {
	margin-inline-start: auto;
	transition: transform var(--motion-fast) var(--ease-standard);

	.compass-toc--disclosure[open] & {
		transform: rotate(180deg);
	}
}

.compass-toc--disclosure .compass-toc__nav {
	padding-block: var(--space-1) var(--space-4);
}
</style>
