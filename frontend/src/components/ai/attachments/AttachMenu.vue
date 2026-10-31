<script setup lang="ts">
import {nextTick, onBeforeUnmount, ref, useId} from 'vue'
import {autoUpdate, computePosition, flip, offset, shift} from '@floating-ui/dom'
import {useI18n} from 'vue-i18n'
defineProps<{disabled?: boolean}>()
const emit = defineEmits<{device: [], drive: []}>()
const {t} = useI18n({useScope: 'global'})
const menuId = useId()
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const open = ref(false)
let cleanup: (() => void) | undefined
async function position() {
	if (!trigger.value || !menu.value) return
	const {x, y} = await computePosition(trigger.value, menu.value, {strategy: 'fixed', placement: 'top-start', middleware: [offset(6), flip(), shift({padding: 8})]})
	Object.assign(menu.value.style, {left: `${x}px`, top: `${y}px`})
}
async function toggle(event: Event) {
	open.value = (event as ToggleEvent).newState === 'open'
	cleanup?.(); cleanup = undefined
	if (!open.value) return
	await nextTick()
	if (trigger.value && menu.value) cleanup = autoUpdate(trigger.value, menu.value, position)
	menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
// Synchronous with the click, so the hidden file input still receives the user's activation.
function choose(source: 'device' | 'drive') {
	menu.value?.hidePopover()
	trigger.value?.focus()
	if (source === 'device') emit('device')
	else emit('drive')
}
function keydown(event: KeyboardEvent) {
	const items = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
	const index = items.indexOf(document.activeElement as HTMLButtonElement)
	if (event.key === 'Escape' || event.key === 'Tab') {
		menu.value?.hidePopover()
		if (event.key === 'Escape') {
			event.preventDefault()
			// Only the menu closes: the floating panel also listens for Escape.
			event.stopPropagation()
			trigger.value?.focus()
		}
		return
	}
	if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
	event.preventDefault()
	const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
	items[next]?.focus()
}
onBeforeUnmount(() => cleanup?.())
</script>

<template>
	<!-- popovertarget makes the trigger the invoker, so clicking it while open closes instead of reopening. -->
	<button
		ref="trigger"
		type="button"
		class="attach-menu-trigger"
		:popovertarget="menuId"
		:disabled="disabled"
		:title="t('chatFiles.attach')"
		:aria-label="t('chatFiles.attach')"
		aria-haspopup="menu"
		:aria-expanded="open"
	>
		<Icon icon="paperclip" />
	</button>
	<div
		:id="menuId"
		ref="menu"
		popover="auto"
		class="attach-menu"
		role="menu"
		:aria-label="t('chatFiles.attachMenu')"
		@toggle="toggle"
		@keydown="keydown"
	>
		<button
			type="button"
			role="menuitem"
			@click="choose('device')"
		>
			<Icon icon="arrow-up-from-bracket" />{{ t('chatFiles.fromDevice') }}
		</button>
		<button
			type="button"
			role="menuitem"
			@click="choose('drive')"
		>
			<Icon icon="folder" />{{ t('drive.choose') }}
		</button>
	</div>
</template>

<style scoped lang="scss">
.attach-menu-trigger {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	min-inline-size: var(--control-height-sm);
	min-block-size: var(--control-height-sm);
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	cursor: pointer;

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&[aria-expanded='true'] {
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&:focus-visible {
		@include focus-ring;
	}

	&:disabled {
		opacity: .5;
		cursor: not-allowed;
	}

	@media (pointer: coarse) {
		min-inline-size: var(--target-min);
		min-block-size: var(--target-min);
	}
}

.attach-menu {
	position: fixed;
	inset: auto;
	inline-size: min(15rem, calc(100vw - 1rem));
	margin: 0;
	padding: var(--space-1);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	button {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		inline-size: 100%;
		min-block-size: var(--control-height);
		padding: var(--space-1) var(--space-3);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: var(--text-md);
		text-align: start;
		cursor: pointer;

		&:hover,
		&:focus-visible {
			background: var(--surface-hover);
		}

		&:focus-visible {
			outline: 2px solid var(--focus-ring-color);
			outline-offset: -2px;
		}

		@media (pointer: coarse) {
			min-block-size: var(--target-min);
		}
	}

	svg {
		flex: 0 0 1rem;
		inline-size: 1rem;
		block-size: 1rem;
		color: var(--text-tertiary);
	}
}
</style>
