import {computed, onScopeDispose, ref, shallowRef, watch} from 'vue'
import {useQueryClient, type Query} from '@tanstack/vue-query'
import {useAuthStore} from '@/stores/auth'
import {AUTH_TYPES} from '@/constants/auth'
import {useOnline} from './useOnline'
import {
	clearStaleNetworkDownloads,
	networkDownloads,
	queryNetworkLabel,
	type NetworkTask,
} from '@/client/networkActivity'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'

export function useNetworkActivity() {
	const client = useQueryClient()
	const auth = useAuthStore()
	const online = useOnline()
	const reads = shallowRef<NetworkTask[]>([])
	const pending = new Map<string, NetworkTask>()
	const now = ref(performance.now())
	const dismissed = ref(false)
	const expanded = ref(false)
	let clock: ReturnType<typeof setInterval> | undefined
	let delay: ReturnType<typeof setTimeout> | undefined

	function update(query: Query) {
		if (client.getQueryCache().get(query.queryHash) !== query) return
		const label = queryNetworkLabel(query.queryKey)
		const old = pending.get(query.queryHash)
		const context = captureClientRequestContext()
		const included = auth.authUser && context.identity?.type === AUTH_TYPES.USER && query.state.fetchStatus === 'fetching'
			&& query.state.data === undefined && query.meta?.networkActivity !== false && label
		if (included) {
			const phase = query.state.fetchFailureCount ? 'retrying' : 'waiting'
			if (old?.phase === phase) return
			pending.set(query.queryHash, {
				...label,
				id: query.queryHash,
				startedAt: old?.startedAt ?? performance.now(),
				context: old?.context ?? context,
				phase,
			})
		} else if (!pending.delete(query.queryHash)) return
		reads.value = [...pending.values()]
	}
	const unsubscribe = client.getQueryCache().subscribe(event => {
		if (event.type === 'removed') {
			if (pending.delete(event.query.queryHash)) reads.value = [...pending.values()]
		} else if (event.type === 'updated') update(event.query)
	})
	watch(() => {
		// Session objects are refreshed normally; only identity/API/logout epoch changes end the activity scope.
		void auth.session
		void auth.identityKey
		const context = captureClientRequestContext()
		return `${auth.authUser}:${context.identity?.type}:${context.identity?.id}:${context.authSessionEpoch}:${context.apiBaseUrl}`
	}, () => {
		pending.clear()
		reads.value = []
		dismissed.value = false
		expanded.value = false
		clearStaleNetworkDownloads()
		for (const query of client.getQueryCache().getAll()) update(query)
	}, {
		immediate: true,
		flush: 'sync',
	})

	const tasks = computed(() => [...reads.value, ...networkDownloads.value]
		.filter(task => isClientRequestContextCurrent(task.context))
		.sort((a, b) => a.startedAt - b.startedAt))
	watch(() => tasks.value.length > 0, active => {
		clearInterval(clock)
		clearTimeout(delay)
		now.value = performance.now()
		if (active) {
			clock = setInterval(() => {
				now.value = performance.now()
				clearStaleNetworkDownloads()
				for (const [id, task] of pending) {
					if (!isClientRequestContextCurrent(task.context)) pending.delete(id)
				}
				if (pending.size !== reads.value.length) reads.value = [...pending.values()]
			}, 500)
			delay = setTimeout(() => { now.value = performance.now() }, 1200)
		} else {
			dismissed.value = false
			expanded.value = false
		}
	}, {immediate: true})
	const visible = computed(() => auth.authUser && online.value && !dismissed.value
		&& tasks.value.length > 0 && now.value - tasks.value[0].startedAt >= 1200)
	onScopeDispose(() => {
		unsubscribe()
		clearInterval(clock)
		clearTimeout(delay)
		pending.clear()
	})
	return {
		tasks,
		now,
		visible,
		dismissed,
		expanded,
	}
}
