import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver, VueQueryPlugin} from '@tanstack/vue-query'
import {flushPromises, mount} from '@vue/test-utils'
import {nextTick, reactive} from 'vue'
import {createI18n} from 'vue-i18n'

import type {AccountUsageSnapshot, SystemUsageUsersData} from '@/client/generated'
import {captureClientRequestContext} from '@/client/requestContext'
import SiteUsage from '@/views/user/settings/SiteUsage.vue'
import en from '@/i18n/lang/en.json'
import {currentSiteUsageData, siteUsageAccessQuery, siteUsageUsersQuery, type ScopedUsage} from './siteUsage'

const sdk = vi.hoisted(() => ({
	systemUsageAccess: vi.fn(),
	systemUsageUsers: vi.fn(),
}))
const requestContext = vi.hoisted(() => ({
	identity: {id: 1, type: 1} as {id: number, type: number} | null,
	sessionEpoch: 1,
	apiBaseUrl: '/api/v2',
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/helpers/auth', () => ({
	getAuthSessionEpoch: () => requestContext.sessionEpoch,
	getToken: () => null,
	getTokenIdentity: () => requestContext.identity,
}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => requestContext.apiBaseUrl}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => auth}))
vi.mock('@/composables/useTitle', () => ({useTitle: vi.fn()}))

const auth = reactive({
	authUser: true,
	identityKey: '1:1',
	currentSessionId: 'session-A',
})
const cleanups: Array<() => void> = []
const query: NonNullable<SystemUsageUsersData['query']> = {
	page: 1,
	per_page: 25,
	q: '',
	status: 'all',
	role: 'all',
	anomaly: 'all',
	sort_by: 'projects_owned',
	order_by: 'desc',
}

function snapshot(name = 'private-owner-A', page = 1): AccountUsageSnapshot {
	const counts = {
		projects_owned: 1000,
		projects_archived: 2,
		projects_created_24h: 1,
		projects_created_7d: 2,
		tasks_owned: 3,
		tasks_created: 4,
		files_uploaded: 5,
		file_bytes: 700,
		drive_files: 2,
		drive_file_bytes: 500,
		drive_trashed_files: 1,
		drive_trashed_bytes: 100,
		compass_spaces_owned: 1,
		compass_entries_owned: 2,
		ai_conversations: 3,
		ai_conversation_bytes: 40,
		ai_attachment_bytes: 20,
		ai_settings_bytes: 10,
		ai_bytes: 70,
		total_storage_bytes: 770,
	}
	return {
		items: [{
			...counts,
			id: 1,
			username: name,
			name,
			status: 0,
			is_bot: false,
			is_instance_admin: false,
			is_usage_admin: true,
			deletion_scheduled: false,
			created: '2026-01-01T00:00:00Z',
			ai_scan_complete: true,
			anomalies: [],
		}],
		total: 2,
		page,
		per_page: 1,
		total_pages: 2,
		as_of: '2026-11-05T01:00:00Z',
		overview: {
			...counts,
			users: 2,
			active_users: 2,
			flagged_users: 1,
			scanned_users: 2,
			snapshot_complete: true,
			as_of: '2026-11-05T01:00:00Z',
		},
		definitions: [],
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return {promise, resolve, reject}
}

function client() {
	const value = new QueryClient({defaultOptions: {queries: {retry: false}}})
	cleanups.push(() => value.clear())
	return value
}

async function mountPage(value = client()) {
	const view = mount(SiteUsage, {
		attachTo: document.body,
		global: {
			plugins: [
				createI18n({legacy: false, locale: 'en', messages: {en}}),
				[VueQueryPlugin, {queryClient: value}],
			],
		},
	})
	cleanups.push(() => view.unmount())
	await flushPromises()
	return view
}

beforeEach(() => {
	vi.resetAllMocks()
	requestContext.identity = {id: 1, type: 1}
	requestContext.sessionEpoch = 1
	requestContext.apiBaseUrl = '/api/v2'
	auth.authUser = true
	auth.identityKey = '1:1'
	auth.currentSessionId = 'session-A'
	sdk.systemUsageAccess.mockResolvedValue({data: {can_view_usage: true}})
	sdk.systemUsageUsers.mockImplementation(async ({query: selected}) => ({data: snapshot('private-owner-A', selected.page)}))
})

afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup()
	cleanups.length = 0
	document.body.innerHTML = ''
})

