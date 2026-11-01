<template>
	<Teleport to="body">
		<dialog
			v-if="showDialog"
			ref="dialogRef"
			class="modal-dialog"
			:class="[
				{
					'has-overflow': overflow,
					'is-confirm': isConfirm,
				},
				isSheet ? 'bottom-sheet' : variant,
			]"
			:aria-labelledby="headerLabelId"
			:aria-label="sheetLabel"
			v-bind="attrs"
			@cancel.prevent="requestClose"
		>
			<div
				class="modal-container"
				@mousedown.self="onBackdropPress"
			>
				<div
					v-if="isSheet"
					class="bottom-sheet__panel"
				>
					<div
						v-if="title || $slots['header-action']"
						class="bottom-sheet__header"
					>
						<span class="bottom-sheet__title">{{ title }}</span>
						<slot name="header-action" />
					</div>
					<div class="bottom-sheet__body">
						<slot />
					</div>
				</div>
				<template v-else>
					<BaseButton
						:aria-label="$t('misc.closeDialog')"
						:disabled="busy"
						class="close d-print-none"
						@click="requestClose"
					>
						<Icon icon="times" />
					</BaseButton>
					<div
						class="modal-content"
						:class="{
							'has-overflow': overflow,
							'is-wide': wide
						}"
					>
						<slot>
							<div
								:id="headerId"
								class="modal-header"
							>
								<slot name="header" />
							</div>
							<div class="content">
								<slot name="text" />
							</div>
							<div class="actions">
								<XButton
									variant="secondary"
									:shadow="false"
									:disabled="busy"
									@click="requestClose"
								>
									{{ $t('misc.cancel') }}
								</XButton>
								<XButton
									v-cy="'modalPrimary'"
									variant="primary"
									:danger="danger"
									:shadow="false"
									:loading="busy"
									@click="submit"
								>
									{{ confirmLabel || $t('misc.doit') }}
								</XButton>
							</div>
						</slot>
					</div>
				</template>
			</div>
		</dialog>
	</Teleport>
</template>

<script lang="ts">
// Nested modals share one body scroll lock, so closing the inner one must not unlock the page.
let openModalCount = 0
</script>

<script lang="ts" setup>
import BaseButton from '@/components/base/BaseButton.vue'
import {computed, ref, useAttrs, useId, useSlots, watch, onBeforeUnmount, onMounted} from 'vue'

const props = withDefaults(defineProps<{
	enabled?: boolean,
	loading?: boolean,
	overflow?: boolean,
	wide?: boolean,
	variant?: 'default' | 'hint-modal' | 'scrolling' | 'top' | 'fullscreen' | 'sheet',
	title?: string,
	// Styles the confirm action of the built-in header/text layout as destructive.
	danger?: boolean,
	// Names the confirm action of the built-in layout ("Revoke session"); defaults to the generic "Do it!".
	confirmLabel?: string,
	// `@submit`. Declared as a prop so a handler that returns a promise keeps the dialog busy until it settles.
	onSubmit?: (...args: unknown[]) => unknown,
}>(), {
	enabled: true,
	loading: false,
	overflow: false,
	wide: false,
	variant: 'default',
	title: '',
	danger: false,
	confirmLabel: '',
	onSubmit: undefined,
})

const emit = defineEmits(['close', 'opened'])

// A submit handler that is still running: no second submit, and Escape, Cancel and × wait for it.
const submitting = ref(false)
const busy = computed(() => props.loading || submitting.value)

// While the close transition runs the <dialog> is still modal and receives keys: a second Escape there would close
// the caller's view again, and a route modal would step back in history and reopen the task.
function requestClose() {
	if (!busy.value && props.enabled) emit('close')
}

