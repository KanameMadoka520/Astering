import {computed, ref, toValue, watch, type MaybeRefOrGetter} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {klona} from 'klona/lite'
import {ApiError} from '@/client/problem'
import {kanbanQuery, type BucketResponse} from '@/client/queries/kanban'
import type {TaskFilterParams} from '@/client/queries/tasks'

export function useKanban(
	project: MaybeRefOrGetter<number>,
	view: MaybeRefOrGetter<number>,
	params: MaybeRefOrGetter<TaskFilterParams>,
) {
	const query = useQuery(computed(() => ({
		...kanbanQuery(toValue(project), toValue(view), toValue(params)),
		meta: {handlesError: true},
	})))
	const unavailable = computed(() => query.error.value instanceof ApiError &&
		[401, 403, 404].includes(query.error.value.status))
	const dragBuckets = ref<BucketResponse[] | null>(null)
	const buckets = computed(() => unavailable.value ? [] : dragBuckets.value ?? query.data.value?.buckets ?? [])
	function startDrag() {
		if (!unavailable.value) dragBuckets.value = klona(query.data.value?.buckets ?? [])
	}
	function endDrag() { dragBuckets.value = null }
	watch(unavailable, denied => { if (denied) endDrag() }, {flush: 'sync'})
	watch([() => toValue(project), () => toValue(view), () => toValue(params)], endDrag)
	return {...query, buckets, dragBuckets, startDrag, endDrag}
}
