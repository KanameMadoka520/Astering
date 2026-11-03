import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {reactive} from 'vue'
import {createMemoryHistory, createRouter} from 'vue-router'

const {scope} = vi.hoisted(() => ({scope: {epoch: 1}}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => ({authSessionEpoch: scope.epoch}),
	isClientRequestContextCurrent: (owner: {authSessionEpoch: number}) => owner.authSessionEpoch === scope.epoch,
}))
vi.mock('@/helpers/auth', () => ({getTokenIdentity: () => null}))
vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => auth}))
import ChunkLoadRecovery from './ChunkLoadRecovery.vue'
import {chunkLoadRecovery, handleChunkLoadErrors} from '@/helpers/handleChunkLoadErrors'

const auth = reactive({session: {id: 1}, authenticated: true})
let cleanup: (() => void) | undefined
let wrapper: VueWrapper | undefined
const reload = vi.fn()

beforeEach(() => {
	scope.epoch = 1
	auth.session = {id: 1}
	auth.authenticated = true
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

async function openNotice() {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{path: '/', component: {render: () => null}}],
	})
	cleanup = handleChunkLoadErrors(router)
	await router.push('/')
	wrapper = mount(ChunkLoadRecovery, {global: {plugins: [router], stubs: {Icon: true}}})
	window.dispatchEvent(new Event('vite:preloadError'))
	await flushPromises()
	return wrapper
}

describe('ChunkLoadRecovery', () => {
	it('preserves the page and asks explicitly before refreshing', async () => {
		const notice = await openNotice()
		expect(notice.find('[role="alert"]').exists()).toBe(true)
		expect(notice.text()).toContain('loadingError.chunkNoTarget')
		expect(reload).not.toHaveBeenCalled()
		await notice.get('button.is-outlined').trigger('click')
		expect(notice.text()).toContain('loadingError.reloadWarning')
		expect(reload).not.toHaveBeenCalled()
		await notice.get('button.is-primary').trigger('click')
		expect(reload).toHaveBeenCalledOnce()
	})

	it('lets users keep working or dismiss without reloading', async () => {
		const notice = await openNotice()
		await notice.get('button.is-outlined').trigger('click')
		await notice.get('button.is-outlined').trigger('click')
		expect(notice.text()).not.toContain('loadingError.reloadWarning')
		await notice.get('button.is-text').trigger('click')
		expect(notice.find('[role="alert"]').exists()).toBe(false)
		expect(reload).not.toHaveBeenCalled()
	})

	it('clears immediately on logout even when the same account logs back in in the same tick', async () => {
		await openNotice()
		scope.epoch++
		auth.authenticated = false
		auth.authenticated = true
		expect(chunkLoadRecovery.value).toBeNull()
		await flushPromises()
		expect(wrapper?.find('[role="alert"]').exists()).toBe(false)
	})
})