describe('site usage query identity fences', () => {
	it('uses SDK query/signal and scopes keys to identity, API and session epoch without a token', async () => {
		const value = client()
		const first = siteUsageUsersQuery(query)
		const result = await value.fetchQuery(first)
		expect(currentSiteUsageData(result)?.items?.[0].username).toBe('private-owner-A')
		expect(sdk.systemUsageUsers).toHaveBeenCalledExactlyOnceWith({query, signal: expect.any(AbortSignal)})
		requestContext.identity = {id: 2, type: 1}
		expect(siteUsageUsersQuery(query).queryKey).not.toEqual(first.queryKey)
		requestContext.identity = {id: 1, type: 1}
		requestContext.sessionEpoch++
		expect(siteUsageUsersQuery(query).queryKey).not.toEqual(first.queryKey)
		requestContext.sessionEpoch = 1
		requestContext.apiBaseUrl = 'https://another.example/api/v2'
		expect(siteUsageUsersQuery(query).queryKey).not.toEqual(first.queryKey)
		expect(currentSiteUsageData(result)).toBeUndefined()
	})

	it('rejects a late SDK response after identity changes', async () => {
		const value = client()
		const gate = deferred<{data: AccountUsageSnapshot}>()
		sdk.systemUsageUsers.mockReturnValue(gate.promise)
		const result = value.fetchQuery(siteUsageUsersQuery(query))
		requestContext.identity = {id: 2, type: 1}
		gate.resolve({data: snapshot()})
		await expect(result).rejects.toMatchObject({name: 'AbortError'})
	})

	it('rejects retained observer data after clear and carries no previous data into another identity', async () => {
		const value = client()
		type Observer = QueryObserver<ScopedUsage<AccountUsageSnapshot>>
		const options = () => siteUsageUsersQuery(query) as unknown as ConstructorParameters<typeof QueryObserver<ScopedUsage<AccountUsageSnapshot>>>[1]
		const observer: Observer = new QueryObserver(value, options())
		const stop = observer.subscribe(() => {})
		cleanups.push(stop)
		await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true))
		expect(currentSiteUsageData(observer.getCurrentResult().data)?.items?.[0].username).toBe('private-owner-A')
		requestContext.identity = {id: 2, type: 1}
		value.clear()
		expect(observer.getCurrentResult().data?.data.items?.[0].username).toBe('private-owner-A')
		expect(currentSiteUsageData(observer.getCurrentResult().data)).toBeUndefined()
		const gate = deferred<{data: AccountUsageSnapshot}>()
		sdk.systemUsageUsers.mockReturnValue(gate.promise)
		observer.setOptions(options())
		expect(observer.getCurrentResult().data).toBeUndefined()
		gate.resolve({data: snapshot('private-owner-B')})
		await vi.waitFor(() => expect(currentSiteUsageData(observer.getCurrentResult().data)?.items?.[0].username).toBe('private-owner-B'))
	})
})

