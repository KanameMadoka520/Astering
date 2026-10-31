import {computed, onBeforeUnmount, ref, shallowRef} from 'vue'
import {useI18n} from 'vue-i18n'
import {useUploadChatAttachment} from '@/client/queries/chatAttachments'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort, type ClientRequestContext} from '@/client/requestContext'
import {chooseImageBatch, uploads, type ImageBatch} from '@/helpers/uploadTransport'
import {getErrorText} from '@/message'

export type ChatUploadState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'
export type ChatUploadItem = {key: string, file: File, name: string, size: number, state: ChatUploadState, recordId?: string, error?: string, retryable: boolean}

export const CHAT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
// Per message, unsent drafts included.
export const CHAT_UPLOAD_MAX_FILES = 16
// Matches the upload center, which folds finished uploads away after the same pause.
const DONE_LINGER_MS = 2500

/**
 * Chat attachment uploads for one composer. A selection asks for the image format once, then uploads one file
 * at a time (gateways limit concurrent uploads). A failure only affects its own file, and a retry reuses the
 * selection's choice instead of asking again. Files that did upload stay in the draft whatever happens later.
 */
export function useChatAttachmentUploads(options: {resolveConversation(): Promise<string | null>}) {
	const {t} = useI18n({useScope: 'global'})
	const upload = useUploadChatAttachment()
	const list = shallowRef<ChatUploadItem[]>([])
	const running = ref(false)
	const batches = new Map<string, ImageBatch>()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	let controller: AbortController | undefined
	let owner = captureClientRequestContext()

	function find(key: string) {
		return list.value.find(item => item.key === key)
	}
	function patch(key: string, change: Partial<ChatUploadItem>) {
		list.value = list.value.map(item => item.key === key ? {...item, ...change} : item)
	}
	function remove(predicate: (item: ChatUploadItem) => boolean) {
		const removed = list.value.filter(predicate)
		if (!removed.length) return
		list.value = list.value.filter(item => !predicate(item))
		// Their transport rows are hidden from the shared upload panel, so nobody else clears them.
		const records = new Set(removed.map(item => item.recordId))
		uploads.value = uploads.value.filter(row => !records.has(row.id))
		for (const {key} of removed) {
			clearTimeout(timers.get(key))
			timers.delete(key)
			const batch = batches.get(key)
			batches.delete(key)
			// The preset lives as long as any file of its selection may still be retried.
			if (batch && ![...batches.values()].includes(batch)) batch.release()
		}
	}
	/** Drops every row and preset, aborting the current upload: another conversation or account. */
	function reset() {
		controller?.abort()
		controller = undefined
		running.value = false
		remove(() => true)
	}
	// Without a message the row's "failed" state says enough.
	function failure(cause: unknown) {
		return getErrorText(cause).trim() || undefined
	}

	async function begin(work: (signal: AbortSignal, context: ClientRequestContext) => Promise<void>) {
		if (running.value) return
		// Rows hold the previous account's files; they must not be retried under another identity.
		if (!isClientRequestContextCurrent(owner)) {
			reset()
			owner = captureClientRequestContext()
		}
		const own = new AbortController()
		controller = own
		running.value = true
		try {
			await work(own.signal, owner)
		} finally {
			if (controller === own) {
				controller = undefined
				running.value = false
			}
		}
	}

	async function run(keys: string[], signal: AbortSignal, context: ClientRequestContext) {
		if (!keys.length) return
		const queued = () => keys.filter(key => find(key)?.state === 'queued')
		let id: string | null
		try {
			id = await options.resolveConversation()
		} catch (cause) {
			if (!isClientRequestContextCurrent(context)) return reset()
			for (const key of queued()) patch(key, {state: 'failed', error: failure(cause)})
			return
		}
		if (!isClientRequestContextCurrent(context)) return reset()
		for (const key of keys) {
			if (!id || signal.aborted) break
			const item = find(key)
			if (item?.state !== 'queued') continue
			patch(key, {state: 'uploading', error: undefined})
			try {
				await upload.mutateAsync({id, file: item.file, signal, headers: batches.get(key)?.headers(item.recordId), quiet: true})
				if (!isClientRequestContextCurrent(context)) return reset()
				// The mutation settles after the draft was refetched, so the card is already visible.
				patch(key, {state: 'done'})
				timers.set(key, setTimeout(() => remove(row => row.key === key), DONE_LINGER_MS))
			} catch (cause) {
				if (!isClientRequestContextCurrent(context)) return reset()
				// Cancelling, or dismissing a fallback image choice, stops the rest of the run.
				if (isRequestContextAbort(cause)) {
					patch(key, {state: 'cancelled'})
					break
				}
				patch(key, {state: 'failed', error: failure(cause)})
			}
		}
		for (const key of queued()) patch(key, {state: 'cancelled'})
	}

	/** Cancelling the image choice adds nothing. Oversized files are listed as failed without uploading. */
	function start(files: File[]) {
		return begin(async (signal, context) => {
			const accepted = files.filter(file => file.size <= CHAT_UPLOAD_MAX_BYTES)
			const batch = accepted.length ? await chooseImageBatch(accepted, signal) : null
			if (accepted.length && !batch) return
			if (signal.aborted || !isClientRequestContextCurrent(context)) {
				batch?.release()
				return
			}
			const added = files.map((file): ChatUploadItem => {
				const key = crypto.randomUUID()
				const base = {key, file, name: file.name, size: file.size}
				if (file.size > CHAT_UPLOAD_MAX_BYTES) return {...base, state: 'failed', error: t('chatFiles.tooLarge'), retryable: false}
				if (batch) batches.set(key, batch)
				return {...base, state: 'queued', recordId: crypto.randomUUID(), retryable: true}
			})
			list.value = [...list.value, ...added]
			await run(added.filter(item => item.state === 'queued').map(item => item.key), signal, context)
		})
	}

	function retryWhere(predicate: (item: ChatUploadItem) => boolean) {
		return begin(async (signal, context) => {
			const keys = list.value
				.filter(item => item.retryable && (item.state === 'failed' || item.state === 'cancelled') && predicate(item))
				.map(item => item.key)
			for (const key of keys) patch(key, {state: 'queued', error: undefined})
			await run(keys, signal, context)
		})
	}

	onBeforeUnmount(reset)

	return {
		items: computed(() => list.value),
		running: computed(() => running.value),
		start,
		retry: (key: string) => retryWhere(item => item.key === key),
		retryFailed: () => retryWhere(() => true),
		/** Aborts the current upload; queued files become cancelled and can be retried. */
		cancel: () => controller?.abort(),
		dismiss: (key: string) => remove(item => item.key === key && item.state !== 'uploading'),
		clearFinished: () => remove(item => item.state === 'done' || item.state === 'failed' || item.state === 'cancelled'),
		reset,
	}
}