// The container is both the backdrop and the scroller of tall dialogs: a press on its own scrollbar targets it too,
// so only a press inside its content box counts as a press on the backdrop.
function pressedScrollbar(event: MouseEvent, container: HTMLElement) {
	const rect = container.getBoundingClientRect()
	const scrollbarWidth = container.offsetWidth - container.clientWidth
	if (scrollbarWidth > 0) {
		const x = event.clientX - rect.left
		// clientLeft covers a scrollbar drawn on the left (right-to-left pages).
		const onScrollbar = container.clientLeft >= scrollbarWidth ? x < scrollbarWidth : x >= rect.width - scrollbarWidth
		if (onScrollbar) return true
	}
	const scrollbarHeight = container.offsetHeight - container.clientHeight
	return scrollbarHeight > 0 && event.clientY - rect.top >= rect.height - scrollbarHeight
}

function onBackdropPress(event: MouseEvent) {
	if (pressedScrollbar(event, event.currentTarget as HTMLElement)) return
	event.preventDefault()
	event.stopPropagation()
	requestClose()
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof (value as PromiseLike<unknown> | null)?.then === 'function'
}

async function submit() {
	if (busy.value) return
	const result = props.onSubmit?.()
	if (!isThenable(result)) return
	submitting.value = true
	try {
		await result
	} catch {
		// The handler reports its own failure; the dialog stays open for another try or Cancel.
	} finally {
		submitting.value = false
	}
}

defineOptions({
	inheritAttrs: false,
})

// Matches --motion-fast on .modal-dialog; the token drops to 0ms under reduced motion.
const TRANSITION_DURATION = 140
// Matches $mobile-max below (useIsMobile() switches at 768px).
const MOBILE_MAX = 768

function closeTransitionDuration() {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : TRANSITION_DURATION
}

const attrs = useAttrs()
const slots = useSlots()
const headerId = useId()
// Name the dialog from its header when the fallback layout renders one and the
// caller didn't pass an explicit aria-label through the attrs.
const headerLabelId = computed(() =>
	!attrs['aria-label'] && !slots.default && slots.header ? headerId : undefined,
)
const isSheet = computed(() => props.variant === 'sheet')
// The built-in header/text/actions layout renders as a compact card instead of a full page.
const isConfirm = computed(() => !isSheet.value && !slots.default)
const sheetLabel = computed(() => (isSheet.value && props.title) || undefined)
const dialogRef = ref<HTMLDialogElement | null>(null)
const previouslyFocused = ref<Element | null>(null)
const showDialog = ref(false)
let closeTimer: ReturnType<typeof setTimeout> | null = null
let holdsScrollLock = false

// Phones show the other dialogs as a full page that scrolls with the document while the app behind is hidden
// (see the global styles below).
function isPhonePage() {
	return !isConfirm.value && !isSheet.value && Boolean(window.matchMedia?.(`(max-width: ${MOBILE_MAX}px)`).matches)
}

// html owns the page scroll (body overflow does not reach it), so that is where the page behind is held still.
// A phone page dialog scrolls with the document itself and must not be locked.
function lockBodyScroll() {
	if (holdsScrollLock || isPhonePage()) return
	holdsScrollLock = true
	if (openModalCount++ > 0) return
	const root = document.documentElement
	// Keep the room of a classic scrollbar, so the page behind the backdrop does not shift sideways.
	if (window.innerWidth > root.clientWidth) root.style.scrollbarGutter = 'stable'
	root.style.overflow = 'hidden'
}

function releaseBodyScroll() {
	if (!holdsScrollLock) return
	holdsScrollLock = false
	openModalCount--
	if (openModalCount === 0) {
		document.documentElement.style.overflow = ''
		document.documentElement.style.scrollbarGutter = ''
	}
}

// Hiding the app collapses the page, and the router's restore on Back runs while the dialog is still closing,
// so it lands at the top. Put the page back once the dialog is really gone.
let pageScroll: {entry: unknown, top: number} | null = null

function rememberPageScroll() {
	if (pageScroll || !isPhonePage()) return
	pageScroll = {entry: window.history.state?.position, top: window.scrollY}
}

function restorePageScroll() {
	const saved = pageScroll
	pageScroll = null
	if (!saved || document.querySelector('dialog.modal-dialog[open]:not(.bottom-sheet, .is-confirm)')) return
	const state = window.history.state as {position?: unknown, scroll?: {top?: number} | null} | null
	// Closed in place: where the page was. Closed by going back: where the router saved that page.
	// Closed by opening another page: that page starts where the router put it.
	const top = state?.position === saved.entry ? saved.top : state?.scroll?.top
	if (typeof top === 'number') window.scrollTo({top, left: 0})
}

