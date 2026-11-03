import {computed, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref} from 'vue'
import {hashKey, useQueryClient, type QueryKey} from '@tanstack/vue-query'
import {captureClientRequestContext, isClientRequestContextCurrent, type ClientRequestContext} from '@/client/requestContext'
import {useAuthStore} from '@/stores/auth'

/** One previous result, only while another range is pending, and only for its original identity. */
export function useRetainedHistoryQuery<T>(
	query: {data: Ref<T | undefined>, dataUpdatedAt: Ref<number>, error: Ref<unknown>, isPending: Ref<boolean>},
	key: MaybeRefOrGetter<QueryKey>,
	year: MaybeRefOrGetter<number>,
) {
	const auth = useAuthStore()
	const client = useQueryClient()
	const retained = shallowRef<{data: T, year: number, hash: string, owner: ClientRequestContext}>()
	const unavailable = computed(() => [401, 403, 404].includes((query.error.value as {status?: number} | null)?.status ?? 0))
	function remember(data: T | undefined) {
		if (unavailable.value) return
		if (data !== undefined) {
			retained.value = {data, year: toValue(year), hash: hashKey(toValue(key)), owner: captureClientRequestContext()}
		} else if (retained.value && !isClientRequestContextCurrent(retained.value.owner)) {
			retained.value = undefined
		}
	}
	watch([query.data, query.dataUpdatedAt], ([data]) => remember(data), {immediate: true, flush: 'sync'})
	watch(unavailable, denied => {
		if (denied) retained.value = undefined
		else remember(query.data.value)
	}, {flush: 'sync'})
	watch(() => [auth.session, auth.authenticated], () => {
		if (retained.value && !isClientRequestContextCurrent(retained.value.owner)) retained.value = undefined
	}, {flush: 'sync'})
	// Explicit cache clearing and GC must also release this component's single retained reference.
	const unsubscribe = client.getQueryCache().subscribe(event => {
		if (event.type === 'removed' && event.query.queryHash === retained.value?.hash) retained.value = undefined
	})
	onScopeDispose(unsubscribe)
	const visible = computed(() => {
		const previous = retained.value
		if (unavailable.value || !previous || !isClientRequestContextCurrent(previous.owner)) return undefined
		return query.data.value !== undefined || query.isPending.value ? previous : undefined
	})
	return {
		data: computed(() => visible.value?.data),
		year: computed(() => visible.value?.year),
	}
}
