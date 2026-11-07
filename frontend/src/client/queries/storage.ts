import {queryOptions, useMutation} from '@tanstack/vue-query'
import {
	userStorageSummary,
	userStorageFiles,
	userStorageConversations,
	userStorageCleanupPreview,
	userStorageCleanupExecute,
	type StorageSummary as ApiStorageSummary,
	type StorageFilePage as ApiStorageFilePage,
	type StorageConversationPage as ApiStorageConversationPage,
	type StoragePreview as ApiStoragePreview,
	type StoragePreviewItem as ApiStoragePreviewItem,
	type StorageFileItem,
	type StorageConversationItem,
	type StorageExecuteItem,
	type StorageSelection,
	type UserStorageFilesData,
	type UserStorageConversationsData,
} from '@/client/generated'
import {contextFetch} from '@/client/requestContextFetch'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
	type ClientRequestContext,
} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {invalidateDrive} from './drive'
import {conversationKeys, markConversationDeleted} from './tcyConversations'

export type StorageSummary = Omit<ApiStorageSummary, 'categories' | 'definitions'> & {
	categories: NonNullable<ApiStorageSummary['categories']>,
	definitions: string[],
}
export type StorageFile = StorageFileItem
export type StorageConversation = StorageConversationItem
export type StorageFilePage = Omit<ApiStorageFilePage, 'items'> & {items: StorageFile[]}
export type StorageConversationPage = Omit<ApiStorageConversationPage, 'items'> & {items: StorageConversation[]}
export type StoragePreviewItem = Omit<ApiStoragePreviewItem, 'usages'> & {
	usages: NonNullable<ApiStoragePreviewItem['usages']>,
}
export type StoragePreview = Omit<ApiStoragePreview, 'items'> & {items: StoragePreviewItem[]}
export type {StorageSelection}
export type StorageFileQuery = NonNullable<UserStorageFilesData['query']>
export type StorageConversationQuery = NonNullable<UserStorageConversationsData['query']>

export type ScopedStorage<T> = {
	context: ClientRequestContext,
	data: T,
}

export const storageKeys = {
	all: ['personal-storage'] as const,
	summary: (context: ClientRequestContext) => [...storageKeys.all, 'summary', context] as const,
	files: (context: ClientRequestContext, query: StorageFileQuery) =>
		[...storageKeys.all, 'files', context, query] as const,
	conversations: (context: ClientRequestContext, query: StorageConversationQuery) =>
		[...storageKeys.all, 'conversations', context, query] as const,
}

export function currentStorageData<T>(value: ScopedStorage<T> | undefined): T | undefined {
	return value && isClientRequestContextCurrent(value.context) ? value.data : undefined
}

export function storageSummaryQuery(context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: storageKeys.summary(context),
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await userStorageSummary({signal, fetch: contextFetch(context)})
			assertClientRequestContext(context)
			return {context, data: {...data, categories: data.categories ?? [], definitions: data.definitions ?? []}}
		},
		staleTime: 30_000,
		gcTime: 60_000,
		refetchOnMount: 'always',
		retry: false,
		meta: {handlesError: true},
	})
}

export function storageFilesQuery(query: StorageFileQuery, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: storageKeys.files(context, query),
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await userStorageFiles({query, signal, fetch: contextFetch(context)})
			assertClientRequestContext(context)
			return {context, data: {...data, items: data.items ?? []}}
		},
		staleTime: 15_000,
		gcTime: 60_000,
		retry: false,
		meta: {handlesError: true},
	})
}

export function storageConversationsQuery(query: StorageConversationQuery, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: storageKeys.conversations(context, query),
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await userStorageConversations({query, signal, fetch: contextFetch(context)})
			assertClientRequestContext(context)
			return {context, data: {...data, items: data.items ?? []}}
		},
		staleTime: 15_000,
		gcTime: 60_000,
		retry: false,
		meta: {handlesError: true},
	})
}

export function storagePreviewMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: {items: StorageSelection[], owner: ClientRequestContext, signal?: AbortSignal}) => {
			assertClientRequestContext(input.owner)
			const {data} = await userStorageCleanupPreview({
				body: {items: input.items},
				signal: input.signal,
				fetch: contextFetch(input.owner),
			})
			assertClientRequestContext(input.owner)
			return {
				context: input.owner,
				data: {...data, items: (data.items ?? []).map(item => ({...item, usages: item.usages ?? []}))},
			}
		},
		toastError: () => false,
	})
}

export function useStoragePreviewMutation() {
	return useMutation(storagePreviewMutationOptions())
}

export type CleanupResult = Omit<StorageExecuteItem, 'status'> & {
	status: StorageExecuteItem['status'] | 'unknown',
	name: string,
}

export type CleanupProgress = {
	processed: number,
	total: number,
	results: CleanupResult[],
}

export function storageCleanupMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: {
			items: StoragePreviewItem[],
			owner: ClientRequestContext,
			onProgress?: (progress: CleanupProgress) => void,
		}) => {
			assertClientRequestContext(input.owner)
			const results: CleanupResult[] = []
			for (const item of input.items) {
				assertClientRequestContext(input.owner)
				try {
					const {data} = await userStorageCleanupExecute({
						body: {tokens: [item.token], confirm: true},
						fetch: contextFetch(input.owner),
					})
					assertClientRequestContext(input.owner)
					const result = data.items?.[0]
					if (data.items?.length !== 1 || result?.id !== item.id
						|| result.kind !== item.kind || result.action !== item.action) {
						throw new Error('Invalid cleanup acknowledgement')
					}
					results.push({...result, name: item.name})
				} catch (cause) {
					if (isRequestContextAbort(cause)) throw cause
					assertClientRequestContext(input.owner)
					results.push({
						kind: item.kind,
						id: item.id,
						action: item.action,
						name: item.name,
						status: 'unknown',
						reason: 'request_failed',
						freed_bytes: 0,
						bytes_complete: false,
					})
				}
				input.onProgress?.({processed: results.length, total: input.items.length, results: [...results]})
			}
			return {context: input.owner, results}
		},
		onSuccess: (data, _input, client) => {
			for (const item of data.results) {
				if (item.kind === 'conversation' && ['completed', 'already_done'].includes(item.status)) {
					markConversationDeleted(client, item.id)
				}
			}
		},
		onSettled: (_input, client) => Promise.all([
			client.invalidateQueries({queryKey: storageKeys.all}),
			invalidateDrive(client),
			client.invalidateQueries({queryKey: conversationKeys.lists()}),
		]),
		toastError: () => false,
	})
}

export function useStorageCleanupMutation() {
	return useMutation(storageCleanupMutationOptions())
}
