import {inject} from 'vue'
import {routerKey} from 'vue-router'
import {AUTH_ROUTE_NAMES} from '@/constants/authRouteNames'
import {taskModalNavigationState} from '@/helpers/taskModal'

// Delegate inside the rendered content: the floating panel stops clicks before they reach document.
// All links keep real hrefs and native new-tab behaviour; ordinary app links use the existing router.
export function useAronaLinks() {
	const router = inject(routerKey, null)
	return (event: MouseEvent) => {
		if (!router || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement
		const anchor = target?.closest('a[href], a[xlink\\:href], area[href]')
		if (!anchor || anchor.hasAttribute('download')) return
		if (!(event.currentTarget instanceof Element) || !event.currentTarget.contains(anchor)) return

		let url: URL
		try {
			url = new URL(anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '', document.baseURI)
		} catch {
			return
		}
		if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return
		const base = router.options.history.base.replace(/\/$/, '')
		if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return
		const path = (url.pathname.slice(base.length) || '/') + url.search + url.hash
		const to = router.resolve(path)
		// API/files/unknown paths, public pages and authentication leave the app shell. Open those
		// separately so a visible floating conversation is never destroyed by such a navigation.
		if (!to.matched.length || typeof to.name !== 'string' || ['not-found', 'bad-not-found', 'tcy-public'].includes(to.name) || AUTH_ROUTE_NAMES.has(to.name)) return
		event.preventDefault()
		void router.push({
			path: to.path,
			query: to.query,
			hash: to.hash,
			state: to.name === 'task.detail' ? taskModalNavigationState(router.currentRoute.value) : undefined,
		}).catch(async cause => {
			const {error} = await import('@/message')
			error(cause)
		})
	}
}
