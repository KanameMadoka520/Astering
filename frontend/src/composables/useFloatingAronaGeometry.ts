import {computed, onBeforeUnmount, onMounted, ref, watch, type CSSProperties, type Ref} from 'vue'
import {useVisualViewport, type VisualViewportBounds} from '@/composables/useVisualViewport'

export type PanelGeometry = {
	x: number
	y: number
	width: number
	height: number
}

export type PanelViewport = VisualViewportBounds

export type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
type Operation = 'move' | ResizeEdge

const STORAGE_KEY = 'astering-floating-arona-layout:v1'
const MARGIN = 12
const MIN_WIDTH = 360
const MIN_HEIGHT = 320

function limits(viewport: PanelViewport) {
	const left = viewport.left + MARGIN
	const top = Math.max(64, viewport.top + MARGIN)
	return {
		left,
		top,
		right: Math.max(left + 1, viewport.left + viewport.width - MARGIN),
		bottom: Math.max(top + 1, viewport.top + viewport.height - MARGIN),
	}
}

export function clampPanelGeometry(value: PanelGeometry, viewport: PanelViewport): PanelGeometry {
	const bounds = limits(viewport)
	const width = Math.min(bounds.right - bounds.left, Math.max(MIN_WIDTH, value.width))
	const height = Math.min(bounds.bottom - bounds.top, Math.max(MIN_HEIGHT, value.height))
	return {
		x: Math.max(bounds.left, Math.min(value.x, bounds.right - width)),
		y: Math.max(bounds.top, Math.min(value.y, bounds.bottom - height)),
		width,
		height,
	}
}

export function defaultPanelGeometry(viewport: PanelViewport): PanelGeometry {
	return clampPanelGeometry({
		x: viewport.left + viewport.width - 476,
		y: viewport.top + viewport.height - 796,
		width: 460,
		height: Math.min(720, viewport.height - 140),
	}, viewport)
}

export function changePanelGeometry(
	start: PanelGeometry,
	operation: Operation,
	dx: number,
	dy: number,
	viewport: PanelViewport,
): PanelGeometry {
	if (operation === 'move') {
		return clampPanelGeometry({
			...start,
			x: start.x + dx,
			y: start.y + dy,
		}, viewport)
	}
	const bounds = limits(viewport)
	const minWidth = Math.min(MIN_WIDTH, bounds.right - bounds.left)
	const minHeight = Math.min(MIN_HEIGHT, bounds.bottom - bounds.top)
	let left = start.x
	let top = start.y
	let right = start.x + start.width
	let bottom = start.y + start.height
	if (operation.includes('w')) left = Math.max(bounds.left, Math.min(start.x + dx, right - minWidth))
	if (operation.includes('e')) right = Math.min(bounds.right, Math.max(right + dx, left + minWidth))
	if (operation.includes('n')) top = Math.max(bounds.top, Math.min(start.y + dy, bottom - minHeight))
	if (operation.includes('s')) bottom = Math.min(bounds.bottom, Math.max(bottom + dy, top + minHeight))
	return clampPanelGeometry({
		x: left,
		y: top,
		width: right - left,
		height: bottom - top,
	}, viewport)
}

function parseGeometry(raw: string | null): PanelGeometry | null {
	try {
		const value = JSON.parse(raw ?? 'null')
		if (!value || !['x', 'y', 'width', 'height'].every(key =>
			typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) < 100000,
		)) return null
		return {
			x: value.x,
			y: value.y,
			width: value.width,
			height: value.height,
		}
	} catch {
		return null
	}
}

