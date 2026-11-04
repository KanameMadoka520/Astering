import {readonly, shallowRef} from 'vue'
import type {QueryKey} from '@tanstack/vue-query'
import {AUTH_TYPES} from '@/constants/auth'
import {isClientRequestContextCurrent, type ClientRequestContext} from './requestContext'

export type NetworkResource =
	| 'projects' | 'project' | 'tasks' | 'projectTasks' | 'task' | 'board' | 'buckets' | 'calendar'
	| 'drive' | 'file' | 'image' | 'avatar' | 'background' | 'conversations' | 'conversation'
	| 'compass' | 'entries' | 'entry' | 'comments' | 'teams' | 'labels' | 'settings' | 'accounts' | 'page'

export type NetworkLabel = {
	resource: NetworkResource
	resourceId?: number
}
export type NetworkTask = NetworkLabel & {
	id: string
	startedAt: number
	phase: 'waiting' | 'receiving' | 'retrying'
	context: ClientRequestContext
	received?: number
	total?: number
	bytesPerSecond?: number
	lastReceivedAt?: number
}

const transfers = shallowRef<NetworkTask[]>([])
export const networkDownloads = readonly(transfers)
const active = new Map<string, () => void>()
let nextID = 0

const numericID = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
	? value : undefined

function namedResource(resource: NetworkResource, id?: unknown): NetworkLabel {
	return {
		resource,
		resourceId: numericID(id),
	}
}

// Only fixed resource names and numeric IDs reach the UI: query keys can contain search terms and private filenames.
export function queryNetworkLabel(key: QueryKey): NetworkLabel | undefined {
	const [group, kind, id] = key
	switch (group) {
		case 'projects': return namedResource(kind === 'detail' ? 'project' : 'projects', id)
		case 'tasks': return kind === 'detail'
			? namedResource('task', id)
			: namedResource(numericID(id) ? 'projectTasks' : 'tasks', id)
		case 'kanban': return namedResource('board', kind)
		case 'buckets': return namedResource('buckets', kind)
		case 'calendar-tasks': return {resource: 'calendar'}
		case 'drive': return kind === 'blob' || kind === 'preview' ? undefined : {resource: 'drive'}
		case 'attachments': return undefined
		case 'avatars': return undefined
		case 'avatar-provider': return {resource: 'settings'}
		case 'project-backgrounds': return kind === 'unsplash' && id === 'search' ? {resource: 'background'} : undefined
		case 'tcymc-conversations': return kind === 'detail' && key.length > 3 ? undefined : {
			resource: kind === 'detail' ? 'conversation' : 'conversations',
		}
		case 'compass':
			if (kind === 'image') return undefined
			return {
				resource: kind === 'entry' || kind === 'revisions' ? 'entry' : kind === 'entries' ? 'entries' : 'compass',
				resourceId: numericID(id),
			}
		case 'comments': return namedResource('comments', kind)
		case 'teams': return {resource: 'teams'}
		case 'labels': return {resource: 'labels'}
		case 'admin': return {resource: kind === 'projects' ? 'projects' : 'accounts'}
		case 'site-usage': return {resource: kind === 'access' || kind === 'settings' ? 'settings' : 'accounts'}
		case 'account': return {resource: 'settings'}
		case 'notifications':
		case 'system-status':
		case 'tcymc-ai-prompt': return undefined
		default: return {resource: 'page'}
	}
}

export function downloadNetworkLabel(url: string, path: Record<string, unknown> | undefined): NetworkLabel {
	const resourceId = numericID(path?.file) ?? numericID(path?.attachment) ?? numericID(path?.project)
	if (url.includes('avatar')) return {resource: 'avatar'}
	if (url.includes('background')) return namedResource('background', resourceId)
	if (url.includes('preview') || url.includes('/images/')) return namedResource('image', resourceId)
	return namedResource('file', resourceId)
}

export function clearStaleNetworkDownloads() {
	for (const task of transfers.value) {
		if (!isClientRequestContextCurrent(task.context)) active.get(task.id)?.()
	}
}

export function clearNetworkDownloads() {
	for (const finish of [...active.values()]) finish()
}

export type NetworkDownload = {
	observe(response: Response): Response
	finish(): void
}

export function beginNetworkDownload(
	label: NetworkLabel,
	context: ClientRequestContext,
	signal: AbortSignal,
): NetworkDownload | undefined {
	if (context.identity?.type !== AUTH_TYPES.USER || signal.aborted || !isClientRequestContextCurrent(context)) return
	clearStaleNetworkDownloads()
	const id = `download-${++nextID}`
	let task: NetworkTask = {
		...label,
		id,
		context,
		startedAt: performance.now(),
		phase: 'waiting',
		received: 0,
	}
	let publishedAt = task.startedAt
	let sampleAt: number | undefined
	let sampleBytes = 0
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	const publish = () => {
		if (!active.has(id)) return
		if (!isClientRequestContextCurrent(context)) {
			finish()
			return
		}
		transfers.value = transfers.value.map(row => row.id === id ? task : row)
	}
	const finish = () => {
		signal.removeEventListener('abort', abort)
		if (!active.delete(id)) return
		transfers.value = transfers.value.filter(row => row.id !== id)
	}
	const abort = () => {
		finish()
		void reader?.cancel(signal.reason).catch(() => {})
	}
	active.set(id, abort)
	transfers.value = [...transfers.value, task]
	signal.addEventListener('abort', abort, {once: true})

	return {
		finish,
		observe(response) {
			if (!response.ok || !response.body) return response
			const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase()
			// Fetch exposes decoded bytes. A CORS-hidden encoding or compressed wire length cannot supply a truthful percentage.
			const length = response.headers.get('Content-Length')
			const total = (encoding === 'identity' || (!encoding && response.type !== 'cors'))
				&& length && /^\d+$/.test(length) ? Number(length) : undefined
			task = {
				...task,
				phase: 'receiving',
				total: total && Number.isSafeInteger(total) ? total : undefined,
			}
			publish()
			reader = response.body.getReader()
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						if (signal.aborted || !isClientRequestContextCurrent(context)) {
							await reader!.cancel()
							throw new DOMException('Client request context changed', 'AbortError')
						}
						const chunk = await reader!.read()
						if (signal.aborted || !isClientRequestContextCurrent(context)) {
							throw new DOMException('Client request context changed', 'AbortError')
						}
						if (chunk.done) {
							controller.close()
							reader!.releaseLock()
							return
						}
						const now = performance.now()
						const received = (task.received ?? 0) + chunk.value.byteLength
						let speed = task.bytesPerSecond
						if (sampleAt === undefined) {
							sampleAt = now
							sampleBytes = received
						} else if (now - sampleAt >= 250) {
							speed = (received - sampleBytes) * 1000 / (now - sampleAt)
							sampleAt = now
							sampleBytes = received
						}
						task = {
							...task,
							received,
							lastReceivedAt: now,
							bytesPerSecond: speed,
							total: task.total && received <= task.total ? task.total : undefined,
						}
						if (received === chunk.value.byteLength || now - publishedAt >= 200) {
							publish()
							publishedAt = now
						}
						controller.enqueue(chunk.value)
					} catch (error) {
						finish()
						controller.error(error)
					}
				},
				cancel(reason) {
					finish()
					return reader!.cancel(reason)
				},
			})
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		},
	}
}
