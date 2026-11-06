import {computed, onScopeDispose, readonly, shallowRef, type CSSProperties} from 'vue'
import {createSharedComposable} from '@vueuse/core'

export type VisualViewportBounds = {
	width: number
	height: number
	left: number
	top: number
}

function readViewport(): VisualViewportBounds {
	const view = window.visualViewport
	return {
		width: view?.width ?? window.innerWidth,
		height: view?.height ?? window.innerHeight,
		left: view?.offsetLeft ?? 0,
		top: view?.offsetTop ?? 0,
	}
}

// Android can resize only the visual viewport when the keyboard opens; dvh still includes the keyboard then.
export const useVisualViewport = createSharedComposable(() => {
	const viewport = shallowRef(readViewport())
	const visualViewport = window.visualViewport
	function update() {
		viewport.value = readViewport()
	}

	window.addEventListener('resize', update, {passive: true})
	visualViewport?.addEventListener('resize', update, {passive: true})
	visualViewport?.addEventListener('scroll', update, {passive: true})
	onScopeDispose(() => {
		window.removeEventListener('resize', update)
		visualViewport?.removeEventListener('resize', update)
		visualViewport?.removeEventListener('scroll', update)
	})

	const style = computed<CSSProperties>(() => ({
		'--visual-viewport-width': `${viewport.value.width}px`,
		'--visual-viewport-height': `${viewport.value.height}px`,
		'--visual-viewport-left': `${viewport.value.left}px`,
		'--visual-viewport-top': `${viewport.value.top}px`,
	}))
	return {
		viewport: readonly(viewport),
		style,
	}
})
