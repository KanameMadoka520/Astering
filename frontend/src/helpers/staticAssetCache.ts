type ManifestEntry = string | {
	url: string
	revision?: string | null
}

const contentTypes: Record<string, readonly string[]> = {
	js: ['application/javascript', 'text/javascript'],
	mjs: ['application/javascript', 'text/javascript'],
	css: ['text/css'],
	woff: ['font/woff', 'application/font-woff'],
	woff2: ['font/woff2'],
	ttf: ['font/ttf', 'application/x-font-ttf'],
	otf: ['font/otf', 'application/x-font-opentype'],
	png: ['image/png'],
	jpg: ['image/jpeg'],
	jpeg: ['image/jpeg'],
	gif: ['image/gif'],
	webp: ['image/webp'],
	avif: ['image/avif'],
	svg: ['image/svg+xml'],
	ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
}

export function staticAssetAllowlist(entries: readonly ManifestEntry[], scope: string): Set<string> {
	const base = new URL(scope)
	const urls = new Set<string>()
	for (const entry of entries) {
		let url: URL
		try {
			url = new URL(typeof entry === 'string' ? entry : entry.url, base)
		} catch {
			continue
		}
		const relative = url.pathname.slice(base.pathname.length)
		const match = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.([A-Za-z0-9]+)$/.exec(relative)
		if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
			|| url.username || url.password || url.search || url.hash
			|| !match || !Object.hasOwn(contentTypes, match[1].toLowerCase())) continue
		urls.add(url.href)
	}
	return urls
}

export function cacheableStaticResponse(request: Request, response: Response): boolean {
	if (response.status !== 200 || response.redirected || request.headers.has('authorization')
		|| request.headers.has('range')) return false
	const directives = (response.headers.get('cache-control') ?? '').toLowerCase().split(',').map(value => value.trim())
	if (!directives.includes('public') || !directives.includes('immutable')
		|| directives.some(value => /^(?:private|no-store|no-cache)(?:=|$)/.test(value))) return false
	const extension = new URL(request.url).pathname.split('.').pop()?.toLowerCase() ?? ''
	const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
	return Object.hasOwn(contentTypes, extension) && contentTypes[extension].includes(type)
}

export function staticAssetCacheNames(scope: string, version: string) {
	const prefix = `vikunja-x-static:${encodeURIComponent(scope)}:`
	return {
		prefix,
		current: `${prefix}${encodeURIComponent(version)}`,
	}
}
