<template>
	<svg
		class="compass-glyph"
		:class="`compass-glyph--${kind}`"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<!-- Principle: the fixed star one steers by. -->
		<template v-if="kind === 'principle'">
			<path
				d="M12 3l1.7 7.3L21 12l-7.3 1.7L12 21l-1.7-7.3L3 12l7.3-1.7z"
				fill="currentColor"
				fill-opacity=".16"
			/>
			<circle
				cx="12"
				cy="12"
				r="1.2"
				fill="currentColor"
				stroke="none"
			/>
		</template>
		<!-- Vision: a star rising over the horizon. -->
		<template v-else-if="kind === 'vision'">
			<path d="M3 17.5h18" />
			<path d="M6.5 17.5a5.5 5.5 0 0 1 11 0" />
			<path d="M8.5 20.5h7" />
			<path
				d="M12 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"
				fill="currentColor"
				stroke-width="1"
			/>
		</template>
		<!-- Action: the needle that turns a direction into a heading. -->
		<template v-else-if="kind === 'action'">
			<circle
				cx="12"
				cy="12"
				r="8.5"
			/>
			<path d="M12 5.5l2.3 6.5-2.3 6.5-2.3-6.5z" />
			<path
				d="M12 5.5l2.3 6.5H9.7z"
				fill="currentColor"
				stroke="none"
			/>
		</template>
		<!-- Memory: light that left its star long ago. -->
		<template v-else-if="kind === 'memory'">
			<path
				d="M16.5 3.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"
				fill="currentColor"
				stroke-width="1"
			/>
			<path d="M13.5 10.5L4 20" />
			<path
				d="M15.5 12.5L9 19"
				stroke-opacity=".6"
			/>
			<path
				d="M11.5 8.5L6.5 13.5"
				stroke-opacity=".45"
			/>
		</template>
		<!-- Note: a small star and lines in the margin. -->
		<template v-else-if="kind === 'note'">
			<path
				d="M6.5 4l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"
				fill="currentColor"
				stroke-width="1"
			/>
			<path d="M12 6.5h7.5" />
			<path d="M4.5 12h15" />
			<path d="M4.5 16h15" />
			<path d="M4.5 20h9" />
		</template>
		<!-- Guide: a pinned entry, a light to steer by. -->
		<template v-else>
			<path
				d="M12 2.5l1.9 7.6 7.6 1.9-7.6 1.9-1.9 7.6-1.9-7.6L2.5 12l7.6-1.9z"
				fill="currentColor"
				stroke="none"
			/>
		</template>
	</svg>
</template>

<script setup lang="ts">
import type {CompassKind} from '@/helpers/compass/constants'

defineProps<{
	kind: CompassKind | 'guide'
}>()
</script>

<style lang="scss" scoped>
.compass-glyph {
	display: inline-block;
	flex: none;
	inline-size: var(--compass-glyph-size, 1.25em);
	block-size: var(--compass-glyph-size, 1.25em);
	vertical-align: -.2em;
}

.compass-glyph--principle {
	color: var(--compass-kind-principle);
}

.compass-glyph--vision {
	color: var(--compass-kind-vision);
}

.compass-glyph--action {
	color: var(--compass-kind-action);
}

.compass-glyph--memory {
	color: var(--compass-kind-memory);
}

.compass-glyph--note {
	color: var(--compass-kind-note);
}

.compass-glyph--guide {
	color: var(--compass-accent);
}
</style>
