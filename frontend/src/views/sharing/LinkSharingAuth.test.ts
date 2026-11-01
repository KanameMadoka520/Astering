import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	authLinkShare: vi.fn(),
	tasksRead: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', async importOriginal => ({...await importOriginal<object>(), success: vi.fn(), error: vi.fn()}))

import LinkSharingAuth from './LinkSharingAuth.vue'
import XButton from '@/components/input/Button.vue'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {LINK_SHARE_HASH_PREFIX} from '@/constants/linkShareHash'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined
let router: Router

const SHARED_PROJECT = 3
const SHARE_HASH = `${LINK_SHARE_HASH_PREFIX}abc`

function linkShareToken(extra: Record<string, unknown> = {}) {
	const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	const now = Math.floor(Date.now() / 1000)
	return `${encode({alg: 'HS256'})}.${encode({id: 5, type: AUTH_TYPES.LINK_SHARE, exp: now + 3600, iat: now, hash: 'abc', project_id: SHARED_PROJECT, ...extra})}.signature`
}

function saveLastVisited(name: string, params: Record<string, string>) {
	localStorage.setItem('lastVisited', JSON.stringify({name, params, query: {}}))
}

beforeAll(() => {
	queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
})

afterAll(() => {
	queryClient.setDefaultOptions(defaults)
})

beforeEach(() => {
	vi.resetAllMocks()
	localStorage.clear()
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.authLinkShare.mockResolvedValue({data: {token: linkShareToken(), project_id: SHARED_PROJECT}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	localStorage.clear()
})

async function mountAuth(path = '/share/abc/auth') {
	const page = {template: '<div />'}
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{path: '/', name: 'home', component: page},
			{path: '/share/:share/auth', name: 'link-share.auth', component: LinkSharingAuth},
			{path: '/projects/:projectId', name: 'project.index', component: page},
			{path: '/projects/:projectId/:viewId', name: 'project.view', component: page},
			{path: '/tasks/:id', name: 'task.detail', component: page},
		],
	})
	await router.push(path)
	await router.isReady()
	wrapper = mount(LinkSharingAuth, {
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton},
			directives: {focus: {}, cy: {}},
			stubs: {Icon: true},
		},
	})
	await flushPromises()
	return wrapper
}

function current() {
	const {name, params, hash} = router.currentRoute.value
	return {name, params, hash}
}

describe('LinkSharingAuth: where the link leads', () => {
	it('opens the shared project, not a page saved from an earlier visit to another project', async () => {
		saveLastVisited('project.view', {projectId: '9', viewId: '2'})
		await mountAuth('/share/abc/auth?view=7')

		expect(current()).toEqual({name: 'project.view', params: {projectId: String(SHARED_PROJECT), viewId: '7'}, hash: SHARE_HASH})
		expect(localStorage.getItem('lastVisited')).toBeNull()
	})

	it('returns to a saved page inside the shared project', async () => {
		saveLastVisited('project.view', {projectId: String(SHARED_PROJECT), viewId: '4'})
		await mountAuth()

		expect(current()).toEqual({name: 'project.view', params: {projectId: String(SHARED_PROJECT), viewId: '4'}, hash: SHARE_HASH})
	})

	it('returns to a saved task when it is in the shared project', async () => {
		saveLastVisited('task.detail', {id: '12'})
		sdk.tasksRead.mockResolvedValue({data: {id: 12, project_id: SHARED_PROJECT}})
		await mountAuth()

		expect(current()).toEqual({name: 'task.detail', params: {id: '12'}, hash: SHARE_HASH})
	})

	it('drops a saved task from another project', async () => {
		saveLastVisited('task.detail', {id: '12'})
		sdk.tasksRead.mockResolvedValue({data: {id: 12, project_id: 8}})
		await mountAuth()

		expect(current()).toEqual({name: 'project.index', params: {projectId: String(SHARED_PROJECT)}, hash: SHARE_HASH})
	})

	it('sends a tab already signed in to this link back to its project', async () => {
		const authStore = useAuthStore()
		authStore.setSession({id: 5, type: AUTH_TYPES.LINK_SHARE, exp: 0, hash: 'abc', project_id: SHARED_PROJECT} as Parameters<typeof authStore.setSession>[0])
		authStore.setAuthenticated(true)
		await mountAuth()

		expect(sdk.authLinkShare).not.toHaveBeenCalled()
		expect(current()).toEqual({name: 'project.index', params: {projectId: String(SHARED_PROJECT)}, hash: SHARE_HASH})
	})
})

describe('LinkSharingAuth: when it fails', () => {
	it('says plainly that a deleted link no longer works', async () => {
		sdk.authLinkShare.mockRejectedValue({status: 404, code: 3006, detail: 'The project share does not exist.'})
		await mountAuth()

		expect(wrapper!.text()).toContain('This link doesn\'t work anymore. Ask the person who shared it for a new one.')
		expect(wrapper!.text()).not.toContain('The project share does not exist.')
		expect(wrapper!.findAll('button').some(button => button.text() === 'Retry')).toBe(false)
	})

	it('offers to try again when the server can\'t be reached', async () => {
		sdk.authLinkShare.mockRejectedValueOnce(new TypeError('Failed to fetch'))
		await mountAuth()

		expect(wrapper!.text()).toContain('The shared project couldn\'t be opened right now. Check your connection and try again.')
		const retry = wrapper!.findAll('button').find(button => button.text() === 'Retry')
		expect(retry).toBeDefined()

		await retry!.trigger('click')
		await flushPromises()
		expect(sdk.authLinkShare).toHaveBeenCalledTimes(2)
		expect(current().name).toBe('project.index')
	})

	it('still asks for the password of a protected link', async () => {
		sdk.authLinkShare.mockRejectedValue({status: 403, code: 13001})
		await mountAuth()

		expect(wrapper!.find('input[type="password"]').exists()).toBe(true)
	})
})
