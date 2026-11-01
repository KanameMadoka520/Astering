import {queryOptions, useMutation} from '@tanstack/vue-query'
import {tcyAiPreferences, tcyAiSavePreferences, type AssistantPreferences} from '@/client/generated'
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
		mutationFn: async (body: AssistantPreferences) => (await tcyAiSavePreferences({body})).data,
		onSettled: (_input, client) => client.invalidateQueries({queryKey: key}),
		// The preferences dialog shows the failure next to the action, with its own retry.
		toastError: () => false,
	}))
}
