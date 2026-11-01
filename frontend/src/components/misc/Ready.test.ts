import {afterEach, describe, expect, it, vi} from 'vitest'
import {mount, type VueWrapper} from '@vue/test-utils'
import {nextTick, reactive, ref} from 'vue'

const online = ref(true)
const baseStore = reactive({ready: true, error: '', loading: false})
vi.mock('@/composables/useOnline', () => ({useOnline: () => online}))
vi.mock('@/stores/base', () => ({ERROR_RATE_LIMITED: 'rate-limited', useBaseStore: () => baseStore}))
import Ready from './Ready.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
	wrapper?.unmount()
	online.value = true
	baseStore.ready = true
})

function setup() {
	wrapper = mount(Ready, {
		slots: {default: '<textarea class="typed">half a sentence</textarea>'},
		global: {
			mocks: {$t: (key: string) => key},
			stubs: {Logo: true, ApiConfig: true, NoAuthWrapper: true, CustomTransition: true},
		},
	})
	return wrapper
}

describe('Ready offline handling', () => {
	it('keeps a running app mounted when the connection drops and says so', async () => {
		const view = setup()
		const field = view.find('textarea.typed').element
		online.value = false
		await nextTick()
		expect(view.find('textarea.typed').exists()).toBe(true)
		expect(view.find('textarea.typed').element).toBe(field)
		expect(view.find('[role="status"]').text()).toContain('offline.banner')
		online.value = true
		await nextTick()
		expect(view.find('[role="status"]').text()).toBe('')
	})

	it('shows the offline page while the app has not loaded yet', () => {
		online.value = false
		baseStore.ready = false
		const view = setup()
		expect(view.find('textarea.typed').exists()).toBe(false)
		expect(view.text()).toContain('offline.title')
	})
})