function openDialog() {
	if (closeTimer) {
		clearTimeout(closeTimer)
		closeTimer = null
	}
	previouslyFocused.value = document.activeElement
	showDialog.value = true
	rememberPageScroll()
	lockBodyScroll()
	// If we're re-opening while the previous close transition is still in
	// flight the <dialog> is still mounted and [open], so the dialogRef
	// watcher below won't re-fire. Clear the data-closing flag here so the
	// dialog doesn't stay stuck at opacity 0.
	if (dialogRef.value) {
		delete dialogRef.value.dataset.closing
	}
	// The initial `showModal()` call happens in the `watch(dialogRef, …)`
	// below, which fires the moment Vue mounts the <dialog>. We cannot call
	// it synchronously here because the element is not in the DOM yet
	// (v-if="showDialog" only just became true), and we cannot rely on a
	// single nextTick because the mount can be deferred past it (#2590).
}

function closeDialog() {
	releaseBodyScroll()

	const dialog = dialogRef.value
	if (!dialog) return

	// Trigger the fade-out while the dialog is still [open] so the opacity
	// transition plays in browsers that don't support allow-discrete (Firefox).
	dialog.dataset.closing = ''

	closeTimer = setTimeout(() => {
		delete dialog.dataset.closing
		dialog.close()
		restorePageScroll()
		showDialog.value = false
		closeTimer = null
		const toFocus = previouslyFocused.value
		previouslyFocused.value = null
		if (toFocus instanceof HTMLElement && toFocus.isConnected) {
			toFocus.focus()
			return
		}
		// The trigger went away with what the dialog removed (a deleted row): keep keyboard focus on the page.
		const active = document.activeElement
		if (!active || active === document.body) {
			document.getElementById('main-content')?.focus({preventScroll: true})
		}
	}, closeTransitionDuration())
}

watch(
	() => props.enabled,
	(isEnabled) => {
		if (isEnabled) {
			openDialog()
		} else {
			closeDialog()
		}
	},
	{immediate: true},
)

// Actually call showModal() the moment the <dialog> element is mounted.
// `dialogRef` is populated by Vue during the render flush after
// `showDialog.value = true`, so this fires deterministically, no matter
// how many flushes the renderer needs (see #2590). We re-check
// `props.enabled` here because the prop can flip back to `false` between
// `openDialog()` and the mount flush, in which case we must not open.
watch(dialogRef, (dialog) => {
	if (!dialog) return
	if (!props.enabled) return
	delete dialog.dataset.closing
	dialog.showModal()
	// Focus calls made before this (e.g. v-focus in `mounted`) were dropped on the closed dialog.
	emit('opened')
})

// A <dialog> opened with showModal() lives in the browser's top layer, which
// renders only the first page during print (top-layer elements are
// viewport-anchored and don't paginate). Temporarily swap to a non-modal
// dialog for the duration of the print so the content flows in normal
// document order and can break across pages.
let wasModalBeforePrint = false

function handleBeforePrint() {
	const dialog = dialogRef.value
	if (dialog && dialog.matches(':modal')) {
		wasModalBeforePrint = true
		dialog.close()
		dialog.show()
	}
}

function handleAfterPrint() {
	if (!wasModalBeforePrint) return
	wasModalBeforePrint = false
	const dialog = dialogRef.value
	if (dialog && dialog.open) {
		dialog.close()
		dialog.showModal()
	}
}

onMounted(() => {
	window.addEventListener('beforeprint', handleBeforePrint)
	window.addEventListener('afterprint', handleAfterPrint)
})

