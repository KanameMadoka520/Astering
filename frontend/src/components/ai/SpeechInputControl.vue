<script setup lang="ts">
import {
	computed,
	nextTick,
	onBeforeUnmount,
	ref,
	useId,
	watch,
} from 'vue'
import {useI18n} from 'vue-i18n'
import Popup from '@/components/misc/Popup.vue'

const props = withDefaults(defineProps<{
	disabled?: boolean
	disabledReason?: string
	recording: boolean
	requesting: boolean
	stopping: boolean
	processing: boolean
	processingLabel?: string
	elapsed: number
	canTidy: boolean
	tidy: boolean
	canCleanup: boolean
}>(), {
	disabled: false,
	disabledReason: '',
	processingLabel: '',
})
const emit = defineEmits<{
	start: []
	stop: []
	cancel: []
	upload: []
	tidy: []
	'update:tidy': [value: boolean]
}>()
const {t} = useI18n({useScope: 'global'})
const mainButton = ref<HTMLButtonElement>()
const cancelButton = ref<HTMLButtonElement>()
const moreButton = ref<HTMLButtonElement>()
const menuOpen = ref(false)
const menuID = useId()
const holding = ref(false)
const slidingToCancel = ref(false)
const active = computed(() => props.requesting || props.recording || props.stopping || props.processing)
const mainBlocked = computed(() => props.stopping || props.processing || (props.disabled && !active.value))
const actionLabel = computed(() => t(props.requesting ? 'tcy.voice.cancel'
	: props.recording ? 'tcy.voice.stop' : 'tcy.voice.start'))
const statusKey = computed(() => props.processing ? 'tcy.voice.processing'
	: props.stopping ? 'tcy.voice.stopping'
		: props.requesting ? 'tcy.voice.requesting' : 'tcy.voice.recording')
const statusLabel = computed(() => {
	if (props.requesting) return t('tcy.voice.requesting')
	if (slidingToCancel.value) return t('tcy.voice.cancelReleaseHint')
	if (props.processing && props.processingLabel) return props.processingLabel
	if (holding.value && props.recording) return t('tcy.voice.releaseHint')
	return t(statusKey.value)
})
const clock = computed(() => {
	const seconds = Math.max(0, Math.floor(props.elapsed))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})
type HoldGesture = {
	pointerID: number
	startX: number
	started: boolean
	cancelled: boolean
	timer?: ReturnType<typeof setTimeout>
}
let gesture: HoldGesture | undefined
let suppressPointerClick = false

function clearGesture() {
	const previous = gesture
	gesture = undefined
	window.removeEventListener('pointerdown', additionalPointerDown, true)
	if (previous?.timer) clearTimeout(previous.timer)
	holding.value = false
	slidingToCancel.value = false
	if (previous && mainButton.value?.hasPointerCapture?.(previous.pointerID)) {
		mainButton.value.releasePointerCapture(previous.pointerID)
	}
	return previous
}

