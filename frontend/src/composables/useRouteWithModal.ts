import {computed, h, onScopeDispose, shallowRef, watch, type VNode} from 'vue'
import {RouterView, useRoute, useRouter, type RouteLocationNormalizedGeneric, type RouteRecordNormalized} from 'vue-router'
import {useBaseStore} from '@/stores/base'
import {useProjects} from '@/composables/useProjects'

function displayedRecord(route: Pick<RouteLocationNormalizedGeneric, 'matched'>) {
	const record = [...route.matched].reverse().find(record => record.components?.default)
	return record?.aliasOf ?? record
}

export function useRouteWithModal() {
	const router = useRouter()
	const route = useRoute()
	const modalLocation = shallowRef<{record: RouteRecordNormalized, backdrop: string}>()
	const backdropView = computed(() => modalLocation.value?.backdrop)
	const baseStore = useBaseStore()
	const projectList = useProjects()

	let poppedEntry: {path: string, position: unknown} | undefined
	// Browser back/forward must honor that history entry, including an intentional full-page task.
	// The entry identity also distinguishes a later programmatic push after a cancelled browser back.
	onScopeDispose(router.options.history.listen(path => {
		poppedEntry = {path, position: window.history.state?.position}
	}))

	watch(() => route.fullPath, () => {
		const state = window.history.state
		const isPop = poppedEntry?.path === route.fullPath && poppedEntry.position === state?.position
		const record = displayedRecord(route)
		const inherited = !isPop && state?.backdropView === undefined && record?.name === 'task.detail'
			&& modalLocation.value?.record === record
		const candidate = inherited ? modalLocation.value?.backdrop : state?.backdropView
		const backdrop = typeof candidate === 'string' ? router.resolve(candidate) : undefined
		// A task behind another task would register two instances and two sets of guards on the same record.
		// Old task-to-task history entries fall back to the normal full-page task instead.
		if (!record || !backdrop || !displayedRecord(backdrop) || displayedRecord(backdrop) === record) {
			modalLocation.value = undefined
			return
		}
		modalLocation.value = {record, backdrop: candidate}
		// Hash/query links and a confirmed guard's replay omit custom state. Keep the active task modal's
		// original board across those task navigations, retaining Vue Router's own history data. Explicit
		// backdropView: null, another page, or a browser history entry always keeps its own presentation.
		if (inherited) window.history.replaceState({...state, backdropView: candidate}, '')
	}, {immediate: true, flush: 'sync'})

	const routeWithModal = computed(() => backdropView.value
		? router.resolve(backdropView.value) as RouteLocationNormalizedGeneric
		: route)

	// RouterView supplies matchedRouteKey and owns the route instance and guard lifecycle. A manually
	// rendered task component outside RouterView silently skips its composition navigation guards.
	const currentModal = computed<VNode | undefined>(() => backdropView.value
		? h(RouterView, {backdropView: backdropView.value})
		: undefined)

	const historyState = computed(() => route.fullPath ? window.history.state : undefined)

	function closeModal() {
		// If the current project was changed because the user moved the currently opened task while coming from kanban,
		// we need to reflect that change in the route when they close the task modal.
		// The last route is only available as resolved string, therefore we need to use a regex for matching here
		const routeMatch = new RegExp('\\/projects\\/\\d+\\/(\\d+)', 'g')
		const match = historyState.value?.back
			? routeMatch.exec(historyState.value.back)
			: null
		if (match !== null && baseStore.currentProjectId !== 0) {
			let viewId: string | number | undefined = match[1]

			if (!viewId) {
				const project = projectList.projects[baseStore.currentProjectId]
				viewId = project?.views?.[0]?.id
			}

			// Only navigate if we have a valid project and view
			if (viewId) {
				// Preserve query parameters (e.g., date range) from the backdrop view
				const backdropRoute = historyState.value?.backdropView && router.resolve(historyState.value.backdropView)
				const newRoute = {
					name: 'project.view',
					params: {
						projectId: baseStore.currentProjectId,
						viewId,
					},
					query: backdropRoute?.query || {},
				}

				router.push(newRoute)
				return
			}
		}

		// Try browser history first
		if (historyState.value?.back) {
			router.back()
			return
		}

		// Try backdrop view
		const backdropRoute = historyState.value?.backdropView && router.resolve(historyState.value.backdropView)
		if (backdropRoute && backdropRoute.params?.projectId !== '0') {
			router.push(backdropRoute)
			return
		}

		// Fallback to current project or home
		if (baseStore.currentProjectId !== 0) {
			router.push({
				name: 'project.index',
				params: {projectId: baseStore.currentProjectId},
			})
		} else {
			router.push({ name: 'home' })
		}
	}

	return {routeWithModal, currentModal, closeModal}
}
