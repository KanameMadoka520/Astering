import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {RouteHandler, RouteMatchCallback} from 'workbox-core/types'
import {staticAssetCacheNames} from './helpers/staticAssetCache'
import {VERSION} from './version.json'

const state = vi.hoisted(() => ({base: '/'}))
vi.mock('./helpers/getFullBaseUrl', () => ({getFullBaseUrl: () => state.base}))

class WorkerExtendableEvent extends Event {
	pending: Promise<unknown>[] = []
	waitUntil(promise: Promise<unknown>) {
		this.pending.push(promise)
	}
}

class WorkerFetchEvent extends WorkerExtendableEvent {
	response?: Promise<Response>
	constructor(public request: Request) {
		super('fetch')
	}
	respondWith(response: Promise<Response>) {
		if (this.response) throw new DOMException('Fetch already has a response', 'InvalidStateError')
		this.response = response
	}
}

const listeners = new Map<string, Array<(event: object) => void>>()
const network = vi.fn()
const deleteCache = vi.fn()
const skipWaiting = vi.fn()
const openWindow = vi.fn()
const cacheKeys = vi.fn()
const cache = {
	match: vi.fn(),
	keys: vi.fn(),
	delete: vi.fn(),
	put: vi.fn(),
}
const storage = {
	match: cache.match,
	open: vi.fn(),
	keys: cacheKeys,
	delete: deleteCache,
}

function fire(type: string, event: object) {
	for (const listener of listeners.get(type) ?? []) listener(event)
}

async function fetchResource(path: string, mode?: RequestMode) {
	const request = new Request(new URL(path, `https://task.example${state.base}`))
	if (mode) Object.defineProperty(request, 'mode', {value: mode})
	const event = new WorkerFetchEvent(request)
	fire('fetch', event)
	const response = await event.response
	await Promise.all(event.pending)
	return response
}

async function loadWorker(base = '/') {
	state.base = base
	const scope = `https://task.example${base}`
	const registration = {scope}
	const location = new URL('sw.js', scope)
	vi.stubGlobal('registration', registration)
	vi.stubGlobal('location', location)
	vi.stubGlobal('self', {
		location,
		registration,
		caches: storage,
		__WB_MANIFEST: [
			{url: 'assets/app-abcdefgh.js', revision: null},
			{url: 'index.html', revision: 'live'},
			{url: 'manifest.webmanifest', revision: 'live'},
			{url: 'config.json', revision: 'live'},
			{url: 'api/v2/private.json', revision: 'private'},
			{url: 'favicon.png', revision: 'fixed'},
			{url: 'api/v2/assets/private-abcdefgh.png', revision: null},
			{url: 'https://external.example/assets/private-abcdefgh.png', revision: null},
		],
		addEventListener: (type: string, listener: (event: object) => void) => {
			const registered = listeners.get(type) ?? []
			registered.push(listener)
			listeners.set(type, registered)
		},
		skipWaiting,
		clients: {
			openWindow,
			claim: vi.fn().mockResolvedValue(undefined),
		},
	})
	// Model the separate importScripts router so the old mixed implementation fails for two real listeners.
	const {Router, Route, RegExpRoute} = await import('workbox-routing')
	const {NetworkOnly, StaleWhileRevalidate} = await import('workbox-strategies')
	const {cacheNames, clientsClaim} = await import('workbox-core')
	const legacy = new Router()
	let attached = false
	vi.stubGlobal('workbox', {
		setConfig: vi.fn(),
		core: {cacheNames, clientsClaim},
		routing: {
			registerRoute(match: RegExp | RouteMatchCallback, handler: RouteHandler) {
				if (!attached) {
					attached = true
					legacy.addFetchListener()
				}
				legacy.registerRoute(match instanceof RegExp
					? new RegExpRoute(match, handler)
					: new Route(match, handler))
			},
		},
		strategies: {
			NetworkOnly,
			StaleWhileRevalidate,
		},
		precaching: {precacheAndRoute: vi.fn()},
	})
	await import('./sw')
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	listeners.clear()
	state.base = '/'
	network.mockImplementation(async () => new Response('network'))
	deleteCache.mockResolvedValue(true)
	cache.match.mockImplementation(async () => new Response('precached'))
	cache.keys.mockResolvedValue([])
	cache.put.mockResolvedValue(undefined)
	storage.open.mockResolvedValue(cache)
	cacheKeys.mockResolvedValue([])
	vi.stubGlobal('fetch', network)
	vi.stubGlobal('caches', storage)
	vi.stubGlobal('ExtendableEvent', WorkerExtendableEvent)
	vi.stubGlobal('FetchEvent', WorkerFetchEvent)
	vi.stubGlobal('__WORKBOX_VERSION__', 'test')
	vi.stubGlobal('importScripts', vi.fn())
})