describe('site usage mounted query lifecycle', () => {
	it('labels incomplete AI values as lower bounds and tolerates nullable collection fields', async () => {
		const body = snapshot()
		const account = body.items![0]
		account.ai_scan_complete = false
		account.ai_bytes = 0
		account.ai_conversations = 0
		account.total_storage_bytes = account.file_bytes
		account.anomalies = null
		body.overview.snapshot_complete = false
		body.overview.total_storage_bytes = account.file_bytes
		sdk.systemUsageUsers.mockResolvedValue({data: body})
		const view = await mountPage()
		await vi.waitFor(() => expect(view.find('.usage-account').exists()).toBe(true))
		expect(view.find('.usage-overview').text()).toContain('Incomplete scan')
		expect(view.find('.usage-primary').text()).toContain('≥ 0 B')
		expect(view.find('.usage-flags').exists()).toBe(false)
		sdk.systemUsageUsers.mockResolvedValue({data: {...body, items: null}})
		await view.find('.page-header__actions button').trigger('click')
		await flushPromises()
		expect(view.find('.usage-empty').exists()).toBe(true)
		expect(view.find('.usage-account').exists()).toBe(false)
	})

	it('does not paint seeded private rows while fresh mount permission is pending or revoked', async () => {
		const value = client()
		const context = captureClientRequestContext()
		value.setQueryData(siteUsageAccessQuery(context).queryKey, {context, data: {can_view_usage: true}})
		value.setQueryData(siteUsageUsersQuery(query, context).queryKey, {context, data: snapshot()})
		const gate = deferred<{data: {can_view_usage: boolean}}>()
		sdk.systemUsageAccess.mockReturnValue(gate.promise)
		const view = await mountPage(value)
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(sdk.systemUsageUsers).not.toHaveBeenCalled()
		gate.resolve({data: {can_view_usage: false}})
		await flushPromises()
		expect(view.find('[role="alert"]').text()).toContain('You do not have permission')
		expect(view.find('.usage-account').exists()).toBe(false)
	})

	it('keeps filters and refresh focus during failures and never revives cached rows on filter return', async () => {
		const view = await mountPage()
		await vi.waitFor(() => expect(view.find('.usage-account').text()).toContain('private-owner-A'))
		const selector = view.findAll('select')[0]
		sdk.systemUsageUsers.mockResolvedValue({data: snapshot('private-filter-B')})
		await selector.setValue('disabled')
		await flushPromises()
		expect(view.find('.usage-account').text()).toContain('private-filter-B')
		const gate = deferred<{data: {can_view_usage: boolean}}>()
		sdk.systemUsageAccess.mockReturnValue(gate.promise)
		sdk.systemUsageUsers.mockRejectedValue({status: 403})
		const refresh = view.find('.page-header__actions button')
		;(refresh.element as HTMLButtonElement).focus()
		await refresh.trigger('click')
		expect(refresh.attributes('aria-disabled')).toBe('true')
		expect(refresh.attributes('disabled')).toBeUndefined()
		expect(document.activeElement).toBe(refresh.element)
		expect(view.find('.usage-account').exists()).toBe(false)
		gate.resolve({data: {can_view_usage: true}})
		await flushPromises()
		expect(view.find('[role="alert"]').exists()).toBe(true)
		const search = view.find('input[type="search"]')
		;(search.element as HTMLInputElement).focus()
		expect(document.activeElement).toBe(search.element)
		const denied = deferred<{data: AccountUsageSnapshot}>()
		sdk.systemUsageUsers.mockReturnValue(denied.promise)
		await selector.setValue('all')
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(document.activeElement).toBe(search.element)
		denied.reject({status: 403})
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('input[type="search"]').element).toBe(search.element)
		expect(document.activeElement).toBe(search.element)
	})

	it('hides the prior account immediately through an identity switch with the observer still mounted', async () => {
		const value = client()
		const view = await mountPage(value)
		await vi.waitFor(() => expect(view.find('.usage-account').text()).toContain('private-owner-A'))
		const access = deferred<{data: {can_view_usage: boolean}}>()
		const users = deferred<{data: AccountUsageSnapshot}>()
		sdk.systemUsageAccess.mockReturnValue(access.promise)
		sdk.systemUsageUsers.mockReturnValue(users.promise)
		requestContext.identity = {id: 2, type: 1}
		auth.identityKey = '2:1'
		value.clear()
		await nextTick()
		expect(view.find('.usage-account').exists()).toBe(false)
		access.resolve({data: {can_view_usage: true}})
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(false)
		users.resolve({data: snapshot('private-owner-B')})
		await flushPromises()
		expect(view.find('.usage-account').text()).toContain('private-owner-B')
		expect(view.text()).not.toContain('private-owner-A')
	})

	it('rechecks access on a replacement login for the same account without displaying previous rows', async () => {
		const view = await mountPage()
		await vi.waitFor(() => expect(view.find('.usage-account').text()).toContain('private-owner-A'))
		const access = deferred<{data: {can_view_usage: boolean}}>()
		sdk.systemUsageAccess.mockReturnValue(access.promise)
		requestContext.sessionEpoch++
		auth.currentSessionId = 'session-B'
		await nextTick()
		expect(view.find('.usage-account').exists()).toBe(false)
		await vi.waitFor(() => expect(sdk.systemUsageAccess).toHaveBeenCalledTimes(2))
		access.resolve({data: {can_view_usage: false}})
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('[role="alert"]').text()).toContain('You do not have permission')
	})
})
