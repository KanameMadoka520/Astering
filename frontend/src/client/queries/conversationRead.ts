import {useMutation} from '@tanstack/vue-query'
import {
	tcyAiConversationsMarkRead,
	type Conversation,
	type TcyAiConversationsListResponses,
} from '@/client/generated'
import {assertClientRequestContext, type ClientRequestContext} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {conversationKeys} from './tcyConversations'

type Input = {
	id: string,
	replyId: string,
	owner: ClientRequestContext,
}

export function markConversationReadMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: Input) => {
			assertClientRequestContext(input.owner)
			const {data} = await tcyAiConversationsMarkRead({
				path: {id: input.id},
				body: {through_reply_id: input.replyId},
				fetch: (request, init) => {
					assertClientRequestContext(input.owner)
					return globalThis.fetch(request, init)
				},
			})
			assertClientRequestContext(input.owner)
			return data
		},
		onSuccess: (receipt, input, client) => {
			assertClientRequestContext(input.owner)
			// Cancel synchronously before patching: even an initial list with no cached rows may be in flight.
			void client.cancelQueries({queryKey: conversationKeys.lists()})
			client.setQueryData<Conversation>(conversationKeys.detail(input.id), current => {
				if (!current || current.latest_reply_id !== receipt.latest_reply_id) return current
				return {...current, unread: receipt.unread}
			})
			client.setQueriesData<TcyAiConversationsListResponses[200]>({queryKey: conversationKeys.lists()}, current => {
				if (!current) return current
				return {
					...current,
					items: current.items?.map(item => item.id === input.id && item.latest_reply_id === receipt.latest_reply_id
						? {...item, unread: receipt.unread}
						: item),
				}
			})
		},
		onSettled: (_input, client) => client.invalidateQueries({
			queryKey: conversationKeys.lists(),
			refetchType: 'active',
		}),
		toastError: () => false,
	})
}

export function useMarkConversationRead() {
	return useMutation(markConversationReadMutationOptions())
}
