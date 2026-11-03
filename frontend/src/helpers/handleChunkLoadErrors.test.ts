import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {defineComponent, h} from 'vue'
import {
	createMemoryHistory,
	createRouter,
	onBeforeRouteLeave,
	RouterView,
	type Router,
} from 'vue-router'

const {scope} = vi.hoisted(() => ({
	scope: {
		identity: {id: 1, type: 1},
		authSessionEpoch: 1,
		apiBaseUrl: 'https://tasks.example/api/v2',
	},
}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => ({...scope, identity: {...scope.identity}}),
	isClientRequestContextCurrent: (owner: typeof scope) => owner.identity.id === scope.identity.id
		&& owner.identity.type === scope.identity.type
		&& owner.authSessionEpoch === scope.authSessionEpoch
		&& owner.apiBaseUrl === scope.apiBaseUrl,
}))
vi.mock('@/helpers/auth', () => ({getTokenIdentity: (token: string | null) => token ? JSON.parse(token) : null}))

import {
	chunkLoadRecovery,
	clearStaleChunkLoadRecovery,
	dismissChunkLoadRecovery,
	handleChunkLoadErrors,
	reloadAfterChunkFailure,
	retryChunkLoadNavigation,
} from './handleChunkLoadErrors'

let cleanup: (() => void) | undefined
let wrapper: VueWrapper | undefined
let router: Router
const reload = vi.fn()
const chunkError = () => new TypeError('Failed to fetch dynamically imported module')

function preload(error: unknown = chunkError()) {
	const event = new Event('vite:preloadError', {cancelable: true})
	Object.assign(event, {payload: error})
	window.dispatchEvent(event)
	return event
}

async function setupRouter(loader = vi.fn().mockRejectedValue(chunkError())) {
	let allowLeave = true
	const leave = vi.fn(() => allowLeave)
	const current = defineComponent({
		setup() {
			onBeforeRouteLeave(leave)
			return () => h('textarea', {value: 'unsaved writing'})
		},
	})
	router = createRouter({
		history: createMemoryHistory('/base/'),
		routes: [
			{path: '/', component: current},
			{path: '/target', component: loader},
			{path: '/other', component: {render: () => h('p', 'another page')}},
		],
	})
	cleanup = handleChunkLoadErrors(router)
	await router.push('/')
	wrapper = mount(RouterView, {global: {plugins: [router]}})
	await flushPromises()
	return {
		loader,
		leave,
		block: () => {allowLeave = false},
		allow: () => {allowLeave = true},
	}
}

beforeEach(() => {
	scope.identity = {id: 1, type: 1}
	scope.authSessionEpoch = 1
	scope.apiBaseUrl = 'https://tasks.example/api/v2'
	reload.mockReset()
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: {...window.location, reload},
	})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	cleanup?.()
	cleanup = undefined
})

