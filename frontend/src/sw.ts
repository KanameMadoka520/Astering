import {VERSION} from './version.json'
import {getFullBaseUrl} from './helpers/getFullBaseUrl'
import {cacheNames, clientsClaim} from 'workbox-core'
import {cleanupOutdatedCaches, precacheAndRoute} from 'workbox-precaching'
import {registerRoute} from 'workbox-routing'
import {NetworkOnly} from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope

const fullBaseUrl = getFullBaseUrl()

// Route live documents and API responses before precaching; their HTTP headers control revalidation.
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

// The PWA plugin adds webmanifest after build transforms; filter live entries at the final injection boundary.
const staticManifest = self.__WB_MANIFEST.filter(entry => {
	const url = new URL(typeof entry === 'string' ? entry : entry.url, self.location.href)
	return url.origin === self.location.origin
		&& !url.pathname.endsWith('/')
		&& !/\.(?:html|webmanifest|json)$/i.test(url.pathname)
		&& !/\/api\/v[12](?:\/|$)/.test(url.pathname)
		&& !/(?:^|\/)(?:sw|registerSW)\.js$/i.test(url.pathname)
})
precacheAndRoute(staticManifest)
cleanupOutdatedCaches()

self.addEventListener('activate', event => {
	// The former extension-based route left arbitrary resources in this scope's default runtime cache.
	event.waitUntil(caches.delete(cacheNames.runtime))
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