export function useFloatingAronaGeometry(isMobile: Ref<boolean>) {
	const {viewport, style: viewportStyle} = useVisualViewport()
	const preferred = ref<PanelGeometry | null>(null)
	const interacting = ref(false)
	const geometry = computed(() => preferred.value
		? clampPanelGeometry(preferred.value, viewport.value)
		: defaultPanelGeometry(viewport.value))
	const style = computed<CSSProperties | undefined>(() => isMobile.value ? undefined : {
		position: 'fixed',
		left: `${geometry.value.x}px`,
		top: `${geometry.value.y}px`,
		width: `${geometry.value.width}px`,
		height: `${geometry.value.height}px`,
	})
	type Gesture = {
		id: number
		operation: Operation
		start: PanelGeometry
		previous: PanelGeometry | null
		x: number
		y: number
		target: HTMLElement
	}
	let gesture: Gesture | undefined
	let pending: PanelGeometry | undefined
	let frame: number | undefined

	function persist() {
		try {
			if (preferred.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(preferred.value))
			else localStorage.removeItem(STORAGE_KEY)
		} catch { /* Geometry preferences are optional and contain no conversation data. */ }
	}
	function flush() {
		if (frame !== undefined) window.cancelAnimationFrame(frame)
		frame = undefined
		if (pending) preferred.value = pending
		pending = undefined
	}
	function stop(cancel = false) {
		if (!gesture) return
		const current = gesture
		gesture = undefined
		flush()
		if (cancel) preferred.value = current.previous
		interacting.value = false
		window.removeEventListener('pointermove', move)
		window.removeEventListener('pointerup', finish)
		window.removeEventListener('pointercancel', cancelPointer)
		window.removeEventListener('blur', cancelGesture)
		current.target.removeEventListener('lostpointercapture', cancelPointer)
		try { current.target.releasePointerCapture(current.id) } catch { /* Pointer capture may already be released. */ }
		if (!cancel) persist()
	}
	function move(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.id) return
		pending = changePanelGeometry(
			gesture.start,
			gesture.operation,
			event.clientX - gesture.x,
			event.clientY - gesture.y,
			viewport.value,
		)
		frame ??= window.requestAnimationFrame(flush)
	}
	function finish(event: PointerEvent) {
		if (event.pointerId !== gesture?.id) return
		move(event)
		stop()
	}
	function cancelPointer(event: PointerEvent) {
		if (event.pointerId === gesture?.id) stop(true)
	}
	function cancelGesture() { stop(true) }
	function start(event: PointerEvent, operation: Operation) {
		if (isMobile.value || gesture || event.button !== 0 || event.isPrimary === false) return
		const target = event.currentTarget
		if (!(target instanceof HTMLElement)) return
		event.preventDefault()
		event.stopPropagation()
		gesture = {
			id: event.pointerId,
			operation,
			start: {...geometry.value},
			previous: preferred.value ? {...preferred.value} : null,
			x: event.clientX,
			y: event.clientY,
			target,
		}
		interacting.value = true
		target.focus({preventScroll: true})
		try { target.setPointerCapture(event.pointerId) } catch { /* Window listeners also cover browsers without capture. */ }
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', finish)
		window.addEventListener('pointercancel', cancelPointer)
		window.addEventListener('blur', cancelGesture)
		target.addEventListener('lostpointercapture', cancelPointer)
	}
	function reset() {
		stop(true)
		preferred.value = null
		persist()
	}
	function keyboard(event: KeyboardEvent, operation: Operation) {
		if (isMobile.value || event.ctrlKey || event.metaKey || event.altKey) return
		const step = event.shiftKey ? 32 : 8
		const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
		const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
		if (!dx && !dy) return
		event.preventDefault()
		event.stopPropagation()
		preferred.value = changePanelGeometry(geometry.value, operation, dx, dy, viewport.value)
		persist()
	}
	function escape(event: KeyboardEvent) {
		if (!gesture) return false
		event.preventDefault()
		event.stopPropagation()
		stop(true)
		return true
	}
	watch(viewport, () => stop(true), {flush: 'sync'})
	function changedStorage(event: StorageEvent) {
		if (event.key !== STORAGE_KEY && event.key !== null) return
		stop(true)
		preferred.value = parseGeometry(event.newValue)
	}
	onMounted(() => {
		try { preferred.value = parseGeometry(localStorage.getItem(STORAGE_KEY)) } catch { /* Optional browser storage. */ }
		window.addEventListener('storage', changedStorage)
	})
	onBeforeUnmount(() => {
		stop(true)
		window.removeEventListener('storage', changedStorage)
	})
	return {
		style,
		viewportStyle,
		interacting,
		start,
		keyboard,
		escape,
		reset,
		cancel: cancelGesture,
	}
}
