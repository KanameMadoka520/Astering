import {VERSION} from './version.json'
import {getFullBaseUrl} from './helpers/getFullBaseUrl'
import {cacheNames, clientsClaim} from 'workbox-core'
import {cleanupOutdatedCaches} from 'workbox-precaching'
import {registerRoute} from 'workbox-routing'
import {CacheFirst, NetworkOnly} from 'workbox-strategies'
import {cacheableStaticResponse, staticAssetAllowlist, staticAssetCacheNames} from './helpers/staticAssetCache'

declare let self: ServiceWorkerGlobalScope

const fullBaseUrl = getFullBaseUrl()

// Route live documents and API responses before static matching; their HTTP headers control revalidation.
registerRoute(
	({request}) => request.mode === 'navigate',
	new NetworkOnly({
		fetchOptions: {
			cache: 'default',
		},
	}),
)

// Construct pattern with full base URL
const apiRoutePattern = new RegExp(`${fullBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}api\\/v[12]\\/.*$`)
registerRoute(
	apiRoutePattern,
	new NetworkOnly({
		fetchOptions: {
			cache: 'default',
		},
	}),
)

// The build manifest is an allowlist, not an install-time download queue.
const staticAssets = staticAssetAllowlist(self.__WB_MANIFEST, self.registration.scope)
const staticCaches = staticAssetCacheNames(self.registration.scope, VERSION)
registerRoute(
	({url, request}) => staticAssets.has(url.href)
		&& !request.headers.has('authorization') && !request.headers.has('range'),
	new CacheFirst({
		cacheName: staticCaches.current,
		fetchOptions: {cache: 'default'},
		plugins: [{
			cacheWillUpdate: async ({request, response}) => cacheableStaticResponse(request, response) ? response : null,
		}],
	}),
)
cleanupOutdatedCaches()

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		const names = await caches.keys()
		await Promise.all(names.filter(name => name === cacheNames.precache || name === cacheNames.runtime
			|| (name.startsWith(staticCaches.prefix) && name !== staticCaches.current))
			.map(name => caches.delete(name)))
	})())
})

// This code listens for the user's confirmation to update the app.
self.addEventListener('message', (e) => {
	if (!e.data) {
		return
	}

	switch (e.data) {
		case 'getVersion':
			e.ports[0]?.postMessage({version: VERSION})
			break
		case 'skipWaiting':
			self.skipWaiting()
			break
		default:
			// NOOP
			break
	}
})

// Notification action
self.addEventListener('notificationclick', function (event) {
	const taskId = event.notification.data.taskId
	event.notification.close()

	switch (event.action) {
		case 'show-task':
			self.clients.openWindow(`${fullBaseUrl}tasks/${taskId}`)
			break
	}
})

clientsClaim()

