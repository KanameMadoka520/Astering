import {computed, onScopeDispose, ref} from 'vue'
import {useQueryClient} from '@tanstack/vue-query'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {receiveNoteTranscript} from '@/client/queries/notes'
import type {LiveNoteReceipt} from '@/client/queries/liveNotes'
import {getToken} from '@/helpers/auth'
import {
	isNativeAndroid,
	onNativeAndroidEvent,
	requestNativeAndroid,
	type NativeOfflineStatus,
} from '@/helpers/nativeAndroid'

export type OfflineTranscriptEntry = {
	client_id: string,
	note_id: number,
	text: string,
	captured_at?: string,
}

export type OfflineTranscriptPage = {
	entries: OfflineTranscriptEntry[],
	next_cursor?: string,
	has_more: boolean,
	status: NativeOfflineStatus,
}

/** Native owns the encrypted text outbox. The WebView receives metadata and committed receipts only. */
export function useOfflineNoteSync() {
	const client = useQueryClient()
	const owner = captureClientRequestContext()
	const status = ref<NativeOfflineStatus>()
	const busy = ref(false)
	const failed = ref(false)
	const unsupported = ref(false)
	const page = ref<OfflineTranscriptPage>()
	const pageBusy = ref(false)
	const pageFailed = ref(false)
	let pageGeneration = 0
	let disposed = false
	const current = () => !disposed && isClientRequestContextCurrent(owner)
	const builtIn = computed(() => current() && status.value?.available === true)
	const available = computed(() => builtIn.value && status.value?.ready === true)

	function receive(value: NativeOfflineStatus) {
		if (!current() || !value || value.user_id !== owner.identity?.id ||
			!Number.isSafeInteger(value.pending_count) || value.pending_count < 0 ||
			!Number.isSafeInteger(value.pending_bytes) || value.pending_bytes < 0) return false
		status.value = value
		unsupported.value = false
		return true
	}

	async function loadPage(cursor = '') {
		if (!isNativeAndroid() || !current() || pageBusy.value) return
		const run = ++pageGeneration
		pageBusy.value = true
		pageFailed.value = false
		try {
			const value = await requestNativeAndroid<OfflineTranscriptPage>('listOffline', {cursor, limit: 20})
			if (!current() || run !== pageGeneration) return
			if (value?.status?.user_id !== owner.identity?.id || value.status.available !== true || value.status.ready !== true ||
				!Array.isArray(value.entries) || value.entries.length > 50 ||
				!value.entries.every(row => typeof row.text === 'string' &&
					typeof row.client_id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(row.client_id) &&
					Number.isSafeInteger(row.note_id) && row.note_id > 0) ||
				(value.next_cursor !== undefined && typeof value.next_cursor !== 'string')) throw new Error('protocol')
			if (!receive(value.status)) throw new Error('protocol')
			page.value = value
		} catch {
			if (current() && run === pageGeneration) pageFailed.value = true
		} finally {
			if (current() && run === pageGeneration) pageBusy.value = false
		}
	}

	async function action(name: 'offlineStatus' | 'syncOffline' | 'clearOffline') {
		if (!isNativeAndroid() || !current() || busy.value) return
		busy.value = true
		failed.value = false
		try {
			await requestNativeAndroid('session', {token: getToken()})
			if (!current()) return
			const value = await requestNativeAndroid<NativeOfflineStatus>(name, name === 'clearOffline' ? {confirm: true} : {})
			if (!current()) return
			if (!receive(value)) throw new Error('protocol')
		} catch (cause) {
			// Older APKs have no local engine; keep online recording available without an error on every mount.
			if (!current()) return
			if (name === 'offlineStatus' && cause instanceof Error &&
				['unsupported', 'unknown_action', 'unsupported_action'].includes(cause.message)) {
				status.value = undefined
				unsupported.value = true
			} else {
				failed.value = true
			}
		} finally {
			if (current()) busy.value = false
		}
	}

	const unsubscribe = onNativeAndroidEvent(event => {
		if (event.event !== 'offline' || !current() || event.user_id !== owner.identity?.id) return
		if (!receive(event.status)) return
		const receipt = event.receipt as LiveNoteReceipt | undefined
		if (receipt?.segment && receipt.stats && Number.isSafeInteger(receipt.segment.note_id) &&
			(receipt.segment.note_id ?? 0) > 0) {
			receiveNoteTranscript(client, receipt.segment.note_id!, receipt, owner)
		}
	})
	void action('offlineStatus')
	const visible = () => { if (!document.hidden) void action('offlineStatus') }
	document.addEventListener('visibilitychange', visible)
	onScopeDispose(() => {
		disposed = true
		unsubscribe()
		document.removeEventListener('visibilitychange', visible)
	})
	return {
		status,
		builtIn,
		available,
		unsupported,
		busy,
		failed,
		page,
		pageBusy,
		pageFailed,
		loadPage,
		reload: () => action('offlineStatus'),
		sync: () => action('syncOffline'),
		clear: () => action('clearOffline'),
	}
}
