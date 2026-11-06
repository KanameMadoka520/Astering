import {getApiRootUrl} from '@/helpers/apiUrl'

function taskAttachmentImages(source: string, taskId: number) {
	if (!source || !source.includes('attachments/')) return undefined
	const document = new DOMParser().parseFromString(source, 'text/html')
	const base = new URL(getApiRootUrl() || '/', window.location.origin)
	const images = new Map<HTMLImageElement, number>()
	for (const image of document.querySelectorAll('img')) {
		try {
			const url = new URL(image.getAttribute('data-src') || image.getAttribute('src') || '', base)
			if (url.origin !== base.origin) continue
			const prefix = base.pathname.replace(/\/$/, '')
			const path = prefix && url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : url.pathname
			const match = /^(?:\/api\/v[12])?\/tasks\/(\d+)\/attachments\/(\d+)(?:\/preview)?\/?$/.exec(path)
			if (match && Number(match[1]) === taskId) images.set(image, Number(match[2]))
		} catch { /* External and malformed links are not attachment references. */ }
	}
	return {
		document,
		images,
	}
}

export function removeAttachmentImages(source: string, taskId: number, ids: readonly number[]): string {
	if (!ids.length) return source
	const content = taskAttachmentImages(source, taskId)
	if (!content) return source
	let changed = false
	for (const [image, id] of content.images) {
		if (ids.includes(id)) {image.remove(); changed = true}
	}
	return changed ? content.document.body.innerHTML : source
}

/** A description can lose an image while its underlying task attachment stays available. */
export function hasRemovedAttachmentImages(
	before: string,
	after: string,
	taskId: number,
	retainedIds: readonly number[],
): boolean {
	if (!retainedIds.length || before === after) return false
	const previous = taskAttachmentImages(before, taskId)
	if (!previous?.images.size) return false
	const retained = new Set(retainedIds)
	const previousCounts = new Map<number, number>()
	const currentCounts = new Map<number, number>()
	for (const id of previous.images.values()) previousCounts.set(id, (previousCounts.get(id) ?? 0) + 1)
	for (const id of taskAttachmentImages(after, taskId)?.images.values() ?? []) {
		currentCounts.set(id, (currentCounts.get(id) ?? 0) + 1)
	}
	return [...previousCounts].some(([id, count]) => retained.has(id) && (currentCounts.get(id) ?? 0) < count)
}
