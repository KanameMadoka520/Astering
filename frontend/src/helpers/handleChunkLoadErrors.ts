import {readonly, shallowRef, type DeepReadonly, type ShallowRef} from 'vue'
import type {
	HistoryState,
	Router,
	RouteLocationNormalized,
	RouteLocationRaw,
} from 'vue-router'

import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'
import {getTokenIdentity} from '@/helpers/auth'
import {isChunkLoadError} from './sentryFilters'

type ChunkLoadFailure = {
	id: number
	target: RouteLocationRaw | null
	owner: ClientRequestContext
	retrying: boolean
	retryFailed: boolean
}

const failure = shallowRef<ChunkLoadFailure | null>(null)
export const chunkLoadRecovery: DeepReadonly<ShallowRef<ChunkLoadFailure | null>> = readonly(failure)
let nextFailureId = 0
let uninstall: (() => void) | undefined
let connectRouter: ((router: Router) => void) | undefined

export function dismissChunkLoadRecovery() {
	failure.value = null
}

export function clearStaleChunkLoadRecovery() {
	if (failure.value && !isClientRequestContextCurrent(failure.value.owner)) {
		dismissChunkLoadRecovery()
	}
}

function showFailure(owner: ClientRequestContext, target?: RouteLocationRaw) {
	if (!isClientRequestContextCurrent(owner)) return
	clearStaleChunkLoadRecovery()
	const previous = failure.value
	failure.value = {
		id: previous?.id ?? ++nextFailureId,
		target: target ?? previous?.target ?? null,
		owner,
		retrying: previous?.retrying ?? false,
		retryFailed: previous?.retrying || previous?.retryFailed || false,
	}
}

export async function retryChunkLoadNavigation(router: Router) {
	clearStaleChunkLoadRecovery()
	const attempt = failure.value
	if (!attempt?.target || attempt.retrying || attempt.retryFailed) return
	failure.value = {
		...attempt,
		retrying: true,
		retryFailed: false,
	}
	try {
		// A real push deliberately re-runs the mounted editor's leave and update guards.
		await router.push(attempt.target)
	} catch {
		if (failure.value?.id === attempt.id && isClientRequestContextCurrent(attempt.owner)) {
			failure.value = {...failure.value, retryFailed: true}
		}
	} finally {
		clearStaleChunkLoadRecovery()
		if (failure.value?.id === attempt.id) {
			failure.value = {...failure.value, retrying: false}
		}
	}
}

/** Only called after the user confirms; native beforeunload draft guards remain installed. */
export function reloadAfterChunkFailure() {
	clearStaleChunkLoadRecovery()
	if (failure.value) window.location.reload()
}

