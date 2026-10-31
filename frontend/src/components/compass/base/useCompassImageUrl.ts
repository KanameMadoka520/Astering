import {onBeforeUnmount, ref, watch} from 'vue'
import {
	fetchCompassImageUrl,
	releaseCompassImageUrl,
} from '@/helpers/compass/imageUrls'

export type CompassImageUrlState = 'none' | 'loading' | 'ready' | 'failed'

/**
 * One image of a space as a blob: url that this component owns: replaced when the file changes and released
 * when it goes away. A file id of 0 means no image.
 */
export function useCompassImageUrl(spaceId: () => number, fileId: () => number) {
	const url = ref<string | null>(null)
	const state = ref<CompassImageUrlState>('none')
	let generation = 0

	function release() {
		releaseCompassImageUrl(url.value)
		url.value = null
	}

	watch([spaceId, fileId], async ([space, file]) => {
		const current = ++generation
		release()
		if (space <= 0 || file <= 0) {
			state.value = 'none'
			return
		}
		state.value = 'loading'
		let next: string
		try {
			next = await fetchCompassImageUrl(space, file)
		} catch {
			if (current === generation) state.value = 'failed'
			return
		}
		if (current !== generation) {
			releaseCompassImageUrl(next)
			return
		}
		url.value = next
		state.value = 'ready'
	}, {immediate: true})

	onBeforeUnmount(() => {
		generation++
		release()
	})

	return {
		url,
		state,
	}
}