describe('chunk loading recovery', () => {
	it('keeps the current document after a temporary Vite preload failure', () => {
		cleanup = handleChunkLoadErrors()
		const event = preload()
		expect(reload).not.toHaveBeenCalled()
		expect(event.defaultPrevented).toBe(false)
		expect(chunkLoadRecovery.value?.target).toBeNull()
	})

	it('retries the exact route with query, hash and task-modal state while preserving the mounted draft', async () => {
		const {loader} = await setupRouter()
		await expect(router.push({
			path: '/target',
			query: {sort: 'position:asc'},
			hash: '#section',
			state: {backdropView: '/'},
		})).rejects.toThrow('Failed to fetch')
		expect(wrapper?.get('textarea').element.value).toBe('unsaved writing')
		expect(router.currentRoute.value.path).toBe('/')
		loader.mockResolvedValue({render: () => h('p', 'loaded')})
		await retryChunkLoadNavigation(router)
		await flushPromises()
		expect(loader).toHaveBeenCalledTimes(2)
		expect(router.currentRoute.value.fullPath).toBe('/target?sort=position:asc#section')
		expect(router.options.history.state.backdropView).toBe('/')
		expect(chunkLoadRecovery.value).toBeNull()
		expect(reload).not.toHaveBeenCalled()
	})

	it('still runs the mounted leave guard on retry and keeps the draft when it refuses', async () => {
		const controls = await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		controls.block()
		controls.loader.mockResolvedValue({render: () => h('p', 'loaded')})
		await retryChunkLoadNavigation(router)
		expect(router.currentRoute.value.path).toBe('/')
		expect(wrapper?.get('textarea').element.value).toBe('unsaved writing')
		expect(controls.loader).toHaveBeenCalledOnce()
		expect(controls.leave).toHaveBeenCalledTimes(2)
		expect(chunkLoadRecovery.value?.retrying).toBe(false)
		controls.allow()
		await retryChunkLoadNavigation(router)
		expect(router.currentRoute.value.path).toBe('/target')
	})

	it('associates a Vite rejection with its route even when the message is not recognized', async () => {
		const error = new Error('a dependency download failed')
		await setupRouter(vi.fn(async () => {
			preload(error)
			throw error
		}))
		await expect(router.push('/target')).rejects.toThrow(error)
		expect(chunkLoadRecovery.value?.target).toMatchObject({path: '/target'})
		expect(reload).not.toHaveBeenCalled()
	})

	it('stops offering an ineffective retry after the browser retains the failed module', async () => {
		const {loader} = await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		const id = chunkLoadRecovery.value?.id
		await retryChunkLoadNavigation(router)
		expect(chunkLoadRecovery.value).toMatchObject({id, retrying: false, retryFailed: true})
		await retryChunkLoadNavigation(router)
		expect(loader).toHaveBeenCalledTimes(2)
		expect(router.currentRoute.value.path).toBe('/')
	})

	it('does not start duplicate retries while a request is in flight', async () => {
		const {loader} = await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		let resolve!: (component: object) => void
		loader.mockImplementation(() => new Promise(done => {resolve = done}))
		const pending = retryChunkLoadNavigation(router)
		await flushPromises()
		await retryChunkLoadNavigation(router)
		expect(loader).toHaveBeenCalledTimes(2)
		resolve({render: () => h('p', 'loaded')})
		await pending
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it.each(['account', 'API', 'session'] as const)('does not replay or reload after the %s changes', async kind => {
		const {loader} = await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		if (kind === 'account') scope.identity = {id: 2, type: 1}
		if (kind === 'API') scope.apiBaseUrl = 'https://other.example/api/v2'
		if (kind === 'session') scope.authSessionEpoch++
		await retryChunkLoadNavigation(router)
		reloadAfterChunkFailure()
		expect(loader).toHaveBeenCalledOnce()
		expect(chunkLoadRecovery.value).toBeNull()
		expect(reload).not.toHaveBeenCalled()
	})

	it('ignores a late route failure from the previous identity', async () => {
		let reject!: (cause: unknown) => void
		await setupRouter(vi.fn(() => new Promise((_resolve, fail) => {reject = fail})))
		const pending = router.push('/target')
		await flushPromises()
		scope.authSessionEpoch++
		reject(chunkError())
		await expect(pending).rejects.toThrow('Failed to fetch')
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('does not complete a retry under a different identity after its chunk arrives', async () => {
		const {loader} = await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		let resolve!: (component: object) => void
		loader.mockImplementation(() => new Promise(done => {resolve = done}))
		const pending = retryChunkLoadNavigation(router)
		await flushPromises()
		scope.authSessionEpoch++
		resolve({render: () => h('p', 'loaded')})
		await pending
		expect(router.currentRoute.value.path).toBe('/')
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('drops a late Vite error from a navigation superseded by a successful page', async () => {
		let reject!: (cause: unknown) => void
		const error = chunkError()
		await setupRouter(vi.fn(() => new Promise((_resolve, fail) => {reject = fail})))
		const pending = router.push('/target')
		await flushPromises()
		await router.push('/other')
		preload(error)
		reject(error)
		await expect(pending).rejects.toThrow('Failed to fetch')
		expect(router.currentRoute.value.path).toBe('/other')
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('clears the error after a successful navigation elsewhere', async () => {
		await setupRouter()
		await expect(router.push('/target')).rejects.toThrow('Failed to fetch')
		await router.push('/other')
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('does not swallow unrelated unhandled errors', () => {
		cleanup = handleChunkLoadErrors()
		const event = new Event('unhandledrejection', {cancelable: true})
		Object.assign(event, {reason: new Error('another error')})
		window.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(false)
		expect(chunkLoadRecovery.value).toBeNull()
		Object.assign(event, {reason: chunkError()})
		window.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		expect(chunkLoadRecovery.value).not.toBeNull()
		expect(reload).not.toHaveBeenCalled()
	})

	it('installs hooks once and restores the original push on cleanup', async () => {
		await setupRouter()
		const guardedPush = router.push
		expect(handleChunkLoadErrors(router)).toBe(cleanup)
		expect(router.push).toBe(guardedPush)
		cleanup?.()
		expect(router.push).not.toBe(guardedPush)
		preload()
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('only reloads explicitly and leaves native beforeunload protection installed', () => {
		cleanup = handleChunkLoadErrors()
		const guard = vi.fn((event: Event) => event.preventDefault())
		window.addEventListener('beforeunload', guard)
		preload()
		expect(reload).not.toHaveBeenCalled()
		reloadAfterChunkFailure()
		expect(reload).toHaveBeenCalledOnce()
		const event = new Event('beforeunload', {cancelable: true})
		window.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		window.removeEventListener('beforeunload', guard)
	})

	it('clears after cross-tab account or API changes but keeps same-account token refresh', () => {
		cleanup = handleChunkLoadErrors()
		preload()
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'token',
			newValue: JSON.stringify({id: 1, type: 1}),
		}))
		expect(chunkLoadRecovery.value).not.toBeNull()
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'token',
			newValue: JSON.stringify({id: 2, type: 1}),
		}))
		expect(chunkLoadRecovery.value).toBeNull()
		preload()
		window.dispatchEvent(new StorageEvent('storage', {
			key: 'API_URL',
			oldValue: 'https://tasks.example',
			newValue: 'https://other.example',
		}))
		expect(chunkLoadRecovery.value).toBeNull()
	})

	it('allows stale notices to be dismissed without changing the document', () => {
		cleanup = handleChunkLoadErrors()
		preload()
		dismissChunkLoadRecovery()
		expect(chunkLoadRecovery.value).toBeNull()
		preload()
		scope.authSessionEpoch++
		clearStaleChunkLoadRecovery()
		expect(chunkLoadRecovery.value).toBeNull()
		expect(reload).not.toHaveBeenCalled()
	})
})
