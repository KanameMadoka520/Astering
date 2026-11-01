import {describe, expect, it, vi} from 'vitest'
import {defineComponent, h, nextTick, ref, withDirectives} from 'vue'
import {mount} from '@vue/test-utils'

const floating = vi.hoisted(() => ({
	beforeMount: vi.fn(),
	updated: vi.fn(),
	beforeUnmount: vi.fn(),
}))
vi.mock('floating-vue', () => ({vTooltip: floating}))

import tooltip from './tooltip'

describe('v-tooltip', () => {
	it('passes a re-render on to floating-vue only when the tooltip changed', async () => {
		const seconds = ref(0)
		const label = ref('Stop')
		mount(defineComponent({
			setup: () => () => h('div', [
				h('span', String(seconds.value)),
				withDirectives(h('button'), [[tooltip, label.value]]),
			]),
		}), {attachTo: document.body})
		expect(floating.beforeMount).toHaveBeenCalledTimes(1)

		for (let tick = 1; tick <= 5; tick++) {
			seconds.value = tick
			await nextTick()
		}
		expect(floating.updated).not.toHaveBeenCalled()

		label.value = 'Stop timer'
		await nextTick()
		expect(floating.updated).toHaveBeenCalledTimes(1)
	})
})
