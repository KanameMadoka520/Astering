<template>
	<!-- Explicit aria-current: RouterLink ignores the query, so it would mark every page link as current. -->
	<!-- aria-disabled, not disabled: "Previous" on the first page stays a focusable link instead of turning into a
	     div, so focus is not lost when the last page is reached with the keyboard. -->
	<BaseButton
		:to="to"
		:aria-disabled="disabled"
		:class="[`pagination-${variant}`, {'is-current': isCurrent}]"
		:aria-current="isCurrent ? 'page' : 'false'"
		@click="emit('click')"
	>
		<slot />
	</BaseButton>
</template>

<script lang="ts" setup>
import type {RouteLocationRaw} from 'vue-router'
import BaseButton from '@/components/base/BaseButton.vue'

withDefaults(defineProps<{
	variant: 'previous' | 'next' | 'link',
	isCurrent?: boolean,
	disabled?: boolean,
	to?: RouteLocationRaw,
}>(), {
	isCurrent: false,
	disabled: false,
	to: undefined,
})

const emit = defineEmits<{
	(e: 'click'): void,
}>()
</script>

<style lang="scss" scoped>
// Rules ported from bulma-css-variables/sass/components/pagination.sass.
// PaginationItem owns the .pagination-previous / .pagination-next /
// .pagination-link markup, so scoped attributes attach directly to these
// classes — no :deep() necessary.

.pagination-previous,
.pagination-next,
.pagination-link {
	appearance: none;
	align-items: center;
	display: inline-flex;
	justify-content: center;
	position: relative;
	min-block-size: var(--control-height);
	min-inline-size: var(--control-height);
	margin: var(--space-1);
	padding: 0 var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: $radius;
	background-color: var(--surface);
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	font-variant-numeric: tabular-nums;
	line-height: 1.5;
	text-align: center;
	vertical-align: top;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	-webkit-touch-callout: none;
	user-select: none;

	&:hover {
		border-color: var(--border-strong);
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
	}

	&[disabled],
	&[aria-disabled='true'],
	fieldset[disabled] & {
		cursor: not-allowed;
		opacity: .5;
		background-color: transparent;
		background-image: none;
		border-color: var(--border-subtle);
	}
}

.pagination-previous,
.pagination-next {
	padding-inline: var(--space-3);
	white-space: nowrap;
}

.pagination-link.is-current {
	background-color: var(--primary);
	background-image: none;
	border-color: var(--primary);
	color: var(--text-on-accent);
}

@media screen and (max-width: $tablet - 1px) {
	.pagination-previous,
	.pagination-next {
		flex-grow: 1;
		flex-shrink: 1;
	}
}

@media screen and (min-width: $tablet), print {
	.pagination-previous,
	.pagination-next,
	.pagination-link {
		margin-block: 0;
	}

	// BasePagination hardcodes `.is-centered`, so prev and next are flex-ordered
	// around the centered page list (prev left, list middle, next right).
	.pagination-previous {
		order: 1;
	}

	.pagination-next {
		order: 3;
	}
}
</style>

<style lang="scss">
// Unscoped: this rule relies on ancestors (.app-container.has-background /
// .link-share-container.has-background) that live outside PaginationItem.
// Previously lived in styles/theme/background.scss, then BasePagination.vue.
.app-container.has-background .pagination-link:not(.is-current),
.link-share-container.has-background .pagination-link:not(.is-current) {
	background-color: var(--surface);
}
</style>
