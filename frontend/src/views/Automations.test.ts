import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {reactive, defineComponent} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	automationList: vi.fn(),
	automationRead: vi.fn(),
	automationRuns: vi.fn(),
	automationCreate: vi.fn(),
	automationUpdate: vi.fn(),
	automationDelete: vi.fn(),
	automationRun: vi.fn(),
	tcyAiSettings: vi.fn(() => new Promise(() => undefined)),
}))
const stores = vi.hoisted(() => ({auth: undefined as unknown}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/stores/auth', () => ({useAuthStore: () => stores.auth}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import {removeToken, saveToken} from '@/helpers/auth'
import {profileOptions} from '@/helpers/assistantProfiles'
import {automationKeys, type Automation, type AutomationRun} from '@/client/queries/automations'
import {ApiError} from '@/client/problem'
import AutomationEditor from '@/components/ai/AutomationEditor.vue'
import Automations from './Automations.vue'

enableAutoUnmount(afterEach)

type Session = {
	id: number
	type: number
	sid: string
	exp: number
}

const active = (): Automation => ({
	id: 'automation-one',
	revision: 1,
	title: 'A daily plan',
	prompt: 'Review my open tasks',
	kind: 'agent',
	enabled: true,
	timezone: 'UTC',
	schedule: {
		kind: 'daily',
		time: '09:00',
	},
	options: profileOptions('assist'),
	notify_on_success: true,
	notify_on_failure: true,
	max_runtime_seconds: 3600,
})

// Render the real editor draft while avoiding browser dialog APIs in happy-dom.
const Modal = defineComponent({template: '<div><slot /><slot name="header" /><slot name="text" /></div>'})
const PageHeader = defineComponent({template: '<header><slot name="actions" /></header>'})

describe('automation editor ownership', () => {
	let client: QueryClient
	let auth: {
		session: Session
		settings: {timezone: string}
	}
	let originalAPI: string

	function setSession(session: Session) {
		saveToken(`header.${btoa(JSON.stringify(session))}.signature`, false)
		auth.session = session
	}
	async function openPage(runs: AutomationRun[] = []) {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{
				path: '/automations/:automationId?',
				name: 'automations',
				component: {render: () => null},
			}],
		})
		await router.push('/automations/automation-one')
		client.setQueryData(automationKeys.list(1), {
			items: [active()],
			page: 1,
			total: 1,
			total_pages: 1,
		})
		client.setQueryData(automationKeys.detail('automation-one'), active())
		client.setQueryData(automationKeys.runPage('automation-one', 1), {
			items: runs,
			page: 1,
			total: runs.length,
			total_pages: 1,
		})
		const wrapper = mount(Automations, {
			global: {
				plugins: [router, [VueQueryPlugin, {queryClient: client}]],
				stubs: {
					Modal,
					PageHeader,
					Icon: true,
					ToolModuleControls: true,
					MCPSessionPicker: true,
					AssistantPreferences: true,
					EmptyState: true,
					LoadError: true,
				},
			},
		})
		await flushPromises()
		return wrapper
	}
	const button = (wrapper: Awaited<ReturnType<typeof openPage>>, key: string) => wrapper.findAll('button')
		.find(candidate => candidate.text() === key)!

	beforeEach(() => {
		originalAPI = window.API_URL
		window.API_URL = 'https://first.example'
		removeToken()
		auth = reactive({
			session: {
				id: 1,
				type: 1,
				sid: 'session-one',
				exp: 1_900_000_000,
			},
			settings: {timezone: 'UTC'},
		})
		stores.auth = auth
		setSession({...auth.session})
		client = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: Infinity,
				},
			},
		})
		sdk.automationList.mockReset().mockResolvedValue({data: {
			items: [active()],
			total: 1,
			total_pages: 1,
		}})
		sdk.automationRead.mockReset().mockResolvedValue({data: active()})
		sdk.automationRuns.mockReset().mockResolvedValue({data: {
			items: [],
			total: 0,
			total_pages: 1,
		}})
		sdk.automationRun.mockReset().mockRejectedValue(new Error('Connection closed after sending'))
		sdk.automationCreate.mockReset()
	})
	afterEach(() => {
		client.clear()
		window.API_URL = originalAPI
		removeToken()
	})

	it('retains typed automation instructions through a same-session JWT renewal', async () => {
		const wrapper = await openPage()
		await button(wrapper, 'menu.edit').trigger('click')
		await wrapper.get('textarea').setValue('Keep this carefully written, unsaved instruction')
		setSession({...auth.session, exp: auth.session.exp + 900})
		await flushPromises()

		expect(wrapper.findComponent(AutomationEditor).exists()).toBe(true)
		expect(wrapper.get('textarea').element).toHaveProperty('value', 'Keep this carefully written, unsaved instruction')
	})

	it('reuses an uncertain run request ID after a same-session JWT renewal', async () => {
		const wrapper = await openPage()
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()
		expect(sdk.automationRun).toHaveBeenCalledTimes(1)
		setSession({...auth.session, exp: auth.session.exp + 900})
		await flushPromises()
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()

		expect(sdk.automationRun).toHaveBeenCalledTimes(2)
		expect(sdk.automationRun.mock.calls[1][0].body.request_id)
			.toBe(sdk.automationRun.mock.calls[0][0].body.request_id)
	})

	it('does not offer a new editor while a background-run submission is still pending', async () => {
		sdk.automationRun.mockReturnValueOnce(new Promise(() => undefined))
		const wrapper = await openPage()
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()
		await button(wrapper, 'automations.create').trigger('click')

		expect(wrapper.findComponent(AutomationEditor).exists()).toBe(false)
	})

	it('does not show cached private details after changing accounts while the new read is pending', async () => {
		const wrapper = await openPage()
		expect(wrapper.get('.automation-detail h2').text()).toBe('A daily plan')
		sdk.automationRead.mockReturnValueOnce(new Promise(() => undefined))
		sdk.automationList.mockReturnValueOnce(new Promise(() => undefined))
		sdk.automationRuns.mockReturnValueOnce(new Promise(() => undefined))
		setSession({...auth.session, id: 2, sid: 'session-two'})
		await flushPromises()

		expect(wrapper.find('.automation-detail h2').exists()).toBe(false)
		expect(wrapper.text()).not.toContain('A daily plan')
	})

	it('does not reopen or navigate after a save finishes after its editor was closed', async () => {
		let finish!: (result: unknown) => void
		sdk.automationCreate.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
		const wrapper = await openPage()
		await button(wrapper, 'automations.create').trigger('click')
		await wrapper.get('.automation-editor input[autocomplete="off"]').setValue('A plan saved after closing')
		await wrapper.get('.automation-editor textarea').setValue('Read only')
		await wrapper.get('.automation-editor form, form.automation-editor').trigger('submit')
		await flushPromises()
		expect(sdk.automationCreate).toHaveBeenCalledTimes(1)
		expect(wrapper.text()).toContain('automations.savingCanClose')
		await button(wrapper, 'misc.cancel').trigger('click')
		expect(wrapper.findComponent(AutomationEditor).exists()).toBe(false)
		finish({data: {...active(), id: 'saved-after-closing'}})
		await flushPromises()

		expect(wrapper.findComponent(AutomationEditor).exists()).toBe(false)
		expect(wrapper.vm.$route.fullPath).toBe('/automations/automation-one')
	})

	it.each(['none', 'sent', 'failed', 'unknown', undefined] as const)(
		'shows the separate %s notification receipt instead of claiming device delivery',
		async notificationStatus => {
			const wrapper = await openPage([{
				id: 'run-notice',
				status: 'succeeded',
				trigger: 'manual',
				automation_revision: 1,
				notification_status: notificationStatus,
			}])
			expect(wrapper.get('.automation-notification').text())
				.toBe(`automations.notifications.${notificationStatus ?? 'unknown'}`)
			expect(wrapper.text()).not.toContain('automations.reminderDelivered')
		},
	)

	it.each(['MODEL_NOT_CONFIGURED', 'UNRECOGNIZED_FUTURE_CODE'])(
		'localizes run error %s without rendering upstream wording',
		async code => {
			const wrapper = await openPage([{
				id: 'run-error',
				status: 'failed',
				trigger: 'manual',
				automation_revision: 1,
				error_code: code,
				error: 'Original upstream English response',
			}])
			expect(wrapper.get('.automation-run').text())
				.toContain(`automations.errors.${code === 'MODEL_NOT_CONFIGURED' ? code : 'unknown'}`)
			expect(wrapper.get('.automation-run code').text()).toContain(code)
			expect(wrapper.text()).not.toContain('Original upstream English response')
		},
	)

	it.each([
		['automation_run_receipt_expired', 'receiptExpired'],
		['automation_limit', 'limitReached'],
		['automation_running_or_scheduler_busy', 'schedulerBusy'],
		['unrecognized_conflict_detail', 'conflict'],
	])('explains a conflicting run request %s without exposing its raw detail', async (detail, key) => {
		sdk.automationRun.mockRejectedValueOnce(new ApiError({
			status: 409,
			detail,
		}))
		const wrapper = await openPage()
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()
		expect(wrapper.get('.automation-detail > .automations-error').text()).toBe(`automations.${key}`)
		expect(wrapper.text()).not.toContain(detail)
	})

	it.each(['session', 'server'])('clears the previous editor and uncertain request ID after a %s change', async change => {
		const wrapper = await openPage()
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()
		await button(wrapper, 'menu.edit').trigger('click')
		await wrapper.get('textarea').setValue('Private draft for the previous account context')
		if (change === 'server') window.API_URL = 'https://second.example'
		setSession({...auth.session, sid: change === 'session' ? 'session-two' : auth.session.sid})
		await flushPromises()

		expect(wrapper.findComponent(AutomationEditor).exists()).toBe(false)
		await button(wrapper, 'automations.runNow').trigger('click')
		await flushPromises()
		expect(sdk.automationRun).toHaveBeenCalledTimes(2)
		expect(sdk.automationRun.mock.calls[1][0].body.request_id)
			.not.toBe(sdk.automationRun.mock.calls[0][0].body.request_id)
	})
})
