import {afterEach, describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'

import en from '@/i18n/lang/en.json'
import ErrorMessage from './Error.vue'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

function setup(props: Record<string, unknown> = {}) {
	return mount(ErrorMessage, {props, global: {plugins: [i18n], stubs: {Icon: true}}})
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('Error message', () => {
	it('runs only the failed request again when it can, without reloading the page', async () => {
		const retry = vi.fn()
		const reload = vi.fn()
		vi.spyOn(window, 'location', 'get').mockReturnValue({...window.location, reload} as Location)
		const view = setup({retry})

		await view.get('button').trigger('click')

		expect(retry).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled()
	})

	it('does not send people to the upstream project to report problems with this server', () => {
		const view = setup()

		expect(view.html()).not.toContain('vikunja.io')
		expect(view.text()).toContain('Nothing was changed')
	})
})
