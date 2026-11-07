import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {reactive} from 'vue'
import {createI18n} from 'vue-i18n'

import SiteAccounts from './SiteAccounts.vue'
import en from '@/i18n/lang/en.json'
import {captureClientRequestContext} from '@/client/requestContext'
import {
	siteAccountsKeys,
	siteAccountsAccessQuery,
	siteAccountsQuery,
	type ManagedAccount,
	type ManagedAccountsSnapshot,
} from '@/client/queries/siteAccounts'

const sdk = vi.hoisted(() => ({
	systemAccountsAccess: vi.fn(),
	systemAccountsList: vi.fn(),
	systemAccountsEvents: vi.fn(),
	systemAccountsStatus: vi.fn(),
	systemAccountsRevokeAccess: vi.fn(),
}))
const requestContext = vi.hoisted(() => ({
	identity: {id: 1, type: 1},
	epoch: 1,
}))
const auth = reactive({
	authUser: true,
	identityKey: '1:1',
	session: 'session-A',
	currentSessionId: 'session-A',
})
const route = reactive({fullPath: '/user/settings/accounts'})
vi.mock('@/client/generated', () => sdk)
vi.mock('@/helpers/auth', () => ({
	getAuthSessionEpoch: () => requestContext.epoch,
	getToken: () => null,
	getTokenIdentity: () => requestContext.identity,
}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => '/api/v2'}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => auth}))
vi.mock('vue-router', () => ({useRoute: () => route}))
vi.mock('@/composables/useTitle', () => ({useTitle: vi.fn()}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return {
		promise,
		resolve,
		reject,
	}
}

function snapshot(): ManagedAccountsSnapshot {
	const counts = {
		projects_owned: 1,
		projects_archived: 0,
		projects_created_24h: 0,
		projects_created_7d: 0,
		tasks_owned: 1,
		tasks_created: 1,
		files_uploaded: 0,
		file_bytes: 0,
		drive_files: 0,
		drive_file_bytes: 0,
		drive_trashed_files: 0,
		drive_trashed_bytes: 0,
		compass_spaces_owned: 0,
		compass_entries_owned: 0,
		ai_conversations: 0,
		ai_conversation_bytes: 0,
		ai_attachment_bytes: 0,
		ai_settings_bytes: 0,
		ai_bytes: 0,
		total_storage_bytes: 0,
	}
	const account: ManagedAccount = {
		...counts,
		id: 2,
		username: 'managed-member',
		name: 'Member',
		status: 0,
		is_bot: false,
		is_instance_admin: false,
		is_usage_admin: false,
		is_superadmin: false,
		is_protected: false,
		can_change_status: true,
		can_revoke_access: true,
		protected_reason: '',
		deletion_scheduled: false,
		created: '2026-01-01T00:00:00Z',
		ai_scan_complete: true,
		anomalies: [],
		sessions: 1,
		api_tokens: 0,
		bots: 0,
	}
	return {
		items: [account],
		total: 1,
		page: 1,
		per_page: 25,
		total_pages: 1,
		as_of: '2026-11-07T00:00:00Z',
		overview: {
			...counts,
			users: 1,
			active_users: 1,
			flagged_users: 0,
			scanned_users: 1,
			snapshot_complete: true,
			as_of: '2026-11-07T00:00:00Z',
		},
		definitions: [],
	}
}

function events(page = 1) {
	return {
		items: [{
			id: page,
			actor_id: 1,
			actor_username: 'superadmin',
			target_id: 2,
			target_username: `private-event-page-${page}`,
			action: 'access_revoked',
			old_status: 0,
			new_status: 0,
			revoked_sessions: 1,
			revoked_api_tokens: 0,
			reason: '',
			created: '2026-11-07T00:00:00Z',
		}],
		page,
		per_page: 1,
		total: 2,
		total_pages: 2,
	}
}

const cleanups: Array<() => void> = []
async function mountPage(options: {client?: QueryClient, waitForRows?: boolean} = {}) {
	const client = options.client ?? new QueryClient({defaultOptions: {queries: {retry: false}}})
	const view = mount(SiteAccounts, {
		attachTo: document.body,
		global: {
			plugins: [
				createI18n({legacy: false, locale: 'en', messages: {en}}),
				[VueQueryPlugin, {queryClient: client}],
			],
			stubs: {Icon: true},
		},
	})
	cleanups.push(() => {
		view.unmount()
		client.clear()
	})
	await flushPromises()
	if (options.waitForRows !== false) await vi.waitFor(() => expect(view.find('.usage-account').exists()).toBe(true))
	return {
		client,
		view,
	}
}

function button(view: VueWrapper, label: string) {
	return view.findAll('button').find(item => item.text() === label)!
}
function dialog() { return document.querySelector<HTMLDialogElement>('dialog.account-management-dialog')! }
async function openConfirmation(view: VueWrapper) {
	await button(view, 'Disable account').trigger('click')
	await flushPromises()
	const input = dialog().querySelector<HTMLInputElement>('input')!
	input.value = 'managed-member'
	input.dispatchEvent(new Event('input', {bubbles: true}))
	await flushPromises()
	return dialog()
}
async function openEvents(view: VueWrapper) {
	await button(view, 'Management activity').trigger('click')
	await flushPromises()
	expect(view.find('.account-events').text()).toContain('private-event-page-1')
}

beforeEach(() => {
	vi.resetAllMocks()
	requestContext.identity = {id: 1, type: 1}
	requestContext.epoch = 1
	auth.identityKey = '1:1'
	auth.session = auth.currentSessionId = 'session-A'
	sdk.systemAccountsAccess.mockResolvedValue({data: {can_manage_accounts: true, current_user_id: 1}})
	sdk.systemAccountsList.mockResolvedValue({data: snapshot()})
	sdk.systemAccountsEvents.mockImplementation(async ({query}) => ({data: events(query.page)}))
	sdk.systemAccountsStatus.mockResolvedValue({
		data: {
			user_id: 2,
			status: 2,
			revoked_sessions: 1,
			revoked_api_tokens: 0,
			event_id: 1,
		},
	})
})

afterEach(() => {
	for (const cleanup of cleanups.reverse()) cleanup()
	cleanups.length = 0
	document.body.innerHTML = ''
})

describe('account management delayed reads and keyboard state', () => {
	it('confirms a successful write without waiting for the follow-up list read', async () => {
		const {view} = await mountPage()
		const confirmation = await openConfirmation(view)
		const gate = deferred<{data: ManagedAccountsSnapshot}>()
		sdk.systemAccountsList.mockReturnValue(gate.promise)
		confirmation.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
		await flushPromises()
		expect(sdk.systemAccountsStatus).toHaveBeenCalledTimes(1)
		expect(dialog()).toBeNull()
		expect(view.find('.message.success').text()).toContain('completed')
		expect(view.find('.usage-account').exists()).toBe(false)
		gate.resolve({data: snapshot()})
	})

	it('keeps a verified confirmation and caret through a focus access recheck, but blocks a second write', async () => {
		const {view, client} = await mountPage()
		const confirmation = await openConfirmation(view)
		const reason = confirmation.querySelector('textarea')!
		reason.value = 'Keep my draft'
		reason.dispatchEvent(new Event('input', {bubbles: true}))
		reason.focus()
		reason.setSelectionRange(3, 7)
		const gate = deferred<{data: {can_manage_accounts: boolean, current_user_id: number}}>()
		sdk.systemAccountsAccess.mockReturnValue(gate.promise)
		const recheck = client.invalidateQueries({queryKey: siteAccountsKeys.access(captureClientRequestContext())})
		await flushPromises()
		expect(dialog()).toBe(confirmation)
		expect(document.activeElement).toBe(reason)
		expect(reason.selectionStart).toBe(3)
		expect(reason.selectionEnd).toBe(7)
		confirmation.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
		await flushPromises()
		expect(sdk.systemAccountsStatus).not.toHaveBeenCalled()
		gate.resolve({data: {can_manage_accounts: true, current_user_id: 1}})
		await recheck
	})

	it('preserves the audit pagination button while the next page is pending and at its boundary', async () => {
		const {view} = await mountPage()
		await openEvents(view)
		const next = view.findAll('.account-event-pages button')[1]
		const element = next.element as HTMLButtonElement
		element.focus()
		const gate = deferred<{data: ReturnType<typeof events>}>()
		sdk.systemAccountsEvents.mockReturnValue(gate.promise)
		await next.trigger('click')
		await flushPromises()
		expect(element.isConnected).toBe(true)
		expect(document.activeElement).toBe(element)
		expect(element.getAttribute('aria-disabled')).toBe('true')
		expect(view.find('.account-events').exists()).toBe(false)
		gate.resolve({data: events(2)})
		await flushPromises()
		expect(document.activeElement).toBe(element)
		expect(element.disabled).toBe(false)
		expect(element.getAttribute('aria-disabled')).toBe('true')
		expect(view.find('.account-events').text()).toContain('private-event-page-2')
	})

	it('keeps form fields focusable and immutable while a write is pending, then preserves the failed draft', async () => {
		const {view} = await mountPage()
		const confirmation = await openConfirmation(view)
		const gate = deferred<never>()
		sdk.systemAccountsStatus.mockReturnValue(gate.promise)
		const input = confirmation.querySelector<HTMLInputElement>('input')!
		input.focus()
		confirmation.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
		await flushPromises()
		expect(input.disabled).toBe(false)
		expect(input.readOnly).toBe(true)
		expect(confirmation.querySelector('textarea')!.readOnly).toBe(true)
		expect(Array.from(confirmation.querySelectorAll<HTMLButtonElement>('form button')).every(item => !item.disabled)).toBe(true)
		gate.reject({status: 409, detail: 'account_status_changed'})
		await flushPromises()
		expect(document.activeElement).toBe(input)
		expect(input.value).toBe('managed-member')
		expect(input.readOnly).toBe(false)
		expect(confirmation.querySelector('[role="alert"]')!.textContent).toContain('account changed')
	})
})

describe('management denial hides every private presentation', () => {
	it('does not trust a cached grant on first entry while a fresh authorization is pending', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		await client.fetchQuery(siteAccountsAccessQuery())
		const gate = deferred<{data: {can_manage_accounts: boolean, current_user_id: number}}>()
		sdk.systemAccountsAccess.mockReturnValue(gate.promise)
		const {view} = await mountPage({client, waitForRows: false})
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('.account-audit').exists()).toBe(false)
		expect(sdk.systemAccountsList).not.toHaveBeenCalled()
		gate.resolve({data: {can_manage_accounts: false, current_user_id: 1}})
		await flushPromises()
		expect(view.find('[role="alert"]').text()).toContain('super administrator')
	})

	it('clears an open confirmation and already-loaded audit when the account list returns 403', async () => {
		const {view, client} = await mountPage()
		await openEvents(view)
		await openConfirmation(view)
		sdk.systemAccountsList.mockRejectedValue({status: 403})
		await client.invalidateQueries({queryKey: ['site-accounts', 'users']})
		await flushPromises()
		expect(dialog()).toBeNull()
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('.account-audit').exists()).toBe(false)
	})

	it('hides account rows as well as old events when the audit endpoint returns 403', async () => {
		const {view, client} = await mountPage()
		await openEvents(view)
		sdk.systemAccountsEvents.mockRejectedValue({status: 403})
		await client.invalidateQueries({queryKey: ['site-accounts', 'events']})
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('.account-audit').exists()).toBe(false)
		expect(view.text()).not.toContain('private-event-page-1')
	})

	it('does not treat an ordinary read failure as revocation and supports a fresh retry', async () => {
		const {view, client} = await mountPage()
		sdk.systemAccountsList.mockRejectedValue({status: 500})
		await client.invalidateQueries({queryKey: ['site-accounts', 'users']})
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(false)
		expect(view.find('.account-audit').exists()).toBe(true)
		sdk.systemAccountsList.mockResolvedValue({data: snapshot()})
		await button(view, 'Refresh snapshot').trigger('click')
		await flushPromises()
		expect(view.find('.usage-account').exists()).toBe(true)
	})

	it('allows a fresh access check after revocation while an earlier account read is still pending', async () => {
		const {view, client} = await mountPage()
		await openEvents(view)
		const gate = deferred<{data: ManagedAccountsSnapshot}>()
		sdk.systemAccountsList.mockReturnValue(gate.promise)
		const refreshing = client.invalidateQueries({queryKey: ['site-accounts', 'users']})
		await flushPromises()
		sdk.systemAccountsEvents.mockRejectedValue({status: 403})
		await client.invalidateQueries({queryKey: ['site-accounts', 'events']})
		await flushPromises()
		const refresh = button(view, 'Refresh snapshot')
		const paused = refresh.attributes('aria-disabled')
		await refresh.trigger('click')
		await flushPromises()
		const accessChecks = sdk.systemAccountsAccess.mock.calls.length
		gate.resolve({data: snapshot()})
		await refreshing
		await flushPromises()
		expect(paused).toBeUndefined()
		expect(accessChecks).toBe(2)
	})

	it('does not change a replacement account grant when an old account read rejects with 403', async () => {
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		cleanups.push(() => client.clear())
		const gate = deferred<never>()
		sdk.systemAccountsList.mockReturnValue(gate.promise)
		const result = client.fetchQuery(siteAccountsQuery({page: 1}))
		const rejected = expect(result).rejects.toMatchObject({status: 403})
		requestContext.identity = {id: 3, type: 1}
		const context = captureClientRequestContext()
		client.setQueryData(siteAccountsKeys.access(context), {
			context,
			data: {can_manage_accounts: true, current_user_id: 3},
		})
		gate.reject({status: 403})
		await rejected
		expect(client.getQueryData(siteAccountsKeys.access(context))).toMatchObject({
			data: {can_manage_accounts: true, current_user_id: 3},
		})
	})
})
