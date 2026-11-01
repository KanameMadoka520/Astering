import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	tcyShowcaseSettings: vi.fn(),
	userShow: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
const message = vi.hoisted(() => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/message', () => message)

import TcyShowcase from './TcyShowcase.vue'
import XButton from '@/components/input/Button.vue'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/constants/auth'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useAuthStore} from '@/stores/auth'

const defaults = queryClient.getDefaultOptions()
let wrapper: VueWrapper | undefined

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
	useAuthStore().setSession({id: 1, username: 'me', type: AUTH_TYPES.USER, exp: 0})
	sdk.userShow.mockReturnValue(new Promise(() => {}))
	sdk.projectsList.mockResolvedValue({data: {items: [], total_pages: 1}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
})

describe('TcyShowcase settings page', () => {
	it('shows a retryable error instead of loading forever', async () => {
		sdk.tcyShowcaseSettings.mockRejectedValue(new Error('offline'))
		wrapper = mount(TcyShowcase, {
			global: {
				plugins: [i18n, [VueQueryPlugin, {queryClient}]],
				components: {XButton},
				stubs: {Icon: true, ShowcaseEditor: {props: ['initial'], template: '<div class="editor-stub" />'}},
			},
		})
		await flushPromises()

		const alert = wrapper.find('[role="alert"]')
		expect(alert.text()).toContain('Your public page settings couldn\'t be loaded.')
		expect(wrapper.find('[role="status"]').exists()).toBe(false)
		expect(message.error).not.toHaveBeenCalled()

		sdk.tcyShowcaseSettings.mockResolvedValue({data: {draft: {slug: 'tcy'}}})
		await alert.find('button').trigger('click')
		await flushPromises()
		expect(wrapper.find('.editor-stub').exists()).toBe(true)
	})
})
