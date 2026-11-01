import {describe, expect, it} from 'vitest'
import {computed, defineComponent, h, nextTick, ref} from 'vue'
import {mount} from '@vue/test-utils'
import {provideAronaPresenting, useAronaPresenting, usePresentedSnapshot} from './useAronaPresentation'

describe('usePresentedSnapshot', () => {
	it('holds the shown value while hidden and catches up with the latest one when shown again', async () => {
		const live = ref('a')
		const presenting = ref(true)
		const shown = usePresentedSnapshot(live, presenting)
		expect(shown.value).toBe('a')

		presenting.value = false
		await nextTick()
		live.value = 'b'
		await nextTick()
		live.value = 'c'
		await nextTick()
		expect(shown.value).toBe('a')

		presenting.value = true
		await nextTick()
		expect(shown.value).toBe('c')

		live.value = 'd'
		await nextTick()
		expect(shown.value).toBe('d')
	})

	it('holds nothing until a view mounted while hidden is first shown', async () => {
		const live = ref(['turn'])
		const presenting = ref(false)
		const shown = usePresentedSnapshot(live, presenting)
		expect(shown.value).toBeUndefined()

		presenting.value = true
		await nextTick()
		expect(shown.value).toBe(live.value)
	})

	it('does not read the live value while hidden', async () => {
		let reads = 0
		const source = ref(0)
		const live = computed(() => {
			reads++
			return source.value
		})
		const presenting = ref(false)
		usePresentedSnapshot(live, presenting)
		const before = reads

		for (let frame = 1; frame <= 5; frame++) {
			source.value = frame
			await nextTick()
		}

		expect(reads).toBe(before)
	})
})

describe('useAronaPresenting', () => {
	function readIn(provided?: boolean) {
		let seen: boolean | undefined
		const Child = defineComponent({
			setup() {
				seen = useAronaPresenting().value
				return () => null
			},
		})
		mount(defineComponent({
			setup() {
				if (provided !== undefined) provideAronaPresenting(ref(provided))
				return () => h(Child)
			},
		}))
		return seen
	}

	it('reads what the assistant view provides', () => {
		expect(readIn(false)).toBe(false)
	})

	it('treats components outside an assistant view as shown', () => {
		expect(readIn()).toBe(true)
	})
})
