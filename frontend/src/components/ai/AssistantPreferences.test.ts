import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {DOMWrapper, enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'

const sdk = vi.hoisted(() => ({
	tcyAiPreferences: vi.fn(),
	tcyAiSavePreferences: vi.fn(),
	tcyAiSettings: vi.fn(() => new Promise(() => undefined)),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/composables/useProjects', () => ({useProjects: () => ({projectsArray: []})}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import type {AssistantPreferences as Preferences} from '@/client/generated'
import {assistantPreferencesQuery} from '@/client/queries/assistantPreferences'
import {profileOptions} from '@/helpers/assistantProfiles'
import AssistantPreferences from './AssistantPreferences.vue'

enableAutoUnmount(afterEach)

const STORED: Preferences = {
	default_profile: 'ask',
	profiles: [{
		id: 'custom-weekly',
		name: 'Weekly',
		options: profileOptions('plan'),
	}],
}

describe('AssistantPreferences', () => {
	let client: QueryClient

	function mountDialog() {
		return mount(AssistantPreferences, {
			props: {
				options: profileOptions('plan'),
				profile: 'custom-weekly',
			},
			attachTo: document.body,
			global: {
				plugins: [[VueQueryPlugin, {queryClient: client}], createPinia()],
				stubs: {Icon: true},
			},
		})
	}
	// The dialog is teleported to the body.
	const page = () => new DOMWrapper(document.body)
	const button = (label: string) => page().findAll('button')
		.find(candidate => candidate.text() === label)
	const savedBodies = () => sdk.tcyAiSavePreferences.mock.calls.map(([options]) => options.body as Preferences)

	afterEach(() => {
		document.body.innerHTML = ''
	})
	beforeEach(() => {
		client = new QueryClient({defaultOptions: {queries: {staleTime: Infinity, retry: false}}})
		client.setQueryData(assistantPreferencesQuery().queryKey, STORED)
		sdk.tcyAiPreferences.mockReset().mockImplementation(async () => ({data: STORED}))
		sdk.tcyAiSavePreferences.mockReset().mockImplementation(async ({body}) => ({data: body}))
		// happy-dom has no modal dialogs.
		HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
	})

	it('asks before deleting a template from the account', async () => {
		mountDialog()
		await button('assistantUI.deleteTemplate')!.trigger('click')
		await flushPromises()
		expect(sdk.tcyAiSavePreferences).not.toHaveBeenCalled()
		expect(page().find('.delete-confirm').text()).toContain('assistantUI.deleteTemplateConfirm')

		await button('assistantUI.deleteTemplateYes')!.trigger('click')
		await flushPromises()
		expect(savedBodies()).toEqual([{
			default_profile: 'ask',
			profiles: [],
		}])
	})

	it('drops the earlier confirmation when a later save fails, and its retry saves again', async () => {
		mountDialog()
		await button('assistantUI.makeDefault')!.trigger('click')
		await flushPromises()
		expect(page().find('[role="status"]').text()).toBe('assistantUI.saved')

		sdk.tcyAiSavePreferences.mockRejectedValueOnce(new Error('Conflict'))
		await button('assistantUI.makeDefault')!.trigger('click')
		await flushPromises()
		expect(page().text()).not.toContain('assistantUI.saved')
		expect(page().find('[role="alert"]').text()).toContain('assistantUI.saveFailed')

		const reads = sdk.tcyAiPreferences.mock.calls.length
		await button('chat.retry')!.trigger('click')
		await flushPromises()
		expect(sdk.tcyAiPreferences.mock.calls.length).toBeGreaterThan(reads)
		expect(savedBodies().map(body => body.default_profile)).toEqual(['custom-weekly', 'custom-weekly', 'custom-weekly'])
		expect(page().find('[role="alert"]').exists()).toBe(false)
	})

	it('stays open when a text selection is dragged out onto the backdrop', async () => {
		const wrapper = mountDialog()
		const dialog = page().find('dialog')

		await page().find('input.input').trigger('mousedown')
		await dialog.trigger('click')
		expect(wrapper.emitted('close')).toBeUndefined()

		await dialog.trigger('mousedown')
		await dialog.trigger('click')
		expect(wrapper.emitted('close')).toHaveLength(1)
	})

	it('keeps an open draft but refuses applying it if execution becomes locked', async () => {
		const wrapper = mountDialog()
		await page().find('select[aria-label="toolModules.compass"]').setValue('write')
		await wrapper.setProps({locked: true})

		expect(page().find('select[aria-label="toolModules.compass"]').attributes('disabled')).toBeDefined()
		expect(button('assistantUI.apply')!.attributes('disabled')).toBeDefined()
		expect(page().text()).toContain('toolModules.locked')
		// A submit already queued before the lock must be rejected as well.
		await page().find('form').trigger('submit')
		expect(wrapper.emitted('apply')).toBeUndefined()
		expect(wrapper.emitted('close')).toBeUndefined()

		await wrapper.setProps({locked: false})
		expect(page().find('select[aria-label="toolModules.compass"]').element).toHaveProperty('value', 'write')
		await page().find('form').trigger('submit')
		expect(wrapper.emitted('apply')?.[0]?.[0]).toMatchObject({tool_modules: {compass: 'write'}})
		expect(wrapper.emitted('close')).toHaveLength(1)
	})
})
