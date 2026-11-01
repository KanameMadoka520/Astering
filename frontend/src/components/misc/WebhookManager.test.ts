import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter} from 'vue-router'

const sdk = vi.hoisted(() => ({
	webhooksList: vi.fn(),
	webhooksEventsList: vi.fn(),
	webhooksCreate: vi.fn(),
	webhooksDelete: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import WebhookManager from './WebhookManager.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import {queryClient} from '@/client/queryClient'
import testid from '@/directives/testid'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'

const HOOK = {id: 4, target_url: 'https://hooks.example.com/vikunja', events: ['task.created'], created: '2026-01-01T00:00:00Z', created_by: {id: 1, username: 'me'}}

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

function page(items: unknown[]) {
	return {data: {items, page: 1, per_page: 50, total: items.length, total_pages: items.length > 0 ? 1 : 0}}
}

beforeAll(() => {
	queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
})

afterAll(() => {
	queryClient.setDefaultOptions(defaults)
})

beforeEach(() => {
	vi.resetAllMocks()
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.webhooksList.mockResolvedValue(page([HOOK]))
	sdk.webhooksEventsList.mockResolvedValue({data: ['task.created', 'task.updated']})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
	document.body.innerHTML = ''
})

async function mountManager() {
	const router = createRouter({history: createMemoryHistory(), routes: [{path: '/', component: {template: '<div />'}}]})
	wrapper = mount(WebhookManager, {
		attachTo: document.body,
		props: {scope: {kind: 'project', projectId: 1}},
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Card, Modal},
			directives: {cy: testid, focus: {}, tooltip: {}},
			stubs: {Icon: true, User: true},
		},
	})
	await flushPromises()
	return wrapper
}

function openDialog() {
	return document.querySelector('dialog.modal-dialog:not([data-closing])')
}

async function askToDelete() {
	await wrapper!.find('button[aria-label="Delete this webhook"]').trigger('click')
	await flushPromises()
	return openDialog()!
}

describe('WebhookManager: the list', () => {
	it('says the webhooks couldn\'t be loaded instead of offering a blank form', async () => {
		sdk.webhooksList.mockRejectedValue(new Error('boom'))
		await mountManager()

		expect(wrapper!.text()).toContain('Could not load this. Please try again.')
		expect(wrapper!.find('#targetUrl').exists()).toBe(false)

		sdk.webhooksList.mockResolvedValue(page([HOOK]))
		await wrapper!.findAll('button').find(button => button.text() === 'Retry')!.trigger('click')
		await flushPromises()
		expect(wrapper!.text()).toContain(HOOK.target_url)
	})

	it('offers the form straight away when there are no webhooks yet', async () => {
		sdk.webhooksList.mockResolvedValue(page([]))
		await mountManager()

		expect(wrapper!.find('#targetUrl').exists()).toBe(true)
	})

	it('says the events couldn\'t be loaded instead of showing none', async () => {
		sdk.webhooksList.mockResolvedValue(page([]))
		sdk.webhooksEventsList.mockRejectedValue(new Error('boom'))
		await mountManager()

		expect(wrapper!.text()).toContain('Could not load this. Please try again.')
	})
})

describe('WebhookManager: deleting', () => {
	it('names the target and stays open until the delete finishes', async () => {
		let finish!: (value: unknown) => void
		sdk.webhooksDelete.mockReturnValue(new Promise(resolve => finish = resolve))
		await mountManager()

		const dialog = await askToDelete()
		expect(dialog.textContent).toContain(HOOK.target_url)
		dialog.querySelector<HTMLButtonElement>('.actions .is-primary')!.click()
		await flushPromises()
		expect(sdk.webhooksDelete).toHaveBeenCalledTimes(1)
		expect(openDialog()).not.toBeNull()

		finish({data: {}})
		await flushPromises()
		expect(openDialog()).toBeNull()
	})

	it('keeps the dialog open when the delete fails', async () => {
		sdk.webhooksDelete.mockRejectedValue(new Error('boom'))
		await mountManager()

		const dialog = await askToDelete()
		dialog.querySelector<HTMLButtonElement>('.actions .is-primary')!.click()
		await flushPromises()

		expect(sdk.webhooksDelete).toHaveBeenCalledTimes(1)
		expect(openDialog()).not.toBeNull()
	})
})