// Callers which render the modal behind a v-if (e.g. Popup's sheet) unmount it
// without ever running closeDialog(), so focus restoration has to happen here too.
onBeforeUnmount(() => {
	if (closeTimer) {
		clearTimeout(closeTimer)
		closeTimer = null
	}
	releaseBodyScroll()

	const dialog = dialogRef.value
	// Leave the top layer first: while the dialog is [open] everything outside
	// it is inert and focus() silently does nothing.
	dialog?.close()
	restorePageScroll()
	const toFocus = previouslyFocused.value
	const active = document.activeElement
	const focusIsLost = !active || active === document.body || Boolean(dialog?.contains(active))
	if (focusIsLost && toFocus instanceof HTMLElement && toFocus.isConnected) {
		toFocus.focus()
	}
	previouslyFocused.value = null

	window.removeEventListener('beforeprint', handleBeforePrint)
	window.removeEventListener('afterprint', handleAfterPrint)
})
</script>

<style lang="scss" scoped>
$modal-margin: 4rem;
$modal-width: 1024px;
// useIsMobile() switches at 768px; Bulma's $tablet starts at 769px.
$mobile-max: $tablet - 1px;

.modal-dialog {
	// Reset UA dialog styles
	padding: 0;
	border: none;
	// The scrim lives on the dialog element, not on ::backdrop: Chromium
	// intermittently stops painting a styled ::backdrop (e.g. after the
	// dialog's subtree re-renders, or while display is transitioned) even
	// though getComputedStyle still reports the color. The dialog fills the
	// viewport anyway, and its opacity transition fades the scrim with it —
	// same as the old div-based .modal-mask.
	background: var(--scrim);
	// Only the close button and the lightbox sit directly on the scrim, which is dark in both themes.
	color: #ffffff;
	// Fill viewport
	position: fixed;
	inset: 0;
	inline-size: 100%;
	block-size: 100%;
	max-inline-size: 100%;
	max-block-size: 100%;

	// Transitions. No display/allow-discrete transition needed: the close
	// fade runs while the dialog is still [open] (data-closing + timer in
	// closeDialog), and transitioning display triggers the Chromium paint
	// bug above. Keep the duration in sync with TRANSITION_DURATION.
	opacity: 0;
	transition: opacity var(--motion-fast) var(--ease-standard);

	&[open]:not([data-closing]) {
		opacity: 1;

		@starting-style {
			opacity: 0;
		}
	}

	&::backdrop {
		background-color: transparent;
	}

	// in quick-add mode the Electron window itself is the overlay — no scrim
	&:has(.is-quick-add-mode) {
		background: transparent;
	}
}

// Judging a picture needs a near-opaque backdrop; dialogs only dim the page.
.fullscreen {
	background: hsla(0, 0%, 0%, .86);
}

// Surfaces rise a few pixels while the scrim fades in; the lightbox only fades.
.modal-dialog:not(.fullscreen) .modal-content {
	animation: modal-surface-in var(--motion-slow) var(--ease-enter);
}

@keyframes modal-surface-in {
	from {
		opacity: 0;
		translate: 0 .5rem;
	}
}

@keyframes sheet-surface-in {
	from {
		translate: 0 1.5rem;
	}
}

.modal-container {
	position: relative;
	inline-size: 100%;
	block-size: 100%;
	max-block-size: 100dvh;
	overflow: auto;
	padding-block-start: env(safe-area-inset-top);
	padding-block-end: env(safe-area-inset-bottom);
}

.default:not(.is-confirm) .modal-content,
.hint-modal .modal-content,
.top .modal-content {
	text-align: center;
	position: absolute;
	// fine to use top/left since we're only using this to position it centered
	inset-block-start: 50%;
	inset-inline-start: 50%;
	transform: translate(-50%, -50%);
	// Cap centered content to the viewport and scroll inside it. Without this a
	// taller-than-viewport modal centres its top edge above the viewport, where
	// the container's overflow can't scroll to it (the .top variant overrides
	// both values below).
	max-block-size: calc(100dvh - 2rem);
	overflow: auto;

	[dir="rtl"] & {
		transform: translate(50%, -50%);
	}

	@media screen and (max-width: $mobile-max) {
		margin: 0;
		position: static;
		transform: none;
		// the fullscreen mobile layout flows and scrolls in .modal-container
		max-block-size: none;
		overflow: visible;
	}
}

