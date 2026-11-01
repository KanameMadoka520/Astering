import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, enableAutoUnmount, mount} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'

vi.mock('@/views/TcyAssistant.vue', async () => {
	const {defineComponent, h} = await import('vue')
	// Marked as a module so the panel's async component unwraps the default export.
	return {__esModule: true, default: defineComponent({
		name: 'AssistantStub',
		props: {presenting: Boolean},
		emits: ['activity', 'attention', 'navigationBusy', 'update:conversationId'],
		setup: (_, {slots}) => () => h('div', {class: 'assistant'}, slots['panel-actions']?.()),
	})}
})
vi.mock('@/stores/base', async () => {
	const {reactive} = await import('vue')
	const base = reactive({
		menuActive: false,
		currentProjectId: 0,
	})
	return {useBaseStore: () => base}
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

enableAutoUnmount(afterEach)

async function mountPanel() {
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
			stubs: {
				teleport: true,
				Icon: true,
			},
		},
	})
	const launcher = () => wrapper.find('.arona-launcher')
	const assistant = () => wrapper.findComponent({name: 'AssistantStub'})
	const open = async () => {
		await launcher().trigger('click')
		await flushPromises()
	}
	return {
		wrapper,
		launcher,
		assistant,
		open,
	}
}

describe('FloatingArona', () => {
	it('tells the assistant whether the panel is open', async () => {
		const {launcher, assistant, open} = await mountPanel()
		await open()
		expect(assistant().props('presenting')).toBe(true)

		await launcher().trigger('click')
		// Minimized, the assistant stays mounted so its run and state carry on.
		expect(assistant().exists()).toBe(true)
		expect(assistant().props('presenting')).toBe(false)
	})

	it('shows and describes a turn that waits for the user', async () => {
		const {wrapper, launcher, assistant, open} = await mountPanel()
		await open()
		await launcher().trigger('click')

		assistant().vm.$emit('attention', true)
		await flushPromises()

		expect(wrapper.find('.attention-badge').exists()).toBe(true)
		expect(wrapper.find('.activity-dot').exists()).toBe(false)
		const description = wrapper.find(`#${launcher().attributes('aria-describedby')}`)
		expect(description.text()).toBe('floatingArona.waiting')

		// Once the user answers, the run works again and the launcher says so instead.
		assistant().vm.$emit('activity', true)
		await flushPromises()
		expect(wrapper.find('.attention-badge').exists()).toBe(false)
		expect(wrapper.find('.activity-dot').exists()).toBe(true)
		expect(wrapper.find(`#${launcher().attributes('aria-describedby')}`).text()).toBe('floatingArona.working')
	})

	it('describes nothing while idle', async () => {
		const {launcher} = await mountPanel()
		expect(launcher().attributes('aria-describedby')).toBeUndefined()
	})
})
