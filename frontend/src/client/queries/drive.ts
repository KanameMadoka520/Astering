import {queryOptions, useMutation, type QueryClient} from '@tanstack/vue-query'
import {driveList, driveUpload, driveChange, driveAttach, driveCover, driveDownload, drivePreview, driveUsages} from '@/client/generated'
import type {DriveListData, DriveChangeWritable, DriveFile} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {expectBlob} from './blobResponse'
import {invalidateTaskMembership, mapTaskEverywhere} from './taskCache'
import {projectBackgroundKeys} from './projectBackgrounds'
import {projectKeys} from './projects'
import {i18n} from '@/i18n'

export type DriveEntry = DriveFile & Required<Pick<DriveFile, 'file_id' | 'revision' | 'category' | 'pinned'>>
function entry(file: DriveFile): DriveEntry {
	if (!file.file_id || !file.revision) throw new Error('Invalid drive response')
	return {...file, file_id: file.file_id, revision: file.revision, category: file.category ?? '', pinned: file.pinned ?? false}
}
export const driveKeys = ['drive'] as const
/** Refreshes Drive lists, totals and usages; cached file bytes and previews are kept. */
export function invalidateDrive(client: QueryClient) {
	return client.invalidateQueries({queryKey: driveKeys, predicate: query => query.queryKey[1] !== 'blob' && query.queryKey[1] !== 'preview'})
}
function translatedDriveError(cause: unknown): never {
	const detail = (cause as {detail?: string})?.detail
	if (detail && ['drive_missing', 'drive_changed', 'drive_trashed', 'drive_in_use', 'drive_chat_unreadable', 'drive_confirm', 'drive_purge_retry'].includes(detail)) {
		throw new Error(i18n.global.t(`drive.errors.${detail}`))
	}
	throw cause
}
export function driveQuery(query: DriveListData['query']) {
	return queryOptions({
		queryKey: [...driveKeys, 'list', query],
		queryFn: async ({signal}) => {
			const data = (await driveList({query, signal})).data
			return {...data, files: (data.files ?? []).map(entry)}
		},
		// Search, filter and page changes keep the current files on screen while they load;
		// switching between the library and the recycle bin (or the image-only picker) does not.
		placeholderData: (previous, previousQuery) => {
			const old = previousQuery?.queryKey[2] as DriveListData['query']
			return old?.trash === query?.trash && old?.images === query?.images ? previous : undefined
		},
		meta: {handlesError: true},
	})
}
export function driveUsagesQuery(id: number) {
	return queryOptions({
		queryKey: [...driveKeys, 'usages', id],
		queryFn: async ({signal}) => (await driveUsages({path: {file: id}, signal})).data,
		meta: {handlesError: true},
	})
}
// The download button reports its own failure.
export function driveBlobQuery(id: number) {
	return queryOptions({
		queryKey: [...driveKeys, 'blob', id],
		queryFn: async ({signal}) => expectBlob((await driveDownload({path: {file: id}, parseAs: 'blob', signal})).data, 'Drive'),
		gcTime: 60_000,
		meta: {handlesError: true},
	})
}
// `headers` carries the client-only batch headers from chooseImageBatch; `quiet` leaves the error to the caller's own list.
export function useUploadDriveMutation() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({file, signal, headers}: {file: File, signal?: AbortSignal, headers?: Record<string, string>, quiet?: boolean}) => (await driveUpload({body: {file}, signal, headers})).data,
		onSettled: (_file, client) => invalidateDrive(client),
		toastError: ({quiet}) => !quiet,
	}))
}
export function useChangeDriveMutation() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({id, body}: {id: number, body: DriveChangeWritable}) => (await driveChange({path: {file: id}, body}).catch(translatedDriveError)).data,
		onSettled: ({body}, client) => body.action === 'purge' ? client.invalidateQueries({queryKey: [...driveKeys, 'list']}) : invalidateDrive(client),
	}))
}
export function useAttachDriveMutation() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({file, taskId}: {file: DriveEntry, taskId: number}) => (await driveAttach({path: {file: file.file_id}, body: {revision: file.revision, task_id: taskId}}).catch(translatedDriveError)).data,
		onSuccess: (attachment, {taskId}, client) => mapTaskEverywhere(client, taskId, task => ({...task, attachments: [...task.attachments.filter(a => a.id !== attachment.id), attachment]})),
		onSettled: ({taskId}, client) => Promise.all([invalidateTaskMembership(client, taskId), invalidateDrive(client)]),
	}))
}
export function useDriveCoverMutation() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({file, projectId}: {file: DriveEntry, projectId: number}) => (await driveCover({path: {file: file.file_id}, body: {revision: file.revision, project_id: projectId}}).catch(translatedDriveError)).data,
		onSettled: ({projectId}, client) => Promise.all([
			invalidateDrive(client),
			client.invalidateQueries({queryKey: projectKeys.list()}),
			client.invalidateQueries({queryKey: projectKeys.detail(projectId)}),
			client.invalidateQueries({queryKey: projectBackgroundKeys.project(projectId)}),
		]),
	}))
}

// A failed preview falls back to the file icon instead of toasting once per card.
export function drivePreviewQuery(id: number) {
	return queryOptions({
		queryKey: [...driveKeys, 'preview', id],
		queryFn: async ({signal}) => expectBlob((await drivePreview({path: {file: id}, parseAs: 'blob', signal})).data, 'Drive preview'),
		gcTime: 60_000,
		retry: false,
		meta: {handlesError: true},
	})
}
