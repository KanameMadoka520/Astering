import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createMemoryHistory, createRouter} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import BotUsers from './BotUsers.vue'
import Modal from '@/components/misc/Modal.vue'
import testid from '@/directives/testid'
import en from '@/i18n/lang/en.json'

const sdk = vi.hoisted(() => ({
	botsList: vi.fn(),
	botsCreate: vi.fn(),
	botsUpdate: vi.fn(),
	botsDelete: vi.fn(),
	tokensList: vi.fn(),
	tokensDelete: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn(), getErrorText: (e: Error) => e.message}))
vi.mock('@/composables/useTitle', () => ({useTitle: vi.fn()}))

const bot = {id: 7, username: 'bot-helper', name: 'Helper', status: 0}
const botToken = {id: 70, title: 'Deploy hook', permissions: {}, expires_at: '2036-01-01T00:00:00Z', created: '2026-01-01T00:00:00Z'}
const page = <T>(items: T[]) => ({data: {items, page: 1, per_page: 50, total: items.length, total_pages: items.length ? 1 : 0}})

let wrapper: VueWrapper | undefined

async function mountPage() {
	const router = createRouter({history: createMemoryHistory(), routes: [{path: '/', component: BotUsers}]})
	await router.push('/')
	await router.isReady()
	wrapper = mount(BotUsers, {
		attachTo: document.body,
		global: {
			plugins: [
				createI18n({legacy: false, locale: 'en', messages: {en}}),
				router,
				[VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}],
			],
			components: {Modal},
			directives: {cy: testid},
			stubs: {
				Card: {template: '<div class="card"><slot /><slot name="footer" /></div>'},
				XButton: {
					template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>',
					emits: ['click'],
				},
				ApiTokenForm: true,
				Icon: true,
			},
		},
	})
	await flushPromises()
	return wrapper
}

beforeEach(() => {
	vi.stubGlobal('TESTING', true)
	setActivePinia(createPinia())
	document.body.innerHTML = ''
	Object.values(sdk).forEach(fn => fn.mockReset())
	sdk.botsList.mockResolvedValue(page([bot]))
	sdk.tokensList.mockResolvedValue(page([botToken]))
	sdk.tokensDelete.mockResolvedValue({data: {}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	vi.unstubAllGlobals()
	document.body.innerHTML = ''
})

describe('Bot users settings', () => {
	it('does not open the "first bot" form when the list could not be loaded', async () => {
		sdk.botsList.mockRejectedValueOnce(new Error('Server error'))
		const view = await mountPage()
		expect(view.find('[role="alert"]').text()).toContain("This list couldn't be loaded, so it may not be empty.")
		expect(view.find('input[placeholder="bot-myassistant"]').exists()).toBe(false)
	})

	it('asks before deleting a bot token, names it, and deletes it once on confirm', async () => {
		const view = await mountPage()
		await view.find('tbody').findAll('button').find(button => button.text() === 'Delete')!.trigger('click')
		await flushPromises()
		expect(sdk.tokensDelete).not.toHaveBeenCalled()
		const dialog = document.querySelector('dialog[open]')
		expect(dialog?.textContent).toContain('Are you sure you want to delete the token "Deploy hook"?')
		const confirm = dialog!.querySelector<HTMLButtonElement>('[data-cy="modalPrimary"]')!
		expect(confirm.textContent).toContain('Delete token')
		confirm.click()
		confirm.click()
		await flushPromises()
		expect(sdk.tokensDelete).toHaveBeenCalledTimes(1)
		expect(sdk.tokensDelete).toHaveBeenCalledWith({path: {id: 70}})
	})

	it('keeps the bot delete dialog open when deleting fails', async () => {
		sdk.botsDelete.mockRejectedValueOnce(new Error('Server error'))
		const view = await mountPage()
		await view.find('.bot-actions').findAll('button').find(button => button.text() === 'Delete')!.trigger('click')
		await flushPromises()
		const dialog = document.querySelector('dialog[open]')!
		expect(dialog.textContent).toContain('bot-helper')
		dialog.querySelector<HTMLButtonElement>('[data-cy="modalPrimary"]')!.click()
		await flushPromises()
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(sdk.botsDelete).toHaveBeenCalledTimes(1)
		expect(document.querySelector('dialog[open]')?.textContent).toContain('bot-helper')
	})
})
