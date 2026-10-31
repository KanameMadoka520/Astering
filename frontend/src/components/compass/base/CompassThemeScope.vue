<template>
	<component
		:is="tag"
		class="compass-theme"
		:data-compass-theme="theme"
	>
		<slot />
	</component>
</template>

<script setup lang="ts">
import type {CompassTheme} from '@/helpers/compass/constants'

withDefaults(defineProps<{
	theme: CompassTheme
	tag?: string
}>(), {
	tag: 'div',
})
</script>

<!-- Unscoped on purpose: every Compass component reads these tokens through var(). -->
<style lang="scss">
// Compass tokens (docs/compass.md). Sky colours paint only the space header; accents stay small
// (links, current items, glyphs, the epigraph rule) and are AA text colours on --surface in both modes.
.compass-theme {
	--compass-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia,
		'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Songti SC', STSong, SimSun, serif;
	--compass-sans: var(--font-ui);
	--compass-measure: 38rem;
	--compass-ink: var(--text-primary);
	--compass-ink-soft: var(--text-secondary);
	--compass-ink-faint: var(--text-tertiary);
	--compass-paper: var(--surface);
	--compass-rule: var(--border-subtle);
	--compass-rule-strong: var(--border-default);
	--compass-kind-principle: hsl(40, 85%, 34%);
	--compass-kind-vision: hsl(265, 52%, 48%);
	--compass-kind-action: hsl(188, 76%, 28%);
	--compass-kind-memory: hsl(340, 55%, 44%);
	--compass-kind-note: hsl(215, 18%, 42%);

	color: var(--compass-ink);

	&[data-compass-theme='aurora'] {
		--compass-sky-from: hsl(168, 48%, 92%);
		--compass-sky-via: hsl(205, 68%, 95%);
		--compass-sky-to: hsl(258, 58%, 95%);
		--compass-glow-a: hsla(168, 70%, 55%, .26);
		--compass-glow-b: hsla(268, 80%, 70%, .22);
		--compass-star: hsl(195, 45%, 30%);
		--compass-accent: hsl(186, 72%, 26%);
		--compass-accent-tint: hsla(186, 72%, 30%, .1);
	}

	&[data-compass-theme='solar'] {
		--compass-sky-from: hsl(42, 72%, 92%);
		--compass-sky-via: hsl(30, 76%, 93%);
		--compass-sky-to: hsl(12, 62%, 94%);
		--compass-glow-a: hsla(40, 95%, 58%, .3);
		--compass-glow-b: hsla(12, 85%, 64%, .2);
		--compass-star: hsl(28, 55%, 30%);
		--compass-accent: hsl(26, 82%, 31%);
		--compass-accent-tint: hsla(30, 85%, 40%, .1);
	}

	&[data-compass-theme='nebula'] {
		--compass-sky-from: hsl(288, 55%, 95%);
		--compass-sky-via: hsl(250, 62%, 95%);
		--compass-sky-to: hsl(218, 66%, 94%);
		--compass-glow-a: hsla(305, 70%, 68%, .24);
		--compass-glow-b: hsla(232, 80%, 68%, .22);
		--compass-star: hsl(268, 40%, 34%);
		--compass-accent: hsl(276, 52%, 40%);
		--compass-accent-tint: hsla(276, 55%, 45%, .1);
	}

	&[data-compass-theme='ink'] {
		--compass-sky-from: hsl(40, 24%, 96%);
		--compass-sky-via: hsl(36, 16%, 94%);
		--compass-sky-to: hsl(220, 10%, 92%);
		--compass-glow-a: hsla(220, 10%, 45%, .1);
		--compass-glow-b: hsla(38, 30%, 55%, .12);
		--compass-star: hsl(220, 12%, 26%);
		--compass-accent: hsl(220, 16%, 24%);
		--compass-accent-tint: hsla(220, 14%, 30%, .08);
	}
}

// Print always uses the light values (see styles/README.md).
:root.dark .compass-theme {
	@media screen {
		--compass-kind-principle: hsl(44, 88%, 66%);
		--compass-kind-vision: hsl(265, 80%, 80%);
		--compass-kind-action: hsl(184, 62%, 64%);
		--compass-kind-memory: hsl(340, 74%, 77%);
		--compass-kind-note: hsl(215, 22%, 72%);

		&[data-compass-theme='aurora'] {
			--compass-sky-from: hsl(196, 56%, 9%);
			--compass-sky-via: hsl(220, 46%, 10%);
			--compass-sky-to: hsl(256, 40%, 13%);
			--compass-glow-a: hsla(168, 80%, 42%, .22);
			--compass-glow-b: hsla(270, 80%, 58%, .2);
			--compass-star: hsl(180, 60%, 88%);
			--compass-accent: hsl(176, 58%, 70%);
			--compass-accent-tint: hsla(176, 60%, 60%, .14);
		}

		&[data-compass-theme='solar'] {
			--compass-sky-from: hsl(30, 42%, 8%);
			--compass-sky-via: hsl(18, 36%, 10%);
			--compass-sky-to: hsl(350, 28%, 11%);
			--compass-glow-a: hsla(38, 95%, 52%, .2);
			--compass-glow-b: hsla(10, 85%, 52%, .16);
			--compass-star: hsl(42, 80%, 86%);
			--compass-accent: hsl(40, 86%, 66%);
			--compass-accent-tint: hsla(40, 90%, 55%, .14);
		}

		&[data-compass-theme='nebula'] {
			--compass-sky-from: hsl(266, 46%, 9%);
			--compass-sky-via: hsl(290, 38%, 11%);
			--compass-sky-to: hsl(238, 40%, 11%);
			--compass-glow-a: hsla(306, 75%, 52%, .22);
			--compass-glow-b: hsla(244, 80%, 60%, .2);
			--compass-star: hsl(290, 70%, 90%);
			--compass-accent: hsl(284, 72%, 80%);
			--compass-accent-tint: hsla(284, 72%, 65%, .14);
		}

		&[data-compass-theme='ink'] {
			--compass-sky-from: hsl(220, 10%, 8%);
			--compass-sky-via: hsl(220, 8%, 10%);
			--compass-sky-to: hsl(220, 8%, 12.5%);
			--compass-glow-a: hsla(220, 10%, 80%, .06);
			--compass-glow-b: hsla(40, 20%, 70%, .05);
			--compass-star: hsl(220, 10%, 86%);
			--compass-accent: hsl(220, 12%, 84%);
			--compass-accent-tint: hsla(220, 12%, 80%, .1);
		}
	}
}
</style>
