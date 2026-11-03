export type Page<T> = {items?: T[] | null, total_pages?: number}

type PageOptions = {
	signal?: AbortSignal
	// Opt in per query: existing callers retain their retry policy unchanged.
	retryPage?: (failureCount: number, cause: unknown) => boolean
}

async function retryDelay(signal?: AbortSignal) {
	signal?.throwIfAborted()
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer)
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', abort)
			resolve()
		}, 1000)
		signal?.addEventListener('abort', abort, {once: true})
	})
}

async function readPage<T>(fetchPage: (page: number) => Promise<Page<T>>, page: number, options: PageOptions) {
	for (let failures = 0; ; failures++) {
		options.signal?.throwIfAborted()
		try {
			return await fetchPage(page)
		} catch (cause) {
			options.signal?.throwIfAborted()
			if (failures >= 1 || !options.retryPage?.(failures, cause)) throw cause
			await retryDelay(options.signal)
		}
	}
}

export async function fetchAllPages<T>(fetchPage: (page: number) => Promise<Page<T>>, options: PageOptions = {}): Promise<T[]> {
	const items: T[] = []
	for (let page = 1; ; page++) {
		const data = await readPage(fetchPage, page, options)
		options.signal?.throwIfAborted()
		items.push(...(data.items ?? []))
		if (page >= (data.total_pages ?? 1)) return items
	}
}
