import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, enableAutoUnmount, mount, DOMWrapper} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'
import {ref} from 'vue'

const isMobile = ref(false)

vi.mock('@/views/TcyAssistant.vue', async () => {
	const {defineComponent, h, ref} = await import('vue')
	// Marked as a module so the panel's async component unwraps the default export.
	return {__esModule: true, default: defineComponent({
		name: 'AssistantStub',
		props: {presenting: Boolean},
		emits: ['activity', 'attention', 'navigationBusy', 'update:conversationId'],
		setup: (_, {slots}) => {
			const draft = ref('')
			return () => h('div', {class: 'assistant'}, [
				...slots['panel-actions']?.() ?? [],
				h('textarea', {
					value: draft.value,
					onInput: (event: Event) => { draft.value = (event.target as HTMLTextAreaElement).value },
				}),
			])
		},
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
vi.mock('@/composables/useIsMobile', () => ({useIsMobile: () => isMobile}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

import FloatingArona from './FloatingArona.vue'

enableAutoUnmount(afterEach)
beforeEach(() => {
	isMobile.value = false
	localStorage.removeItem('astering-floating-arona-layout:v1')
})
afterEach(() => {
	document.body.innerHTML = ''
	vi.unstubAllGlobals()
})

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
	const app = mount(FloatingArona, {
		attachTo: document.body,
		global: {
			plugins: [router],
			stubs: {
				teleport: false,
				Icon: true,
			},
		},
	})
	// Use the real Teleport: VTU's generated teleport stub changes identity on every render.
	const wrapper = new DOMWrapper(document.body)
	const launcher = () => wrapper.find('.arona-launcher')
	const assistant = () => app.findComponent({name: 'AssistantStub'})
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
	it('keeps the mobile draft and chat instance while the keyboard changes only the visible viewport', async () => {
		isMobile.value = true
		const view = Object.assign(new EventTarget(), {
			width: 390,
			height: 740,
			offsetLeft: 0,
			offsetTop: 0,
		})
		vi.stubGlobal('visualViewport', view)
		const layoutHeight = window.innerHeight
		const {wrapper, assistant, open} = await mountPanel()
		await open()
		const instance = assistant().vm.$.uid
		await assistant().find('textarea').setValue('Keep this draft when the keyboard opens')

		view.height = 320
		view.offsetTop = 48
		view.dispatchEvent(new Event('resize'))
		await flushPromises()
		expect(window.innerHeight).toBe(layoutHeight)
		const floating = wrapper.find<HTMLElement>('.floating-arona').element
		expect(floating.style.getPropertyValue('--visual-viewport-height')).toBe('320px')
		expect(floating.style.getPropertyValue('--visual-viewport-top')).toBe('48px')
		expect(assistant().vm.$.uid).toBe(instance)
		expect(assistant().find('textarea').element.value).toBe('Keep this draft when the keyboard opens')
	})

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

	it('moves and resizes from keyboard, remembers only geometry and resets without remounting the conversation', async () => {
		localStorage.setItem('astering-floating-arona-layout:v1', JSON.stringify({
			x: 100,
			y: 100,
			width: 500,
			height: 400,
		}))
		const {wrapper, assistant, open} = await mountPanel()
		await open()
		const instance = assistant().vm.$.uid
		expect(wrapper.find('.arona-panel').attributes('style')).toContain('left: 100px')
		await wrapper.find('.panel-move').trigger('keydown', {key: 'ArrowLeft'})
		expect(wrapper.find('.arona-panel').attributes('style')).toContain('left: 92px')
		expect(assistant().vm.$.uid, 'after move').toBe(instance)
		await wrapper.find('.panel-resize--se').trigger('keydown', {
			key: 'ArrowRight',
			shiftKey: true,
		})
		expect(wrapper.find('.arona-panel').attributes('style')).toContain('width: 532px')
		expect(assistant().vm.$.uid, 'after resize').toBe(instance)
		const saved = JSON.parse(localStorage.getItem('astering-floating-arona-layout:v1')!)
		expect(Object.keys(saved).sort()).toEqual(['height', 'width', 'x', 'y'])
		expect(saved.x).toBe(92)
		expect(saved.width).toBe(532)
		await wrapper.find('.panel-reset').trigger('click')
		expect(wrapper.find('.arona-panel').attributes('style')).toContain('width: 460px')
		expect(localStorage.getItem('astering-floating-arona-layout:v1')).toBeNull()
		expect(assistant().vm.$.uid).toBe(instance)
		expect(assistant().props('presenting')).toBe(true)
	})

	it('cancels pointer movement on Escape without minimizing or saving a late animation frame', async () => {
		const {wrapper, assistant, open} = await mountPanel()
		await open()
		const before = wrapper.find('.arona-panel').attributes('style')
		const handle = wrapper.find('.panel-move').element
		const down = new Event('pointerdown', {bubbles: true, cancelable: true})
		Object.assign(down, {
			pointerId: 12,
			button: 0,
			clientX: 500,
			clientY: 150,
			isPrimary: true,
		})
		handle.dispatchEvent(down)
		const move = new Event('pointermove')
		Object.assign(move, {
			pointerId: 12,
			clientX: 300,
			clientY: 200,
		})
		window.dispatchEvent(move)
		await wrapper.find('.arona-panel').trigger('keydown', {key: 'Escape'})
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(wrapper.find('.arona-panel').attributes('style')).toBe(before)
		expect(assistant().props('presenting')).toBe(true)
		expect(localStorage.getItem('astering-floating-arona-layout:v1')).toBeNull()
	})
})