// anchored below the top edge instead of centered, used for QuickActions
.top .modal-content {
	inset-block-start: 3rem;
	transform: translate(-50%, 0);
	max-block-size: calc(100dvh - 6rem);
	overflow: auto;

	[dir="rtl"] & {
		transform: translate(50%, 0);
	}

	// the fullscreen mobile layout flows and scrolls in .modal-container
	@media screen and (max-width: $mobile-max) {
		transform: none;
		max-block-size: none;
		overflow: visible;
	}
}

// Default width for centered modals. Scoped with :not(.is-wide) so the
// `wide` prop can still expand the modal (the .is-wide rule below would
// otherwise be outranked by .default .modal-content's specificity).
.default:not(.is-confirm) .modal-content:not(.is-wide),
.hint-modal .modal-content:not(.is-wide),
.top .modal-content:not(.is-wide) {
	inline-size: calc(100% - 2rem);
	max-inline-size: 640px;

	@media screen and (max-width: $mobile-max) {
		inline-size: 100%;
		max-inline-size: none;
	}
}

// Confirm dialogs (the built-in header/text/actions layout) stay a compact
// card on every screen size instead of turning into a full page on phones.
.is-confirm {
	.modal-container {
		display: flex;
		align-items: center;
		justify-content: center;
		padding:
			max(var(--space-4), env(safe-area-inset-top))
			var(--space-4)
			max(var(--space-4), env(safe-area-inset-bottom));
	}

	// Cancel sits right next to the confirm action; the viewport corner close would only duplicate it.
	.close {
		display: none;
	}

	.modal-content {
		inline-size: 100%;
		max-inline-size: 28rem;
		max-block-size: 100%;
		overflow: auto;
		padding: var(--space-5) var(--space-5) var(--space-4);
		background: var(--surface-raised);
		color: var(--text-primary);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		box-shadow: var(--elevation-3);
		text-align: start;
		overflow-wrap: anywhere;
	}

	.modal-header {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-tight);
		color: var(--text-strong);
	}

	.content {
		margin-block: var(--space-2) var(--space-5);
		font-size: var(--text-md);
		line-height: var(--leading-normal);
		color: var(--text-secondary);

		// Confirm copy written for the old dark scrim marks its emphasis as white text.
		:deep(.has-text-white) {
			color: var(--text-strong) !important;
		}
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
}

// scrolling-content
// used e.g. for <TaskDetailViewModal>
.scrolling .modal-content {
	inline-size: 100%;
	margin: $modal-margin auto;

	max-block-size: none; // reset bulma
	overflow: visible; // reset bulma

	@media not print {
		max-inline-size: $modal-width;
	}

	@media screen and (min-width: $tablet) {
		max-block-size: none; // reset bulma
		margin: $modal-margin auto; // reset bulma
		inline-size: 100%;
	}

	@media screen and (max-width: $desktop), print {
		margin: 0;
	}
}

.is-wide {
	max-inline-size: $desktop;
	inline-size: calc(100% - 2rem);
}

// no centering transform: it would trap fixed descendants in a small containing block
.fullscreen .modal-content {
	position: static;
	inline-size: 100%;
	block-size: 100%;
	max-inline-size: none;
	max-block-size: none;
	transform: none;
	display: flex;
	align-items: center;
	justify-content: center;
}

// .modal-content would otherwise paint over the fixed .close
.fullscreen .close {
	z-index: 1;
}

.hint-modal {
	:deep(.card-content) {
		text-align: start;

		.info {
			font-style: italic;
		}
	}
}

// No scrim element: the dialog itself paints it, so the container's mousedown-outside is the scrim tap.
.bottom-sheet {
	background: var(--scrim);

	.modal-container {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		// html owns the page scroll, so body overflow alone does not lock it — contain the chain instead.
		overflow: hidden;
		overscroll-behavior: contain;
		padding: 0;
	}
}

.bottom-sheet__panel {
	display: flex;
	flex-direction: column;
	inline-size: 100%;
	overflow-x: hidden;
	max-block-size: 92dvh;
	padding-block: var(--space-2) env(safe-area-inset-bottom);
	background: var(--surface-raised);
	color: var(--text-primary);
	border-start-start-radius: var(--radius-lg);
	border-start-end-radius: var(--radius-lg);
	box-shadow: var(--elevation-3);
	animation: sheet-surface-in var(--motion-slow) var(--ease-enter);
}

