import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {defineComponent} from 'vue'
import {createPinia} from 'pinia'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({taskLabelsCreate: vi.fn(), taskLabelsDelete: vi.fn(), labelsCreate: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))
vi.mock('vue-i18n', async original => ({...await original<typeof import('vue-i18n')>(), useI18n: () => ({t: (key: string) => key})}))
vi.mock('@/composables/useLabels', async () => {
	const {ref} = await import('vue')
	return {useLabels: () => ({filterLabelsByQuery: () => [], isPending: ref(false)})}
})

import EditLabels from './EditLabels.vue'
import {error, success} from '@/message'

// Like the real picker: the chip is added to the v-model before "select" reaches the parent.
const PickerStub = defineComponent({
	props: ['modelValue'],
	emits: ['update:modelValue', 'select', 'create', 'search'],
	template: '<div class="picker"><span v-for="item in modelValue" :key="item.id" class="chip">{{ item.title }}<slot name="tag" :item="item" /></span></div>',
})

const garden = {id: 3, title: 'Garden', hex_color: '00ff00'}
let wrapper: VueWrapper | undefined

function setup(labels = [] as typeof garden[]) {
	wrapper = mount(EditLabels, {
		props: {modelValue: labels, taskId: 5},
		global: {
			plugins: [createPinia(), [VueQueryPlugin, {queryClient: new QueryClient()}]],
			stubs: {Multiselect: PickerStub, BaseButton: {template: '<button class="remove" @click="$emit(\'click\')" />', emits: ['click']}},
			mocks: {$t: (key: string) => key},
		},
	})
	return wrapper
}

beforeEach(() => {
	Object.values(sdk).forEach(fn => fn.mockReset())
	vi.mocked(error).mockClear()
	vi.mocked(success).mockClear()
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
})

describe('EditLabels when saving fails', () => {
	it('takes the chip away again and reports the failure once', async () => {
		sdk.taskLabelsCreate.mockRejectedValueOnce(new Error('Server error'))
		const view = setup()
		const picker = view.findComponent(PickerStub)
		picker.vm.$emit('update:modelValue', [garden])
		picker.vm.$emit('select', garden)
		await flushPromises()

		expect(view.findAll('.chip')).toHaveLength(0)
		expect(error).toHaveBeenCalledTimes(1)
		expect(success).not.toHaveBeenCalled()
	})

	it('keeps a label whose removal failed', async () => {
		sdk.taskLabelsDelete.mockRejectedValueOnce(new Error('Server error'))
		const view = setup([garden])
		await view.find('.remove').trigger('click')
		await flushPromises()

		expect(view.findAll('.chip')).toHaveLength(1)
		expect(error).toHaveBeenCalledTimes(1)
		expect(success).not.toHaveBeenCalled()
	})
})