afterEach(() => vi.unstubAllGlobals())

describe('service worker cache boundaries with the real Workbox router', () => {
	it('does not download any manifest resource during installation', async () => {
		await loadWorker()
		cache.match.mockResolvedValue(undefined)
		const event = new WorkerExtendableEvent('install')
		fire('install', event)
		await Promise.allSettled(event.pending)
		expect(network).not.toHaveBeenCalled()
		expect(storage.open).not.toHaveBeenCalled()
	})

	it('shares one fetch listener between network routes and on-demand assets', async () => {
		await loadWorker()
		expect(listeners.get('fetch')).toHaveLength(1)
		expect(importScripts).not.toHaveBeenCalled()
	})

	it.each(['/', '/workspace/'])('lets server headers control API caching under %s', async base => {
		await loadWorker(base)
		for (const path of ['api/v1/tasks/1/attachments/2', 'api/v2/compass/spaces/1/images/2']) {
			const response = await fetchResource(`${base}${path}`)
			expect(await response?.text()).toBe('network')
			expect(network).toHaveBeenLastCalledWith(expect.any(Request), {cache: 'default'})
		}
		expect(storage.open).not.toHaveBeenCalled()
	})

	it('routes live documents and APIs through the network while requested build assets use their static cache', async () => {
		await loadWorker()
		for (const path of ['/', '/index.html', '/projects/6/35']) {
			expect(await (await fetchResource(path, 'navigate'))?.text()).toBe('network')
		}
		expect(await (await fetchResource('/api/v2/private.json'))?.text()).toBe('network')
		network.mockClear()
		expect(await (await fetchResource('/assets/app-abcdefgh.js'))?.text()).toBe('precached')
		expect(network).not.toHaveBeenCalled()
	})

	it('never installs a precache even when the build plugin adds HTML, manifests or configuration', async () => {
		await loadWorker()
		const {getCacheKeyForURL} = await import('workbox-precaching')
		for (const path of ['index.html', 'manifest.webmanifest', 'config.json', 'api/v2/private.json']) {
			expect(getCacheKeyForURL(`https://task.example/${path}`)).toBeUndefined()
		}
		expect(getCacheKeyForURL('https://task.example/assets/app-abcdefgh.js')).toBeUndefined()
	})

	it('does not persist arbitrary same-origin or external extension-matched resources', async () => {
		await loadWorker()
		for (const path of [
			'/favicon.png',
			'/assets/app-abcdefgh.js?private=true',
			'/user-upload.png',
			'/private-report.json',
			'https://external.example/private.png',
			'https://external.example/private.svg',
		]) {
			expect(await fetchResource(path)).toBeUndefined()
		}
		expect(storage.open).not.toHaveBeenCalled()
	})

	it('cleans incompatible precaches and this app legacy runtime while leaving other caches intact', async () => {
		await loadWorker()
		const {cacheNames} = await import('workbox-core')
		const oldPrecache = 'workbox-precache-v1-https://task.example/'
		const current = staticAssetCacheNames('https://task.example/', VERSION).current
		const previous = staticAssetCacheNames('https://task.example/', 'previous').current
		const otherScope = staticAssetCacheNames('https://task.example/other/', 'previous').current
		const legacy = `vikunja-x-static:${encodeURIComponent('https://task.example/')}:v2.7.1-tcymc.49`
		const legacyOtherScope = `vikunja-x-static:${encodeURIComponent('https://task.example/other/')}:v2.7.1-tcymc.49`
		cacheKeys.mockResolvedValue([
			cacheNames.precache,
			cacheNames.runtime,
			oldPrecache,
			'other-app-cache',
			current,
			previous,
			otherScope,
			legacy,
			legacyOtherScope,
		])
		expect(deleteCache).not.toHaveBeenCalled()
		const event = new WorkerExtendableEvent('activate')
		fire('activate', event)
		await Promise.all(event.pending)
		expect(deleteCache.mock.calls.map(([name]) => name).sort()).toEqual([
			cacheNames.runtime,
			cacheNames.precache,
			oldPrecache,
			previous,
			legacy,
		].sort())
	})

	it('downloads and persists an allowed resource only when requested, then reuses it', async () => {
		await loadWorker('/workspace/')
		const stored = new Map<string, Response>()
		cache.match.mockImplementation(async (request: Request) => stored.get(request.url)?.clone())
		cache.put.mockImplementation(async (request: Request, response: Response) => {
			stored.set(request.url, response.clone())
		})
		network.mockImplementation(async () => new Response('actual-js', {headers: {
			'Content-Type': 'text/javascript',
			'Cache-Control': 'public, max-age=31536000, immutable',
		}}))
		const path = '/workspace/assets/app-abcdefgh.js'
		expect(await (await fetchResource(path))?.text()).toBe('actual-js')
		expect(network).toHaveBeenCalledOnce()
		expect(cache.put).toHaveBeenCalledOnce()
		expect(storage.open).toHaveBeenCalledWith(`astering-static:${encodeURIComponent('https://task.example/workspace/')}:${encodeURIComponent(VERSION)}`)
		expect([...stored.keys()]).toEqual([`https://task.example${path}`])
		expect(await (await fetchResource(path))?.text()).toBe('actual-js')
		expect(network).toHaveBeenCalledOnce()
	})

	it.each([
		['text/html', 'public, max-age=31536000, immutable'],
		['text/javascript', 'private, no-cache'],
		['text/javascript', 'public, immutable, no-store'],
	])('does not persist a fallback or sensitive response (%s, %s)', async (type, policy) => {
		await loadWorker()
		cache.match.mockResolvedValue(undefined)
		network.mockImplementation(async () => new Response('response', {headers: {
			'Content-Type': type,
			'Cache-Control': policy,
		}}))
		expect(await (await fetchResource('/assets/app-abcdefgh.js'))?.text()).toBe('response')
		expect(cache.put).not.toHaveBeenCalled()
	})

	it('keeps the version handshake and waits for explicit user confirmation to activate', async () => {
		await loadWorker()
		expect(skipWaiting).not.toHaveBeenCalled()
		const postMessage = vi.fn()
		fire('message', {
			data: 'getVersion',
			ports: [{postMessage}],
		})
		expect(postMessage).toHaveBeenCalledWith({version: expect.any(String)})
		expect(skipWaiting).not.toHaveBeenCalled()
		fire('message', {data: 'skipWaiting'})
		expect(skipWaiting).toHaveBeenCalledOnce()
	})

	it('preserves notification navigation under the configured base path', async () => {
		await loadWorker('/workspace/')
		const close = vi.fn()
		fire('notificationclick', {
			action: 'show-task',
			notification: {
				data: {taskId: 9},
				close,
			},
		})
		expect(close).toHaveBeenCalledOnce()
		expect(openWindow).toHaveBeenCalledExactlyOnceWith('/workspace/tasks/9')
	})
})