function additionalPointerDown(event: PointerEvent) {
	if (!gesture || event.pointerId === gesture.pointerID
		|| (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return
	const previous = clearGesture()!
	suppressPointerClick = true
	if (previous.started) emit('cancel')
}

function pointerDown(event: PointerEvent) {
	if (event.pointerType === 'mouse') {
		suppressPointerClick = false
		return
	}
	if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
	if (!event.isPrimary || event.button !== 0 || gesture || active.value || props.disabled) return
	suppressPointerClick = false
	try {
		mainButton.value?.setPointerCapture(event.pointerId)
	} catch {
		return // The native click remains available if this pointer cannot be captured.
	}
	const current: HoldGesture = {
		pointerID: event.pointerId,
		startX: event.clientX,
		started: false,
		cancelled: false,
	}
	gesture = current
	window.addEventListener('pointerdown', additionalPointerDown, true)
	current.timer = setTimeout(() => {
		if (gesture !== current || current.cancelled || active.value || props.disabled) return
		current.started = true
		holding.value = true
		suppressPointerClick = true
		emit('start')
	}, 350)
}

function pointerMove(event: PointerEvent) {
	if (!gesture || event.pointerId !== gesture.pointerID) return
	gesture.cancelled = gesture.startX - event.clientX >= 72
	slidingToCancel.value = gesture.cancelled
}

function pointerUp(event: PointerEvent) {
	if (!gesture || event.pointerId !== gesture.pointerID) return
	const previous = clearGesture()!
	if (previous.cancelled) {
		suppressPointerClick = true
		if (previous.started) emit('cancel')
		return
	}
	if (!previous.started) return // A short tap uses the button's native click, including keyboard support.
	suppressPointerClick = true
	if (props.recording) emit('stop')
	else emit('cancel') // Releasing during the permission prompt must not start an invisible recording later.
}

function pointerCancel(event: PointerEvent) {
	if (!gesture || event.pointerId !== gesture.pointerID) return
	const previous = clearGesture()!
	suppressPointerClick = true
	if (previous.started) emit('cancel')
}

function click(event: MouseEvent) {
	if (event.button !== 0) return
	if (suppressPointerClick && event.detail !== 0) {
		suppressPointerClick = false
		event.preventDefault()
		return
	}
	suppressPointerClick = false
	if (mainBlocked.value) return
	menuOpen.value = false
	if (props.requesting) emit('cancel')
	else if (props.recording) emit('stop')
	else emit('start')
}

function cancel() {
	clearGesture()
	if (active.value) emit('cancel')
}
function menuAction(action: 'upload' | 'tidy', close: () => void) {
	if (active.value || (action === 'upload' ? props.disabled : !props.canTidy)) return
	close()
	moreButton.value?.focus()
	if (action === 'upload') emit('upload')
	else emit('tidy')
}
function changeTidy(event: Event) {
	if (active.value || !props.canCleanup) return
	emit('update:tidy', (event.target as HTMLInputElement).checked)
}
watch(() => props.disabled, disabled => {
	if (disabled && !active.value && clearGesture()?.started) emit('cancel')
})
watch(active, (value, previous) => {
	if (value || !previous) return
	if (clearGesture()?.started) suppressPointerClick = true
	if (document.activeElement !== cancelButton.value) return
	void nextTick(() => mainButton.value?.focus())
})
onBeforeUnmount(() => {
	if (clearGesture()?.started) emit('cancel')
})
</script>

<template>
	<div
		class="speech-input-control"
		:class="{'is-active': active}"
	>
		<button
			ref="mainButton"
			type="button"
			class="speech-input-control__mic"
			:class="{'is-recording': recording, 'is-holding': holding, 'is-cancelling': slidingToCancel}"
			:aria-label="actionLabel"
			:aria-pressed="recording"
			:aria-disabled="mainBlocked"
			:title="disabled && disabledReason ? disabledReason : t('tcy.voice.tapHint')"
			@pointerdown="pointerDown"
			@pointermove="pointerMove"
			@pointerup="pointerUp"
			@pointercancel="pointerCancel"
			@lostpointercapture="pointerCancel"
			@contextmenu.prevent
			@click="click"
		>
			<Icon
				:icon="recording || requesting ? 'stop' : 'microphone'"
				aria-hidden="true"
			/>
		</button>
		<Popup
			v-model:open="menuOpen"
			:anchor="moreButton"
			placement="top-start"
			surface
		>
			<template #trigger="{toggle}">
				<button
					ref="moreButton"
					type="button"
					class="speech-input-control__more"
					:aria-label="t('tcy.voice.more')"
					:aria-expanded="menuOpen"
					:aria-controls="menuID"
					@click="toggle"
				>
					<Icon
						icon="chevron-down"
						aria-hidden="true"
					/>
				</button>
			</template>
			<template #content="{close}">
				<div
					:id="menuID"
					class="speech-input-menu"
					role="group"
					:aria-label="t('tcy.voice.menuLabel')"
					@keydown.esc.prevent.stop="close(); moreButton?.focus()"
				>
					<button
						type="button"
						:aria-disabled="disabled || active"
						@click="menuAction('upload', close)"
					>
						{{ t('tcy.voice.upload') }}
					</button>
					<button
						type="button"
						:aria-disabled="active || !canTidy"
						@click="menuAction('tidy', close)"
					>
						{{ t('tcy.voice.tidy') }}
					</button>
					<label class="speech-input-menu__cleanup">
						<input
							type="checkbox"
							:checked="tidy"
							:aria-disabled="!canCleanup || active"
							@click="(!canCleanup || active) && $event.preventDefault()"
							@change="changeTidy"
						>
						{{ t('tcy.voice.autoTidy') }}
					</label>
					<p v-if="!canCleanup">
						{{ t('tcy.voice.cleanupUnavailable') }}
					</p>
					<p v-if="disabledReason">
						{{ disabledReason }}
					</p>
					<p class="speech-input-menu__hint">
						{{ t('tcy.voice.holdHint') }}
					</p>
				</div>
			</template>
		</Popup>
		<button
			v-show="active"
			ref="cancelButton"
			type="button"
			class="speech-input-control__cancel"
			:aria-label="t('tcy.voice.cancel')"
			:title="t('tcy.voice.cancel')"
			@click="cancel"
		>
			<Icon
				icon="xmark"
				aria-hidden="true"
			/>
		</button>
		<div
			v-show="active || holding || slidingToCancel"
			class="speech-input-control__state"
		>
			<span
				role="status"
				aria-live="polite"
			>
				{{ statusLabel }}
			</span>
			<span
				v-if="recording"
				class="speech-input-control__clock"
				aria-live="off"
				:aria-label="t('tcy.voice.elapsed', {seconds: Math.max(0, Math.floor(elapsed))})"
			>
				{{ clock }}
			</span>
			<small v-if="holding">
				{{ t('tcy.voice.slideCancelHint') }}
			</small>
		</div>
	</div>
</template>

<style scoped lang="scss">
.speech-input-control {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: 100%;

	&.is-active {
		display: grid;
		grid-template-columns: repeat(3, 44px);
	}

	> button {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		min-inline-size: 44px;
		min-block-size: 44px;
		padding: var(--space-2);
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		cursor: pointer;

		&:hover { background: var(--surface-hover); }
		&:focus-visible { @include focus-ring; }
		&[aria-disabled='true'] {
			opacity: .5;
			cursor: default;
		}
	}
}

.speech-input-control__mic {
	touch-action: none;
	user-select: none;
	-webkit-touch-callout: none;
	transition: background-color var(--motion-fast), color var(--motion-fast), transform var(--motion-fast);

	&.is-recording {
		background: var(--danger-light);
		color: var(--danger);
	}

	&.is-holding { transform: scale(1.06); }
	&.is-cancelling {
		background: var(--danger);
		color: var(--danger-invert);
	}

	@media (prefers-reduced-motion: reduce) {
		transition: none;
		transform: none;
	}
}

.speech-input-control__state {
	display: flex;
	grid-column: 1 / -1;
	flex: 1 0 100%;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-2);
	min-inline-size: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;

	small { flex-basis: 100%; }
}

.speech-input-control__clock { font-variant-numeric: tabular-nums; }

.speech-input-menu {
	display: grid;
	gap: var(--space-2);
	inline-size: min(19rem, calc(100vw - 1rem));
	padding: var(--space-3);

	button,
	label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-block-size: 44px;
		padding: var(--space-2);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;

		&:hover { background: var(--surface-hover); }
		&:focus-visible { @include focus-ring; }
		&[aria-disabled='true'] {
			opacity: .5;
			cursor: default;
		}
	}

	p {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		overflow-wrap: anywhere;
	}
}
</style>
