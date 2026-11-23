import {queryOptions, useMutation} from '@tanstack/vue-query'
import {tcyAiPreferences, tcyAiSavePreferences, type AssistantPreferences} from '@/client/generated'
import {contextFetch} from '@/client/requestContextFetch'
import {contextMutationOptions} from './contextMutation'
const key = ['tcymc-ai-preferences'] as const
export function assistantPreferencesQuery() {
	return queryOptions({
		queryKey: key,
		queryFn: async ({signal}) => (await tcyAiPreferences({signal})).data,
		// The assistant and its preferences dialog show their own error with a retry.
		meta: {handlesError: true},
	})
}
export function useSaveAssistantPreferences() {
	return useMutation(contextMutationOptions({
		mutationFn: async (body: AssistantPreferences, {request}) => (await tcyAiSavePreferences({
			body,
			fetch: contextFetch(request),
		})).data,
		onSuccess: (saved, _input, client) => {
			client.setQueryData<AssistantPreferences>(key, current =>
				current && (current.revision ?? 0) <= (saved.revision ?? 0) ? saved : current,
			)
		},
		onSettled: async (_input, client) => {
			void client.invalidateQueries({queryKey: key, exact: true})
		},
		// The preferences dialog shows the failure next to the action, with its own retry.
		toastError: () => false,
	}))
}
