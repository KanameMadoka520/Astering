import {describe, it, expect, vi, afterEach} from 'vitest'
import {mount} from '@vue/test-utils'
import {ref} from 'vue'
import {createI18n} from 'vue-i18n'
import en from '@/i18n/lang/en.json'

import Logo from './Logo.vue'

const i18n = createI18n({
	legacy: false,
	locale: 'en',
	messages: {en: {brand: en.brand}},
})

vi.mock('@/stores/auth', () => ({
	useAuthStore: () => ({settings: {frontend_settings: {allow_icon_changes: false}}}),
}))

vi.mock('@/stores/config', () => ({
	useConfigStore: () => ({allow_icon_changes: false}),
}))

vi.mock('@/composables/useColorScheme', () => ({
	useColorScheme: () => ({isDark: ref(false)}),
}))

afterEach(() => {
	window.CUSTOM_LOGO_URL = ''
	window.CUSTOM_LOGO_URL_DARK = ''
})

describe('Logo.vue', () => {
	it('renders no img without a custom logo', () => {
		window.CUSTOM_LOGO_URL = ''
		window.CUSTOM_LOGO_URL_DARK = ''

		const wrapper = mount(Logo, {
			global: {plugins: [i18n]},
		})

		expect(wrapper.find('img').exists()).toBe(false)
	})

	it('renders the custom logo as img', () => {
		window.CUSTOM_LOGO_URL = 'https://example.com/logo.png'

		const wrapper = mount(Logo, {
			global: {plugins: [i18n]},
		})

		expect(wrapper.find('img').attributes('src')).toBe('https://example.com/logo.png')
	})
})
