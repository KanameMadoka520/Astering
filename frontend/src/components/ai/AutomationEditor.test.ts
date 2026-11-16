import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {defineComponent} from 'vue'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {DOMWrapper, enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'

const sdk = vi.hoisted(() => ({
	tcyAiSettings: vi.fn(() => new Promise(() => undefined)),
	tcyAiMcpSettings: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import type {AutomationDraft} from '@/client/queries/automations'
import {mcpSettingsKey, normalizeMCPConnection} from '@/client/queries/tcyMcp'
import {profileOptions} from '@/helpers/assistantProfiles'
import AutomationEditor from './AutomationEditor.vue'

enableAutoUnmount(afterEach)

// A mobile picker lives outside the form's fieldset; native disabled does not reach its teleported content.
const Popup = defineComponent({
	setup: () => ({noop: () => {}}),
	template: `<div>
		<slot name="trigger" :toggle="noop" />
		<Teleport to="body"><slot name="content" :close="noop" /></Teleport>
	</div>`,
})

function initial(): AutomationDraft {
	return {
		title: 'Review the plan',
		prompt: 'Read my open tasks',
		kind: 'agent',
		enabled: true,
		timezone: 'America/New_York',
		schedule: {
			kind: 'once',
			at: '2027-11-07T06:30:00Z',
		},
		options: profileOptions('assist'),
		notify_on_success: true,
		notify_on_failure: true,
		max_runtime_seconds: 3600,
	}
}

describe('automation schedule and pending edits', () => {
	let client: QueryClient

	function editor(draft = initial()) {
		return mount(AutomationEditor, {
			props: {
				initial: draft,
				busy: false,
				error: '',
			},
			global: {
				plugins: [[VueQueryPlugin, {queryClient: client}]],
				stubs: {
					Icon: true,
					ToolModuleControls: true,
					AssistantPreferences: true,
					Popup,
					RouterLink: true,
				},
				mocks: {$t: (key: string) => key},
			},
		})
	}
	function controlFor(wrapper: ReturnType<typeof editor>, labelKey: string) {
		const label = wrapper.findAll('label').find(candidate => candidate.text() === labelKey)
		expect(label, `A title-only label is available for ${labelKey}`).toBeDefined()
		expect(label!.find('input, select, textarea').exists()).toBe(false)
		const controlId = label!.attributes('for')
		expect(controlId, `The ${labelKey} label explicitly identifies its control`).toBeTruthy()
		return wrapper.get(`[id="${controlId}"]`)
	}
	beforeEach(() => {
		client = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: Infinity,
				},
			},
		})
	})
	afterEach(() => {
		client.clear()
	})

	it('preserves the second occurrence of an unchanged one-off time across DST fallback', async () => {
		const wrapper = editor()
		expect(wrapper.get('input[type="datetime-local"]').element).toHaveProperty('value', '2027-11-07T01:30')
		await wrapper.get('form').trigger('submit')
		const saved = wrapper.emitted('save')?.[0]?.[0] as AutomationDraft
		expect(Date.parse(saved.schedule.at!)).toBe(Date.parse(initial().schedule.at!))
	})

	it('gives every one-off editor field its title-only associated label', () => {
		const wrapper = editor()
		for (const labelKey of [
			'automations.name',
			'automations.kind',
			'automations.enabled',
			'automations.instructions',
			'automations.frequency',
			'automations.timezone',
			'automations.dateTime',
			'automations.dstOccurrence',
			'chat.model',
			'automations.maxRuntime',
			'automations.notifySuccess',
			'automations.notifyFailure',
		]) {
			controlFor(wrapper, labelKey)
		}
	})

	it.each([
		['interval', ['automations.intervalMinutes']],
		['daily', ['automations.time']],
		['yearly', ['automations.time', 'automations.month', 'automations.dayOfMonth']],
	] as const)('keeps %s schedule fields individually labelled', async (kind, labelKeys) => {
		const wrapper = editor()
		await controlFor(wrapper, 'automations.frequency').setValue(kind)
		for (const labelKey of labelKeys) controlFor(wrapper, labelKey)
	})

	it('keeps field help available as descriptions without extending control names', () => {
		const wrapper = editor()
		for (const [labelKey, hintKey] of [
			['automations.instructions', 'automations.agentHint'],
			['automations.maxRuntime', 'automations.maxRuntimeHint'],
		]) {
			const control = controlFor(wrapper, labelKey)
			const descriptionId = control.attributes('aria-describedby')
			expect(descriptionId).toBeTruthy()
			expect(wrapper.get(`[id="${descriptionId}"]`).text()).toBe(hintKey)
		}
	})

	it('keeps an open external MCP picker from changing the submitted draft during save', async () => {
		client.setQueryData(mcpSettingsKey, {
			revision: 1,
			connections: ['one', 'two'].map(id => normalizeMCPConnection({
				id,
				name: `Server ${id}`,
				enabled: true,
				has_key: true,
			})),
		})
		const draft = initial()
		draft.options.mcp_server_ids = ['one']
		const wrapper = editor(draft)
		await flushPromises()
		const external = new DOMWrapper(document.body).get('input[aria-label="Server two"]')
		expect(external.element.closest('fieldset')).toBeNull()
		await wrapper.setProps({busy: true})
		await external.setValue(true)
		await wrapper.setProps({busy: false})
		await wrapper.get('form').trigger('submit')

		const saved = wrapper.emitted('save')?.[0]?.[0] as AutomationDraft
		expect(saved.options.mcp_server_ids).toEqual(['one'])
	})
})
