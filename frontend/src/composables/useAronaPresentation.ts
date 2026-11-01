import {inject, provide, readonly, ref, shallowRef, watch, type InjectionKey, type Ref} from 'vue'

const PRESENTING: InjectionKey<Readonly<Ref<boolean>>> = Symbol('arona-presenting')
const ALWAYS = readonly(ref(true))
const HIDDEN = Symbol('hidden')

/** Set by an assistant view: whether its conversation is on screen (panel open and page visible). */
export function provideAronaPresenting(presenting: Readonly<Ref<boolean>>) {
	provide(PRESENTING, presenting)
}

/** Outside an assistant view nothing is hidden, so components keep ticking as before. */
export function useAronaPresenting(): Readonly<Ref<boolean>> {
	return inject(PRESENTING, ALWAYS)
}

/**
 * What the view renders of `live`. It follows `live` only while presenting and takes its newest value as soon as
 * it is presented again, so nothing is replayed or lost: `live` is the query cache, which keeps filling meanwhile.
 * A view mounted while hidden holds nothing until it is first shown.
 */
export function usePresentedSnapshot<T>(
	live: Readonly<Ref<T>>,
	presenting: Readonly<Ref<boolean>>,
): Readonly<Ref<T | undefined>> {
	const shown = shallowRef<T | undefined>(presenting.value ? live.value : undefined)
	// While hidden the getter does not read `live`, so streamed frames do not even wake this watch.
	watch(() => presenting.value ? live.value : HIDDEN, value => {
		if (value !== HIDDEN) shown.value = value
	})
	return shown
}
