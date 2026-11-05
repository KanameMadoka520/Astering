import {useMutation} from '@tanstack/vue-query'
import {driveChange, driveUsages, type DriveChangeWritable, type DriveUsage} from '@/client/generated'
import {client as sdkClient} from '@/client/generated/client.gen'
import {
	assertClientRequestContext,
	type ClientRequestContext,
} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {invalidateDrive, type DriveEntry} from './drive'
import {storageKeys} from './storage'

export const DRIVE_BATCH_LIMIT = 60
export type DriveBatchAction = 'pin' | 'unpin' | 'category' | 'trash' | 'restore'
export type DriveBatchRow = {
	file: DriveEntry,
	allowed: boolean,
	reason: string,
	usages: DriveUsage[],
}
export type DriveBatchResult = {
	id: number,
	status: 'completed' | 'blocked' | 'failed' | 'unknown',
	reason: string,
}
type Guard = {
	owner: ClientRequestContext,
	isActive: () => boolean,
}

function assertActive(input: Guard) {
	assertClientRequestContext(input.owner)
	if (!input.isActive()) throw new DOMException('Drive selection changed', 'AbortError')
}

function guardedFetch(input: Guard): typeof fetch {
	const send = sdkClient.getConfig().fetch ?? globalThis.fetch
	return (request, init) => {
		assertActive(input)
		return send(request, init)
	}
}

function validatedFiles(files: DriveEntry[]) {
	if (!files.length || files.length > DRIVE_BATCH_LIMIT
		|| new Set(files.map(file => file.file_id)).size !== files.length
		|| files.some(file => !Number.isSafeInteger(file.file_id) || file.file_id < 1
			|| !Number.isSafeInteger(file.revision) || file.revision < 1)) {
		throw new Error('Invalid Drive selection')
	}
	return files
}

function trashed(file: DriveEntry) {
	return Boolean(file.purging) || Boolean(file.trashed_at && new Date(file.trashed_at).getTime() > 0)
}

function unavailable(file: DriveEntry, action: DriveBatchAction): string {
	if (file.purging) return 'purging'
	if (action === 'restore') return trashed(file) ? '' : 'not_trashed'
	if (trashed(file)) return 'trashed'
	return file.file?.name ? '' : 'unavailable'
}

export function driveBatchPreviewMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: Guard & {
			files: DriveEntry[],
			action: DriveBatchAction,
			signal?: AbortSignal,
			onProgress?: (count: number) => void,
		}) => {
			assertActive(input)
			const rows: DriveBatchRow[] = []
			for (const file of validatedFiles(input.files)) {
				assertActive(input)
				if (input.signal?.aborted) throw new DOMException('Drive preview cancelled', 'AbortError')
				let reason = unavailable(file, input.action)
				let usages: DriveUsage[] = []
				if (!reason && input.action === 'trash') {
					try {
						const response = await driveUsages({
							path: {file: file.file_id},
							signal: input.signal,
							fetch: guardedFetch(input),
						})
						assertActive(input)
						usages = response.data ?? []
						if (usages.length) reason = 'in_use'
					} catch (cause) {
						assertActive(input)
						if (input.signal?.aborted) throw cause
						reason = 'references_unavailable'
					}
				}
				rows.push({file, allowed: !reason, reason, usages})
				input.onProgress?.(rows.length)
			}
			return rows
		},
		toastError: () => false,
	})
}

function changeBody(file: DriveEntry, action: DriveBatchAction, category: string): DriveChangeWritable {
	return {
		action: action === 'trash' || action === 'restore' ? action : 'edit',
		revision: file.revision,
		name: file.file?.name ?? '',
		category: action === 'category' ? category.trim() : file.category,
		pinned: action === 'pin' ? true : action === 'unpin' ? false : file.pinned,
		// References may have appeared after the review. Bulk selection never authorizes recycling those files.
		confirm: false,
		confirm_name: '',
	}
}

function failure(cause: unknown): Omit<DriveBatchResult, 'id'> {
	const problem = cause as {status?: number, detail?: string} | null
	const detail = problem?.detail
	if (detail === 'drive_changed') return {status: 'blocked', reason: 'changed'}
	if (detail === 'drive_in_use' || detail === 'drive_confirm') return {status: 'blocked', reason: 'in_use'}
	if (detail === 'drive_chat_unreadable') return {status: 'blocked', reason: 'references_unavailable'}
	if (detail === 'drive_missing') return {status: 'blocked', reason: 'unavailable'}
	if (detail === 'drive_trashed') return {status: 'blocked', reason: 'trashed'}
	if (typeof problem?.status === 'number' && problem.status >= 400 && problem.status < 500) {
		return {status: 'failed', reason: 'request_rejected'}
	}
	return {status: 'unknown', reason: 'unknown'}
}

export function driveBatchChangeMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: Guard & {
			rows: DriveBatchRow[],
			action: DriveBatchAction,
			category: string,
			onProgress?: (results: DriveBatchResult[]) => void,
		}) => {
			assertActive(input)
			const rows = input.rows.filter(row => row.allowed)
			validatedFiles(rows.map(row => row.file))
			if (input.category.trim().length > 120) throw new Error('Invalid Drive category')
			const results: DriveBatchResult[] = []
			for (const row of rows) {
				assertClientRequestContext(input.owner)
				if (!input.isActive()) break
				try {
					const {data} = await driveChange({
						path: {file: row.file.file_id},
						body: changeBody(row.file, input.action, input.category),
						fetch: guardedFetch(input),
					})
					assertClientRequestContext(input.owner)
					if (!input.isActive()) break
					if (data.file_id !== row.file.file_id) throw new Error('Invalid Drive acknowledgement')
					results.push({id: row.file.file_id, status: 'completed', reason: ''})
				} catch (cause) {
					assertClientRequestContext(input.owner)
					if (!input.isActive()) break
					results.push({id: row.file.file_id, ...failure(cause)})
				}
				input.onProgress?.([...results])
			}
			return results
		},
		onSettled: (_input, client) => Promise.all([
			invalidateDrive(client),
			client.invalidateQueries({queryKey: storageKeys.all}),
		]),
		toastError: () => false,
	})
}

export function useDriveBatchPreviewMutation() {
	return useMutation(driveBatchPreviewMutationOptions())
}

export function useDriveBatchChangeMutation() {
	return useMutation(driveBatchChangeMutationOptions())
}