export function handleChunkLoadErrors(router?: Router): () => void {
	if (uninstall) {
		if (router) connectRouter?.(router)
		return uninstall
	}

	let activeRouter: Router | undefined
	let removeRouterHooks: (() => void)[] = []
	let navigation = 0
	let latestPreloadError: unknown
	let pendingOwner: ClientRequestContext | undefined
	let lastRouteError: {
		error: unknown
		owner: ClientRequestContext
	} | undefined
	let intent: {
		fullPath: string
		state?: HistoryState
		replace: boolean
		owner: ClientRequestContext
		recovering: boolean
	} | undefined
	const owners = new WeakMap<RouteLocationNormalized, {
		owner: ClientRequestContext
		navigation: number
		target: RouteLocationRaw
		recovering: boolean
	}>()

	connectRouter = nextRouter => {
		if (activeRouter === nextRouter) return
		removeRouterHooks.forEach(remove => remove())
		activeRouter = nextRouter
		const push = nextRouter.push
		const replace = nextRouter.replace
		function rememberIntent(target: RouteLocationRaw, replacing: boolean) {
			intent = {
				fullPath: nextRouter.resolve(target).fullPath,
				state: typeof target === 'object' && target.state ? {...target.state} : undefined,
				replace: replacing || (typeof target === 'object' && target.replace === true),
				owner: captureClientRequestContext(),
				recovering: failure.value?.retrying === true,
			}
		}
		const guardedPush: Router['push'] = target => {
			rememberIntent(target, false)
			return push(target)
		}
		const guardedReplace: Router['replace'] = target => {
			rememberIntent(target, true)
			return replace(target)
		}
		// Normalized routes omit custom state; retaining it preserves task-modal backdrops on retry.
		nextRouter.push = guardedPush
		nextRouter.replace = guardedReplace
		removeRouterHooks = [
			() => {
				if (nextRouter.push === guardedPush) nextRouter.push = push
				if (nextRouter.replace === guardedReplace) nextRouter.replace = replace
			},
			nextRouter.beforeEach(to => {
				clearStaleChunkLoadRecovery()
				const original = intent?.fullPath === to.fullPath ? intent : undefined
				if (original?.recovering && !isClientRequestContextCurrent(original.owner)) return false
				pendingOwner = original?.owner ?? captureClientRequestContext()
				owners.set(to, {
					owner: pendingOwner,
					navigation: ++navigation,
					recovering: original?.recovering ?? false,
					target: original ? {
						path: to.path,
						query: to.query,
						hash: to.hash,
						state: original.state,
						replace: original.replace,
					} : to.fullPath,
				})
			}),
			nextRouter.beforeResolve(to => {
				const attempt = owners.get(to)
				if (attempt?.recovering && !isClientRequestContextCurrent(attempt.owner)) return false
			}),
			nextRouter.onError((error, to) => {
				const attempt = owners.get(to)
				if (!attempt || attempt.navigation !== navigation) {
					if (error === latestPreloadError && !failure.value?.target) dismissChunkLoadRecovery()
					return
				}
				if (error !== latestPreloadError && !isChunkLoadError(error?.message)) return
				lastRouteError = {error, owner: attempt.owner}
				showFailure(attempt.owner, attempt.target)
				intent = undefined
				latestPreloadError = undefined
				pendingOwner = undefined
			}),
			nextRouter.afterEach((to, _from, navigationFailure) => {
				const attempt = owners.get(to)
				if (attempt && attempt.navigation !== navigation) return
				intent = undefined
				latestPreloadError = undefined
				pendingOwner = undefined
				if (navigationFailure) return
				lastRouteError = undefined
				dismissChunkLoadRecovery()
			}),
		]
	}

	function preloadError(event: Event) {
		latestPreloadError = (event as Event & {payload?: unknown}).payload
		showFailure(pendingOwner ?? captureClientRequestContext())
		// Do not preventDefault: Vue Router needs the actual rejected import and its target.
	}

	function unhandledRejection(event: PromiseRejectionEvent) {
		if (!isChunkLoadError(event.reason?.message)) return
		showFailure(lastRouteError && lastRouteError.error === event.reason
			? lastRouteError.owner : captureClientRequestContext())
		event.preventDefault()
	}

	function storageChanged(event: StorageEvent) {
		if (!failure.value) return
		if (event.key === 'API_URL' && event.newValue !== event.oldValue) {
			dismissChunkLoadRecovery()
		} else if (event.key === 'token') {
			const identity = getTokenIdentity(event.newValue)
			const owner = failure.value.owner.identity
			if (identity?.id !== owner?.id || identity?.type !== owner?.type) dismissChunkLoadRecovery()
		}
	}

	window.addEventListener('vite:preloadError', preloadError)
	window.addEventListener('unhandledrejection', unhandledRejection)
	window.addEventListener('storage', storageChanged)
	uninstall = () => {
		window.removeEventListener('vite:preloadError', preloadError)
		window.removeEventListener('unhandledrejection', unhandledRejection)
		window.removeEventListener('storage', storageChanged)
		removeRouterHooks.forEach(remove => remove())
		dismissChunkLoadRecovery()
		uninstall = undefined
		connectRouter = undefined
	}
	if (router) connectRouter(router)
	return uninstall
}
