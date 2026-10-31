import {queryOptions, useMutation} from '@tanstack/vue-query'
import {tcyAiAttachmentsUpload, tcyAiAttachmentsRemove, tcyAiAttachmentsDownload, tcyAiConversationsExport, tcyAiAttachmentsFromDrive} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {conversationKeys} from './tcyConversations'
import {invalidateDrive} from './drive'

export async function fetchChatAttachment(id: string, file: string, signal?: AbortSignal): Promise<Blob> {
	const data: unknown = (await tcyAiAttachmentsDownload({path: {id, file}, parseAs: 'blob', signal})).data
	if (!(data instanceof Blob)) throw new Error('Invalid attachment response')
	return data
}
export function chatAttachmentQuery(id: string, file: string, enabled: boolean) {
	return queryOptions({queryKey: [...conversationKeys.detail(id), 'attachment', file], queryFn: ({signal}) => fetchChatAttachment(id, file, signal), enabled, retry: false, gcTime: 60_000, staleTime: Infinity, meta: {handlesError: true}})
}
// `headers` carries the client-only batch headers from chooseImageBatch; `quiet` leaves the error to the upload tray.
// A new upload is also saved as a Drive file. Drive refreshes in the background, so the next queued file need not
// wait for an open Drive list; the draft itself is refetched before the mutation settles.
export function useUploadChatAttachment() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({id, file, signal, headers}: {id: string, file: File, signal?: AbortSignal, headers?: Record<string, string>, quiet?: boolean}) => (await tcyAiAttachmentsUpload({path: {id}, body: {file}, signal, headers})).data,
		onSettled: ({id}, client) => {
			void invalidateDrive(client)
			return Promise.all([client.invalidateQueries({queryKey: conversationKeys.detail(id)}), client.invalidateQueries({queryKey: conversationKeys.lists()})])
		},
		toastError: ({quiet}) => !quiet,
	}))
}
export function useAttachDriveFileToChat() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({id, fileId}: {id: string, fileId: number}) => (await tcyAiAttachmentsFromDrive({path: {id}, body: {file_id: fileId}})).data,
		// The drive file gains a reference; cached file bytes and previews are unchanged.
		onSettled: ({id}, client) => Promise.all([
			client.invalidateQueries({queryKey: conversationKeys.detail(id)}),
			client.invalidateQueries({queryKey: conversationKeys.lists()}),
			invalidateDrive(client),
		]),
	}))
}
export function useRemoveChatAttachment() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({id, file}: {id: string, file: string}) => (await tcyAiAttachmentsRemove({path: {id, file}})).data,
		// A Drive-backed draft loses its "chat draft" usage.
		onSettled: ({id}, client) => Promise.all([client.invalidateQueries({queryKey: conversationKeys.detail(id)}), invalidateDrive(client)]),
	}))
}
export async function fetchConversationExport(id: string, format: 'json' | 'md' | 'zip', signal?: AbortSignal): Promise<Blob> {
	const data: unknown = (await tcyAiConversationsExport({path: {id}, query: {format}, parseAs: 'blob', signal})).data
	if (!(data instanceof Blob)) throw new Error('Invalid export response')
	return data
}
