import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {defineComponent} from 'vue'

// The rich text editor is irrelevant here and heavy to load.
vi.mock('@/components/input/AsyncEditor', () => ({default: defineComponent({name: 'AsyncEditor', render: () => null})}))

import EditTeamForm from './EditTeamForm.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'

let wrapper: VueWrapper | undefined

beforeEach(() => {
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

function mountForm(props: Record<string, unknown>) {
	wrapper = mount(EditTeamForm, {
		props: {
			team: {id: 3, name: 'Crew', description: '', is_public: false},
			loading: false,
			...props,
		},
		global: {
			plugins: [i18n],
			components: {XButton, Card},
			directives: {focus: {}, cy: {}, tooltip: {}},
			stubs: {Icon: true},
		},
	})
	return wrapper
}

describe('EditTeamForm', () => {
	it('keeps the name editable while members are being changed', () => {
		mountForm({loading: false, membersLoading: true})

		expect(wrapper!.find('#teamtext').attributes('disabled')).toBeUndefined()
	})

	it('locks the name while the team itself is being saved', () => {
		mountForm({loading: true, membersLoading: false})

		expect(wrapper!.find('#teamtext').attributes('disabled')).toBeDefined()
	})

	it('doesn\'t send a second save while one is running', async () => {
		mountForm({loading: true})

		await wrapper!.find('form').trigger('submit')

		expect(wrapper!.emitted('save')).toBeUndefined()
	})
})
