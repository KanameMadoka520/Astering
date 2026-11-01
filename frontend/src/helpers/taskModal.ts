import type {RouteLocationNormalizedLoaded, HistoryState} from 'vue-router'

/** Task-to-task links keep the existing board behind a modal; full-page tasks stay full-page. */
export function taskModalNavigationState(route: Pick<RouteLocationNormalizedLoaded, 'name' | 'fullPath'>): HistoryState {
	const backdropView = route.name === 'task.detail' ? window.history.state?.backdropView : route.fullPath
	return typeof backdropView === 'string' ? {backdropView} : {}
}
