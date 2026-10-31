<template>
	<div class="compass-focus">
		<div
			ref="frame"
			class="compass-focus__frame"
			:class="{'is-dragging': dragging}"
			role="group"
			tabindex="0"
			:aria-label="t('compass.background.focusLabel', {x: focusX, y: focusY})"
			:aria-describedby="hintId"
			@pointerdown="onPointerDown"
			@pointermove="onPointerMove"
			@pointerup="onPointerUp"
			@pointercancel="onPointerUp"
			@keydown="onKeydown"
		>
			<!-- Shrinks to the picture, so the mark's percentages are the picture's. -->
			<span class="compass-focus__canvas">
				<img
					ref="image"
					class="compass-focus__image"
					:src="url"
					alt=""
					draggable="false"
				>
				<span
					class="compass-focus__mark"
					:style="{left: `${focusX}%`, top: `${focusY}%`}"
					aria-hidden="true"
				/>
			</span>
		</div>
		<p
			:id="hintId"
			class="compass-focus__hint"
		>
			{{ t('compass.background.focusHint') }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {ref, useId, useTemplateRef} from 'vue'
import {useI18n} from 'vue-i18n'

const props = defineProps<{
	// A blob: url owned by the parent.
	url: string
	focusX: number
	focusY: number
}>()

const emit = defineEmits<{
	change: [focus: {x: number, y: number}]
}>()

const {t} = useI18n({useScope: 'global'})
const hintId = useId()
const frame = useTemplateRef<HTMLElement>('frame')
const image = useTemplateRef<HTMLImageElement>('image')
const dragging = ref(false)

const STEP = 5

function clamp(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)))
}

function pointAt(event: PointerEvent) {
	const rect = image.value?.getBoundingClientRect()
	if (!rect || rect.width === 0 || rect.height === 0) return
	emit('change', {
		x: clamp((event.clientX - rect.left) / rect.width * 100),
		y: clamp((event.clientY - rect.top) / rect.height * 100),
	})
}

function onPointerDown(event: PointerEvent) {
	if (event.button !== 0) return
	dragging.value = true
	frame.value?.setPointerCapture(event.pointerId)
	pointAt(event)
}

function onPointerMove(event: PointerEvent) {
	if (dragging.value) pointAt(event)
}

function onPointerUp(event: PointerEvent) {
	if (!dragging.value) return
	dragging.value = false
	frame.value?.releasePointerCapture(event.pointerId)
}

function onKeydown(event: KeyboardEvent) {
	const moves: Record<string, [number, number]> = {
		ArrowLeft: [-STEP, 0],
		ArrowRight: [STEP, 0],
		ArrowUp: [0, -STEP],
		ArrowDown: [0, STEP],
	}
	if (event.key === 'Home' || event.key === 'Enter') {
		event.preventDefault()
		if (event.key === 'Home') emit('change', {x: 50, y: 50})
		return
	}
	const move = moves[event.key]
	if (!move) return
	event.preventDefault()
	// The picture is not mirrored in right-to-left layouts, so neither are the arrows.
	emit('change', {
		x: clamp(props.focusX + move[0]),
		y: clamp(props.focusY + move[1]),
	})
}
</script>

<style lang="scss" scoped>
.compass-focus {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
}

// The whole picture, uncropped, with the point that stays visible when the band crops it.
.compass-focus__frame {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--space-2);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	cursor: crosshair;
	touch-action: none;
	user-select: none;

	&:focus-visible {
		@include focus-ring;
	}

	&.is-dragging {
		cursor: grabbing;
	}
}

.compass-focus__canvas {
	position: relative;
	display: inline-block;
	max-inline-size: 100%;
	line-height: 0;
}

.compass-focus__image {
	display: block;
	max-inline-size: 100%;
	max-block-size: 16rem;
	border-radius: var(--radius-sm);
	pointer-events: none;
}

.compass-focus__mark {
	position: absolute;
	inline-size: 1.5rem;
	block-size: 1.5rem;
	border: 2px solid #ffffff;
	border-radius: 50%;
	box-shadow: 0 0 0 2px rgba(0, 0, 0, .55), inset 0 0 0 2px rgba(0, 0, 0, .35);
	transform: translate(-50%, -50%);
	pointer-events: none;

	&::after {
		position: absolute;
		inset: 50% auto auto 50%;
		inline-size: 4px;
		block-size: 4px;
		border-radius: 50%;
		background: #ffffff;
		content: '';
		transform: translate(-50%, -50%);
	}
}

.compass-focus__hint {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}
</style>
