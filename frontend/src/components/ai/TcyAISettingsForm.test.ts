import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {enableAutoUnmount, flushPromises, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter, RouterView} from 'vue-router'

const sdk = vi.hoisted(() => ({
	tcyAiSaveSettings: vi.fn(),
	tcyAiSettings: vi.fn(),
	tcyAiModels: vi.fn(),
	tcyAiTest: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('vue-i18n', async importOriginal => {
	const {ref} = await import('vue')
	return {
		...await importOriginal<typeof import('vue-i18n')>(),
		useI18n: () => ({
			t: (key: string) => key,
			locale: ref('en'),
		}),
	}
})

import type {AISettings} from '@/client/queries/tcyAi'
import TcyAISettingsForm from './TcyAISettingsForm.vue'

enableAutoUnmount(afterEach)

const SAVED: AISettings = {
	persona: 'arona',
	connections: [{
		id: 'llm',
		name: 'Saved LLM',
		kind: 'chat',
		protocol: 'openai-chat',
		base_url: 'https://llm.example/v1',
		model: 'model',
		api_key: '',
		has_key: true,
	}],
	assistant: 'llm',
	transcription: '',
	cleanup: '',
}

// The shared dialog's built-in layout: header, text and a confirm button that runs the submit handler.
const ModalStub = defineComponent({
	props: {
		enabled: Boolean,
		confirmLabel: {
			type: String,
			default: '',
		},
		onSubmit: {
			type: Function,
			default: undefined,
		},
	},
	emits: ['close'],
	setup: (props, {slots}) => () => props.enabled
		? h('div', {class: 'modal-stub'}, [
			slots.header?.(),
			slots.text?.(),
			h('button', {
				class: 'modal-primary',
				onClick: () => props.onSubmit?.(),
			}, props.confirmLabel),
		])
		: null,
})

describe('TcyAISettingsForm', () => {
	let router: ReturnType<typeof createRouter>

	async function mountForm() {
		router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: '/settings',
					component: () => h(TcyAISettingsForm, {initial: SAVED}),
				},
				{
					path: '/other',
					component: {render: () => null},
				},
			],
		})
		await router.push('/settings')
		const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		const wrapper = mount(RouterView, {
			global: {
				plugins: [router, [VueQueryPlugin, {queryClient: client}], createPinia()],
				stubs: {
					Modal: ModalStub,
					Icon: true,
					ModelPicker: true,
					WebSearchEvidence: true,
				},
			},
		})
		await flushPromises()
		return wrapper
	}
	const dialogs = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.findAll('.modal-stub')

	beforeEach(() => {
		sdk.tcyAiSaveSettings.mockReset()
	})

	it('asks before leaving with an unsaved connection, and leaves only after a discard', async () => {
		const wrapper = await mountForm()
		await router.push('/other')
		expect(router.currentRoute.value.path).toBe('/other')

		await router.push('/settings')
		await flushPromises()
		await wrapper.find('.ai-field input').setValue('Renamed LLM')
		await router.push('/other')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/settings')
		const leave = dialogs(wrapper).find(dialog => dialog.text().includes('modelSettings.leaveTitle'))!
		expect(leave.find('.modal-primary').text()).toBe('modelSettings.leaveDiscard')

		await leave.find('.modal-primary').trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/other')
	})

	it('keeps the remove dialog open on failure and reports it as a removal', async () => {
		sdk.tcyAiSaveSettings.mockRejectedValue(new Error('Server unavailable'))
		const wrapper = await mountForm()
		const remove = wrapper.findAll('.connection__remove')[0]
		await remove.trigger('click')
		const dialog = () => dialogs(wrapper).find(candidate => candidate.text().includes('modelSettings.removeConfirm'))
		expect(dialog()!.find('.modal-primary').text()).toBe('tcymc.text.remove_connection')

		await dialog()!.find('.modal-primary').trigger('click')
		await flushPromises()

		expect(sdk.tcyAiSaveSettings).toHaveBeenCalledTimes(1)
		expect(dialog()?.find('[role="alert"]').text()).toBe('modelSettings.removeFailed Server unavailable')
		expect(wrapper.text()).not.toContain('settingsDraft.retained')
		expect(wrapper.findAll('form.connection')).toHaveLength(1)
	})
})
