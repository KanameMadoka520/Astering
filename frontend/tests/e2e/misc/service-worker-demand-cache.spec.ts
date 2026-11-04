import {createServer} from 'node:http'
import {readFile, readdir} from 'node:fs/promises'
import {resolve} from 'node:path'
import type {AddressInfo} from 'node:net'

import {test, expect} from '../../support/fixtures'
import {apiRootUrl} from '../../support/apiUrl'

// Chromium cache evidence is invalid when request interception is enabled.
test.use({serviceWorkers: 'allow'})

test('real built worker installs without prefetch and caches only requested public build assets', async ({
	page,
	apiContext,
	userToken,
}, testInfo) => {
	test.setTimeout(90_000)
	const api = new URL(apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456'))
	expect(['127.0.0.1', 'localhost', '[::1]']).toContain(api.hostname)
	const image = await readFile(new URL('../../fixtures/image-blue.png', import.meta.url))
	const upload = await apiContext.post(`${api.origin}/api/v2/drive/files`, {
		headers: {Authorization: `Bearer ${userToken}`},
		multipart: {file: {
			name: 'sw-private-fixture.png',
			mimeType: 'image/png',
			buffer: image,
		}},
	})
	expect(upload.ok()).toBe(true)
	const {file_id: fileId} = await upload.json() as {file_id: number}
	const previewPath = `/api/v2/drive/files/${fileId}/preview`
	const dist = resolve(process.cwd(), 'dist-dev')
	const worker = await readFile(resolve(dist, 'sw.js'))
	const {VERSION: buildVersion} = JSON.parse(await readFile(resolve(process.cwd(), 'src/version.json'), 'utf8')) as {VERSION: string}
	const files = await readdir(resolve(dist, 'assets'))
	const asset = files.find(name => /-[\w-]{8,}\.js$/.test(name) && worker.includes(name))
	expect(asset).toBeDefined()
	const assetPath = `/assets/${asset!}`
	const assetBytes = await readFile(resolve(dist, 'assets', asset!))
	const requests: string[] = []
	const failures: string[] = []
	// Vite preview does not emit Go's immutable headers. This loopback-only fixture serves
	// the real built worker/asset with that policy and proxies real isolated API reads.
	const server = createServer((request, response) => {
		void (async () => {
			const path = new URL(request.url ?? '/', 'http://localhost').pathname
			requests.push(path)
			if (request.method !== 'GET') {
				response.writeHead(405).end()
				return
			}
			if (path === '/api/v2/user' || path === previewPath) {
				const upstream = await fetch(new URL(path, api), {
					headers: {Authorization: request.headers.authorization ?? ''},
					signal: AbortSignal.timeout(10_000),
				})
				response.writeHead(upstream.status, {
					'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
					'Cache-Control': upstream.headers.get('cache-control') ?? 'no-store',
					Vary: upstream.headers.get('vary') ?? 'Authorization',
				})
				response.end(Buffer.from(await upstream.arrayBuffer()))
				return
			}
			if (path === '/' || path === '/index.html') {
				response.writeHead(200, {
					'Content-Type': 'text/html',
					'Cache-Control': 'no-cache',
				}).end('<!doctype html><title>Isolated worker cache fixture</title>')
				return
			}
			if (path === '/sw.js' || path === assetPath) {
				response.writeHead(200, {
					'Content-Type': 'text/javascript; charset=utf-8',
					'Cache-Control': path === '/sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable',
				}).end(path === '/sw.js' ? worker : assetBytes)
				return
			}
			response.writeHead(404, {'Cache-Control': 'no-store'}).end()
		})().catch(() => {
			failures.push('fixture read failed')
			if (!response.headersSent) response.writeHead(502)
			response.end()
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const currentCache = `astering-static:${encodeURIComponent(`${origin}/`)}:${encodeURIComponent(buildVersion)}`
	const legacyCache = `vikunja-x-static:${encodeURIComponent(`${origin}/`)}:v2.7.1-tcymc.49`
	const preservedCaches = [
		'other-app-sentinel',
		`vikunja-x-static:${encodeURIComponent(`${origin}/other/`)}:v2.7.1-tcymc.49`,
		`astering-static:${encodeURIComponent(`${origin}/other/`)}:previous`,
	]
	async function cachedUrls() {
		return page.evaluate(async () => {
			const snapshots = await Promise.all((await caches.keys()).map(async name => ({
				name,
				urls: (await (await caches.open(name)).keys()).map(request => request.url),
			})))
			return snapshots
		})
	}
	try {
		await page.goto(origin)
		await page.evaluate(async names => {
			for (const name of names) {
				await (await caches.open(name)).put('/cache-sentinel', new Response('isolated fixture'))
			}
		}, [legacyCache, ...preservedCaches])
		await page.evaluate(async () => {
			await navigator.serviceWorker.register('/sw.js')
			await navigator.serviceWorker.ready
		})
		await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated')
		expect(requests.filter(path => path.startsWith('/assets/'))).toEqual([])
		expect((await cachedUrls()).map(cache => cache.name).sort()).toEqual([...preservedCaches].sort())

		const version = await page.evaluate(() => new Promise<string>((resolve, reject) => {
			const channel = new MessageChannel()
			const timer = setTimeout(() => {
				channel.port1.close()
				reject(new Error('Worker version message timed out'))
			}, 5000)
			channel.port1.onmessage = event => {
				clearTimeout(timer)
				channel.port1.close()
				resolve(event.data.version)
			}
			navigator.serviceWorker.controller!.postMessage('getVersion', [channel.port2])
		}))
		expect(version).toBe(buildVersion)
		await page.evaluate(async path => {
			const response = await fetch(path)
			if (!response.ok) throw new Error('Build asset failed')
			await response.arrayBuffer()
		}, assetPath)
		await expect.poll(async () => (await cachedUrls()).filter(cache => cache.name === currentCache)
			.flatMap(cache => cache.urls)).toEqual([`${origin}${assetPath}`])
		const secondResponse = page.waitForResponse(response => response.url() === `${origin}${assetPath}`)
		await page.evaluate(async path => { await (await fetch(path)).arrayBuffer() }, assetPath)
		expect((await secondResponse).fromServiceWorker()).toBe(true)
		expect(requests.filter(path => path === assetPath)).toHaveLength(1)

		const reads = await page.evaluate(async ({token, previewPath}) => {
			const result = []
			for (const path of ['/api/v2/user', previewPath, '/index.html']) {
				const response = await fetch(path, {headers: {Authorization: `Bearer ${token}`}})
				await response.arrayBuffer()
				result.push({
					path,
					status: response.status,
					policy: response.headers.get('cache-control'),
				})
			}
			return result
		}, {
			token: userToken,
			previewPath,
		})
		expect(reads.map(read => read.status)).toEqual([200, 200, 200])
		expect(reads[0].policy).toContain('no-store')
		expect(reads[1].policy).toContain('private')
		expect(reads[2].policy).toBe('no-cache')
		const snapshots = await cachedUrls()
		expect(snapshots.map(cache => cache.name).sort()).toEqual([currentCache, ...preservedCaches].sort())
		expect(snapshots.find(cache => cache.name === currentCache)?.urls).toEqual([`${origin}${assetPath}`])
		expect(failures).toEqual([])
		await testInfo.attach('worker-cache-evidence', {
			body: JSON.stringify({version, requests, snapshots, reads}, null, 2),
			contentType: 'application/json',
		})
	} finally {
		await page.goto('about:blank')
		server.closeAllConnections()
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
	}
})
