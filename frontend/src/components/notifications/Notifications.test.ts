import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

import en from '@/i18n/lang/en.json'
import testid from '@/directives/testid'
import XButton from '@/components/input/Button.vue'
import {OPEN_NOTIFICATION_INBOX} from '@/helpers/nativeNotificationTarget'

const sdk = vi.hoisted(() => ({notificationsList: vi.fn(), notificationsDeleteAll: vi.fn(), notificationsMarkRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('@/composables/useWebSocket', async () => {
	const {ref} = await import('vue')
	return {useWebSocket: () => ({authenticated: ref(true), isAwaitingFirstConnection: () => false})}
})

import Notifications from './Notifications.vue'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
let wrapper: VueWrapper | undefined

async function setup() {
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/', name: 'home', component: {render: () => null}},
		{path: '/user/settings/feeds', name: 'user.settings.feeds', component: {render: () => null}},
	]})
	await router.push('/')
	wrapper = mount(Notifications, {
		global: {
			plugins: [i18n, router, [VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}]],
			components: {XButton},
			directives: {cy: testid, tooltip: {}},
			stubs: {Icon: true, UserAvatar: true},
		},
		attachTo: document.body,
	})
	await flushPromises()
	await wrapper.find('.trigger-button').trigger('click')
	await flushPromises()
	return wrapper
}

function clearButton(view: VueWrapper) {
	return view.findAll('button').find(button => button.text() === 'Clear notifications')!
}

function confirmButton() {
	return document.querySelector<HTMLButtonElement>('dialog [data-cy="modalPrimary"]')
}

async function settle() {
	await flushPromises()
	await new Promise(resolve => setTimeout(resolve, 200))
	await flushPromises()
}

beforeEach(() => {
	vi.stubGlobal('TESTING', true)
	setActivePinia(createPinia())
	document.body.innerHTML = ''
	Object.values(sdk).forEach(fn => fn.mockReset())
	sdk.notificationsList.mockResolvedValue({data: {
		items: [{id: 1, name: 'task.comment', created: '2026-10-30T10:00:00Z', notification: {}}],
		page: 1, per_page: 50, total: 1, total_pages: 1,
	}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

it('opens the existing inbox from a validated native notification without navigating', async () => {
	const view = await setup()
	await view.find('.trigger-button').trigger('click')
	expect(view.find('.notifications-list').exists()).toBe(false)
	const go = vi.spyOn(view.vm.$router, 'go')
	window.dispatchEvent(new Event(OPEN_NOTIFICATION_INBOX))
	await flushPromises()
	expect(view.find('.notifications-list').exists()).toBe(true)
	expect(document.activeElement).toBe(view.find('.notifications-list').element)
	expect(go).not.toHaveBeenCalled()
})

it('keeps the current task page mounted when a notification points to the same task', async () => {
	sdk.notificationsList.mockResolvedValue({data: {
		items: [{id: 1, name: 'task.assigned', notification: {task: {id: 7}}}],
		page: 1, per_page: 20, total: 1, total_pages: 1,
	}})
	sdk.notificationsMarkRead.mockResolvedValue({data: {read_at: '2026-11-16T12:00:00Z'}})
	const view = await setup()
	const router = view.vm.$router
	router.addRoute({path: '/tasks/:id', name: 'task.detail', component: {render: () => null}})
	await router.push({name: 'task.detail', params: {id: 7}})
	const go = vi.spyOn(router, 'go')
	await view.find('.single-notification').trigger('click')
	await flushPromises()
	expect(router.currentRoute.value.fullPath).toBe('/tasks/7')
	expect(go).not.toHaveBeenCalled()
	expect(sdk.notificationsMarkRead).toHaveBeenCalledWith(expect.objectContaining({path: {notificationid: 1}}))
})

describe('Notifications clearing', () => {
	it('names the action in plain text and deletes nothing before it is confirmed', async () => {
		const view = await setup()
		await clearButton(view).trigger('click')
		await flushPromises()

		expect(sdk.notificationsDeleteAll).not.toHaveBeenCalled()
		expect(document.querySelector('dialog.modal-dialog')?.textContent).toContain('including older ones not shown here')
		expect(confirmButton()?.textContent).toContain('Delete all notifications')
	})

	it('stays open when deleting fails and closes once it worked', async () => {
		sdk.notificationsDeleteAll.mockRejectedValueOnce(new Error('Server error')).mockResolvedValueOnce({data: {}})
		const view = await setup()
		await clearButton(view).trigger('click')
		await flushPromises()

		confirmButton()!.click()
		await settle()
		expect(sdk.notificationsDeleteAll).toHaveBeenCalledTimes(1)
		expect(document.querySelector('dialog.modal-dialog')).not.toBeNull()

		confirmButton()!.click()
		await settle()
		expect(sdk.notificationsDeleteAll).toHaveBeenCalledTimes(2)
		expect(document.querySelector('dialog.modal-dialog')).toBeNull()
	})
})
