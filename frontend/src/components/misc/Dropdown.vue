<template>
	<div
		ref="dropdown"
		class="dropdown"
		@pointerenter="initialMount = true"
		@keydown="onKeydown"
	>
		<slot
			name="trigger"
			:close="close"
			:toggle-open="toggleOpen"
			:open="open"
		>
			<BaseButton
				class="dropdown-trigger is-flex"
				:aria-label="triggerLabel"
				:aria-expanded="open"
				@click="toggleOpen"
			>
				<Icon
					:icon="triggerIcon"
					class="icon"
				/>
			</BaseButton>
		</slot>

		<CustomTransition name="fade">
			<div
				v-if="initialMount || open"
				v-show="open"
				ref="dropdownMenu"
				class="dropdown-menu"
				:style="dropdownMenuStyle"
			>
				<div class="dropdown-content">
					<slot :close="close" />
				</div>
			</div>
		</CustomTransition>
	</div>
</template>

<script setup lang="ts">
import {ref, nextTick, watch, computed, onBeforeUnmount, type PropType} from 'vue'
import {onClickOutside} from '@vueuse/core'
import {computePosition, autoPlacement, offset, shift, size, autoUpdate} from '@floating-ui/dom'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import CustomTransition from '@/components/misc/CustomTransition.vue'
import BaseButton from '@/components/base/BaseButton.vue'

defineProps({
	triggerIcon: {type: [String, Array, Object] as PropType<IconProp>, default: 'ellipsis-h'},
	triggerLabel: {type: String, default: undefined},
})

const emit = defineEmits<{
	'close': [event: PointerEvent]
	// The menu is placed and visible, so its items can take focus.
	'shown': []
}>()

defineSlots<{
	'trigger': (props: {
		close: () => void,
		toggleOpen: () => void, 
		open: boolean
	}) => void,
	'default': (props: {close: () => void}) => void
}>()

const initialMount = ref(false)
const open = ref(false)
const positioned = ref(false)
let stopPositioning: (() => void) | undefined

const dropdown = ref<HTMLElement>()
const dropdownMenu = ref<HTMLElement>()
const dropdownPosition = ref({x: 0, y: 0})
const dropdownMenuOffset = computed(() => 4)

function close() {
	open.value = false
}

// Menus in a dialog render in the top layer, above the navbar.
function fixedNavbarBottom(trigger: HTMLElement): number {
	const navbar = document.querySelector<HTMLElement>('.navbar')
	if (!navbar || trigger.closest('dialog[open]') || getComputedStyle(navbar).position !== 'fixed') {
		return 0
	}
	return navbar.getBoundingClientRect().bottom
}

async function updatePosition() {
	if (!dropdown.value || !dropdownMenu.value) {
		return
	}

	await nextTick()

	const padding = {top: fixedNavbarBottom(dropdown.value) + 8, right: 8, bottom: 8, left: 8}

	const {x, y} = await computePosition(dropdown.value, dropdownMenu.value, {
		placement: 'bottom-end',
		strategy: 'absolute',
		middleware: [
			offset(dropdownMenuOffset.value),
			autoPlacement({
				allowedPlacements: ['bottom-end', 'top-end', 'bottom-start', 'top-start'],
				padding,
			}),
			shift({padding}),
			size({
				padding,
				// Set synchronously so floating-ui re-measures the capped menu before placing it.
				apply({availableHeight, elements}) {
					elements.floating.style.setProperty('--dropdown-max-height', `${availableHeight}px`)
				},
			}),
		],
	})

	if (!open.value) return
	dropdownPosition.value = {x, y}
	positioned.value = true
}

const dropdownMenuStyle = computed(() => ({
	visibility: positioned.value ? 'visible' as const : 'hidden' as const,
	left: `${dropdownPosition.value.x}px`,
	top: `${dropdownPosition.value.y}px`,
	'--hover-offset': `${dropdownMenuOffset.value}px`,
}))

function toggleOpen() {
	open.value = !open.value
}

function onKeydown(e: KeyboardEvent) {
	if (e.key !== 'Escape' || !open.value) {
		return
	}
	// preventDefault cancels a wrapping native <dialog>'s Escape close request (task detail, settings dialogs);
	// stopPropagation alone does not, so the dialog would close together with the menu.
	e.preventDefault()
	e.stopPropagation()
	close()
	focusTrigger()
}

// Return focus to the trigger, which is the first focusable element that lives
// outside the popup menu.
function focusTrigger() {
	const focusables = dropdown.value?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]')
	for (const el of focusables ?? []) {
		if (!el.closest('.dropdown-menu')) {
			el.focus()
			return
		}
	}
}

watch(open, async isOpen => {
	stopPositioning?.()
	stopPositioning = undefined
	positioned.value = false
	if (!isOpen) return
	await nextTick()
	if (open.value && dropdown.value && dropdownMenu.value) stopPositioning = autoUpdate(dropdown.value, dropdownMenu.value, updatePosition)
})
onBeforeUnmount(() => stopPositioning?.())
// Post flush: the menu stays visibility:hidden, and so unfocusable, until the DOM has the new style.
watch(positioned, isPositioned => {
	if (isPositioned) emit('shown')
}, {flush: 'post'})

onClickOutside(dropdown, (e) => {
	if (!open.value) {
		return
	}
	close()
	emit('close', e)
})

defineExpose({
	// For menus whose items open a page or a dialog. Returning focus to the menu button means a dialog opened from
	// an item gives focus back to something visible once it closes.
	closeMenu({focusTrigger: refocus = false}: {focusTrigger?: boolean} = {}) {
		if (!open.value) return
		close()
		if (refocus) focusTrigger()
	},
})
</script>

<style lang="scss" scoped>
.dropdown {
	display: inline-flex;
	position: relative;
}

.dropdown-menu::before {
  // The decorative gap must not cover controls inside the menu.
  pointer-events: none;
  content: "";
  position: absolute;
  inset: calc(var(--hover-offset) * -1);
}

.dropdown-menu {
	min-inline-size: 12rem;
	position: absolute;
	z-index: 20;
	display: block;
}

.dropdown-content {
	max-block-size: var(--dropdown-max-height, none);
	overflow-y: auto;
	background-color: var(--surface-raised);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	padding: .3rem;
	box-shadow: var(--elevation-3);
}

.dropdown-divider {
	background-color: var(--border-subtle);
	border: none;
	display: block;
	block-size: 1px;
	margin: .3rem -.3rem;
}
</style>
