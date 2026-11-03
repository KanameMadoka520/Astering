import {describe, expect, it} from 'vitest'
import {cacheableStaticResponse, staticAssetAllowlist, staticAssetCacheNames} from './staticAssetCache'

const scope = 'https://task.example/workspace/'
const asset = 'assets/app-abcdefgh.js'

describe('static asset cache policy', () => {
	it('requires a build-listed, scoped, hash-named static resource', () => {
		const entries = [
			asset,
			'assets/font-abcdefgh.woff2',
			'assets/image-abcdefgh.webp',
			'favicon.png',
			'assets/unhashed.js',
			'assets/private-abcdefgh.json',
			'assets/page-abcdefgh.html',
			'assets/private-abcdefgh.enc',
			'assets/private-abcdefgh.js?token=example',
			'assets/private-abcdefgh.js#fragment',
			'api/v2/assets/private-abcdefgh.png',
			'api/v1/assets/private-abcdefgh.png',
			'files/assets/private-abcdefgh.png',
			'../assets/other-abcdefgh.js',
			'/workspace-other/assets/other-abcdefgh.js',
			'https://external.example/workspace/assets/other-abcdefgh.js',
			'https://user@task.example/workspace/assets/other-abcdefgh.js',
			'http://task.example/workspace/assets/other-abcdefgh.js',
			'https://task.example:123/workspace/assets/other-abcdefgh.js',
			'http://[',
			'sw.js',
			'registerSW.js',
			'manifest.webmanifest',
			'config.json',
			'index.html',
		]
		expect([...staticAssetAllowlist(entries, scope)]).toEqual([
			`${scope}${asset}`,
			`${scope}assets/font-abcdefgh.woff2`,
			`${scope}assets/image-abcdefgh.webp`,
		])
	})

	it('uses response type and explicit public immutable policy, not the filename alone', () => {
		const request = new Request(`${scope}${asset}`)
		const response = (type: string, policy: string, status = 200) => new Response('', {
			status,
			headers: {
				'Content-Type': type,
				'Cache-Control': policy,
			},
		})
		expect(cacheableStaticResponse(request, response('text/javascript; charset=utf-8', 'public, immutable'))).toBe(true)
		for (const policy of ['', 'no-cache', 'public', 'private, immutable', 'public, immutable, private="Cookie"']) {
			expect(cacheableStaticResponse(request, response('text/javascript', policy))).toBe(false)
		}
		expect(cacheableStaticResponse(request, response('text/html', 'public, immutable'))).toBe(false)
		expect(cacheableStaticResponse(request, response('text/javascript', 'public, immutable', 404))).toBe(false)
		expect(cacheableStaticResponse(new Request(request, {headers: {Authorization: 'Bearer synthetic'}}),
			response('text/javascript', 'public, immutable'))).toBe(false)
		expect(cacheableStaticResponse(new Request(request, {headers: {Range: 'bytes=0-10'}}),
			response('text/javascript', 'public, immutable'))).toBe(false)
		const redirected = response('text/javascript', 'public, immutable')
		Object.defineProperty(redirected, 'redirected', {value: true})
		expect(cacheableStaticResponse(request, redirected)).toBe(false)
	})

	it('isolates cache ownership between versions, origins and application scopes', () => {
		const current = staticAssetCacheNames(scope, 'current')
		expect(staticAssetCacheNames(scope, 'previous').current.startsWith(current.prefix)).toBe(true)
		expect(staticAssetCacheNames(`${scope}nested/`, 'current').current.startsWith(current.prefix)).toBe(false)
		expect(staticAssetCacheNames('https://other.example/workspace/', 'current').current.startsWith(current.prefix)).toBe(false)
		expect(current.current).not.toBe(staticAssetCacheNames(scope, 'previous').current)
	})
})