.bottom-sheet__header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	padding: var(--space-2) var(--space-4) var(--space-3);
	flex-shrink: 0;
}

.bottom-sheet__title {
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	color: var(--text-strong);
}

.bottom-sheet__body {
	min-block-size: 0;
	overflow-y: auto;
	overscroll-behavior: contain;

	// The mobile :deep(.card) rule below stretches every card to viewport height; a card inside the sheet must not be.
	:deep(.card) {
		min-block-size: 0 !important;
	}
}

.close {
	$close-button-padding: 26px;
	position: fixed;
	inset-block-start: .5rem;
	inset-inline-end: $close-button-padding;
	display: grid;
	place-items: center;
	inline-size: 2.5rem;
	block-size: 2.5rem;
	border-radius: var(--radius-full);
	color: inherit;
	font-size: var(--text-xl);
	transition: background-color var(--motion-fast) var(--ease-standard);

	// A light wash: the button sits on the scrim, which stays dark in both themes.
	&:hover {
		background-color: hsla(0, 0%, 100%, .14);
	}

	@media screen and (min-width: $desktop) and (width <= calc(#{$desktop	} + #{$close-button-min-space})) {
		inset-block-start: calc(5px + $modal-margin);
		inset-inline-end: 50%;
		// we align the close button to the modal until there is enough space outside for it
		transform: translateX(calc((#{$modal-width} / 2) - #{$close-button-padding}));

		// fullscreen has no card to hug — keep the corner position instead
		.fullscreen & {
			inset-block-start: .5rem;
			inset-inline-end: $close-button-padding;
			transform: none;
		}
	}

	@media screen and (min-width: $tablet) and (max-width: #{$desktop + $close-button-min-space}) {
		inset-block-start: .75rem;
	}
}

@media print, screen and (max-width: $mobile-max) {
	.modal-dialog {
		overflow: visible !important;
	}

	.modal-container {
		block-size: auto;
		min-block-size: 100dvh;
		padding-block-start: env(safe-area-inset-top);
		padding-block-end: env(safe-area-inset-bottom);
	}

	// no card to center against, so the container needs full height
	.fullscreen .modal-container {
		block-size: 100dvh;
	}

	.modal-content {
		position: static;
		max-block-size: none;
	}

	.close {
		display: none;
	}

	// no card-header close icon to fall back on
	.fullscreen .close {
		display: grid;
	}

	:deep(.card) {
		border: none !important;
		border-radius: 0 !important;
		min-block-size: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		margin-block-end: 0 !important;
	}
}

// Unconstrain the native <dialog> so the full modal content flows onto the
// printed page instead of being clipped to the viewport-sized top layer.
@media print {
	.modal-dialog {
		position: static;
		inline-size: auto;
		block-size: auto;
		max-inline-size: none;
		max-block-size: none;
		background: transparent;

		&::backdrop {
			display: none;
		}
	}

	.modal-container {
		overflow: visible;
		min-block-size: 0;
	}

	:deep(.card) {
		min-block-size: 0 !important;
	}
}

.modal-content :deep(.card .card-header-icon.close) {
	display: none;

	@media screen and (max-width: $mobile-max) {
		display: block;
	}
}
</style>

<style lang="scss">
// Printing shows the dialog alone.
@media print {
	body:has(dialog[open].modal-dialog:not(.bottom-sheet)) #app {
		display: none;
	}

	// The page scroll lock (an inline style on html) would cut the print off after the first page.
	html:has(dialog[open].modal-dialog) {
		overflow: visible !important;
	}
}

// Full-page dialogs cover the app on phones anyway; sheets and confirm cards keep it visible behind the scrim.
@media screen and (max-width: $tablet - 1px) {
	body:has(dialog[open].modal-dialog:not(.bottom-sheet, .is-confirm)) #app {
		display: none;
	}
}
</style>
