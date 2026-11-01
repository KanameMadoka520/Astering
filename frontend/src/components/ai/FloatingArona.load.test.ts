import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, enableAutoUnmount, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

// The first download of the assistant's code fails, as on a dropped connection; the next one works.
const chunk = vi.hoisted(() => ({attempts: 0}))
vi.mock('@/views/TcyAssistant.vue', async () => {
	chunk.attempts++
	if (chunk.attempts === 1) throw new Error('Failed to fetch dynamically imported module')
	const {defineComponent, h} = await import('vue')
	return {__esModule: true, default: defineComponent({
		name: 'AssistantStub',
		setup: () => () => h('div', {class: 'assistant'}),
	})}
})
vi.mock('@/stores/base', async () => {
	const {reactive} = await import('vue')
	return {useBaseStore: () => reactive({
		menuActive: false,
		currentProjectId: 0,
	})}
})
vi.mock('@/stores/auth', () => ({useAuthStore: () => ({info: {id: 1}})}))
vi.mock('@/composables/useIsMobile', async () => {
	const {ref} = await import('vue')
	return {useIsMobile: () => ref(false)}
})
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import FloatingArona from './FloatingArona.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

enableAutoUnmount(afterEach)

describe('FloatingArona loading', () => {
	it('shows a failed download in the panel, keeps minimize, and retries', async () => {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{
				path: '/',
				name: 'home',
				component: {render: () => null},
			}],
		})
		await router.push('/')
		const wrapper = mount(FloatingArona, {
			global: {
				plugins: [router],
				mocks: {$t: (key: string) => key},
				stubs: {
					teleport: true,
					Icon: true,
					XButton: {template: '<button type="button" @click="$emit(\'click\')"><slot /></button>'},
				},
			},
		})

		await wrapper.find('.arona-launcher').trigger('click')
		expect(wrapper.find('.panel-state [role="status"]').text()).toBe('floatingArona.loading')
		await flushPromises()

		const failure = wrapper.findComponent(LoadError)
		expect(failure.props('message')).toBe('floatingArona.loadFailed')
		expect(wrapper.find('.panel-state [aria-label="floatingArona.minimize"]').exists()).toBe(true)

		await failure.find('button').trigger('click')
		await flushPromises()
		expect(wrapper.find('.assistant').exists()).toBe(true)
		expect(wrapper.find('.panel-state').exists()).toBe(false)
	})
})
