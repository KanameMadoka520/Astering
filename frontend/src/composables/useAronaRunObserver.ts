import {
	computed,
	effectScope,
	onScopeDispose,
	watch,
	type EffectScope,
} from 'vue'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {useConversationEvents} from '@/client/queries/conversationEvents'
import {
	agentRunScope,
	conversationQuery,
	endAgentRun,
	resumeAgentRun,
	useApplyAgentReceipts,
} from '@/client/queries/tcyConversations'
import {useAuthStore} from '@/stores/auth'

/** Keeps each background conversation's events and receipts current while no assistant view shows it. */
export function useAronaRunObserver() {
	const client = useQueryClient()
	const auth = useAuthStore()
	const scope = agentRunScope(client)
	const apply = useApplyAgentReceipts()
	resumeAgentRun(client)
	// The request context distinguishes a new login from a normal same-account token refresh.
	watch(() => [auth.info?.id, auth.session], () => resumeAgentRun(client))

	const following = computed(() => scope.live.value.filter(id => !scope.viewers.has(id)))
	const observers = new Map<string, EffectScope>()
	let owner = scope.context
	function stopObservers() {
		observers.forEach(observer => observer.stop())
		observers.clear()
	}
	watch(following, ids => {
		if (owner !== scope.context) {
			stopObservers()
			owner = scope.context
		}
		for (const [id, observer] of observers) {
			if (!ids.includes(id)) {
				observer.stop()
				observers.delete(id)
			}
		}
		for (const id of ids) {
			if (observers.has(id)) continue
			// A stable scope per conversation means finishing A never reconnects B's stream.
			const observer = effectScope(true)
			const context = owner
			observers.set(id, observer)
			observer.run(() => {
				const events = useConversationEvents(id, client)
				const conversation = useQuery(computed(() => conversationQuery(id, events.connected.value)), client)
				watch(conversation.data, value => {
					if (observer.active && agentRunScope(client).context === context && value?.id === id) apply(value)
				}, {immediate: true})
				// Revoking one conversation stops only that observer.
				watch(conversation.error, error => {
					const status = (error as {status?: number} | null)?.status
					if (observer.active && agentRunScope(client).context === context && (status === 403 || status === 404)) {
						endAgentRun(client, id)
					}
				})
			})
		}
	}, {immediate: true})
	onScopeDispose(stopObservers)
	return {following}
}
