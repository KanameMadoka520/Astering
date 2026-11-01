import {inject, onBeforeUnmount, onMounted, provide, readonly, ref, type InjectionKey, type Ref} from 'vue'

/** How far outside the scroll area an element counts as near: one and a half heights above and below. */
export const NEAR_VIEWPORT_MARGIN = '150% 0px'

type Root = Element | null
type Shared = {
	observer: IntersectionObserver
	callbacks: Map<Element, Set<() => void>>
}

// One observer per scroll root and margin, however many images a page shows.
const shared = new Map<Root, Map<string, Shared>>()

function observe(element: Element, root: Root, margin: string, near: () => void) {
	let byMargin = shared.get(root)
	if (!byMargin) {
		byMargin = new Map()
		shared.set(root, byMargin)
	}
	let entry = byMargin.get(margin)
	if (!entry) {
		const callbacks = new Map<Element, Set<() => void>>()
		const observer = new IntersectionObserver(records => {
			for (const record of records) {
				if (record.isIntersecting) callbacks.get(record.target)?.forEach(callback => callback())
			}
		}, {root, rootMargin: margin})
		entry = {observer, callbacks}
		byMargin.set(margin, entry)
	}
	const current = entry
	const forElement = current.callbacks.get(element) ?? new Set()
	forElement.add(near)
	current.callbacks.set(element, forElement)
	current.observer.observe(element)
	let active = true
	return () => {
		if (!active) return
		active = false
		forElement.delete(near)
		if (forElement.size || current.callbacks.get(element) !== forElement) return
		current.callbacks.delete(element)
		current.observer.unobserve(element)
		if (current.callbacks.size) return
		current.observer.disconnect()
		if (byMargin.get(margin) === current) byMargin.delete(margin)
		if (!byMargin.size && shared.get(root) === byMargin) shared.delete(root)
	}
}

/**
 * Calls `near` once, the first time `element` comes near the visible part of `root` (the page when null). For DOM
 * that Vue does not own, such as v-html bodies and editor node views. Returns a function that stops waiting.
 */
export function whenNearViewport(
	element: Element,
	near: () => void,
	{root = null, margin = NEAR_VIEWPORT_MARGIN}: {root?: Root | undefined, margin?: string} = {},
): () => void {
	if (typeof IntersectionObserver === 'undefined') {
		let cancelled = false
		queueMicrotask(() => {
			if (!cancelled) near()
		})
		return () => {
			cancelled = true
		}
	}
	const stop = observe(element, root ?? null, margin, () => {
		stop()
		near()
	})
	return stop
}

const SCROLL_ROOT: InjectionKey<() => Element | null | undefined> = Symbol('near-viewport-root')

/**
 * For content inside its own scroll area (the assistant's thread): a margin around the page viewport does not reach
 * past the area's edges, so near-viewport checks measure against this element instead.
 */
export function provideNearViewportRoot(root: () => Element | null | undefined) {
	provide(SCROLL_ROOT, root)
}

/** The scroll area a parent provided, for whenNearViewport; call during setup. */
export function useNearViewportRoot() {
	return inject(SCROLL_ROOT, () => null)
}

/**
 * Turns true once `target` comes near the visible part of its scroll area, and stays true: data fetched for it then
 * stays loaded however the user scrolls. Without IntersectionObserver it is true at once.
 */
export function useNearViewport(target: Readonly<Ref<Element | null | undefined>>, margin = NEAR_VIEWPORT_MARGIN) {
	const near = ref(typeof IntersectionObserver === 'undefined')
	const root = useNearViewportRoot()
	let stop: (() => void) | undefined
	function release() {
		stop?.()
		stop = undefined
	}
	onMounted(() => {
		const element = target.value
		if (near.value || !element) {
			near.value = true
			return
		}
		stop = observe(element, root() ?? null, margin, () => {
			near.value = true
			release()
		})
	})
	onBeforeUnmount(release)
	return readonly(near)
}
