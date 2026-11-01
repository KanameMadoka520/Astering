import {inject, provide, readonly, ref, type InjectionKey, type Ref} from 'vue'
import type {LocalSteer} from '@/helpers/turnSteering'

// Injected rather than passed through the thread, whose props must stay still while answers stream.
const OUTBOX: InjectionKey<Readonly<Ref<readonly LocalSteer[]>>> = Symbol('arona-steering-outbox')
const EMPTY = readonly(ref<readonly LocalSteer[]>([]))

/** Set by an assistant view: the instructions it is sending or has just sent. */
export function provideSteeringOutbox(entries: Readonly<Ref<readonly LocalSteer[]>>) {
	provide(OUTBOX, entries)
}

export function useSteeringOutbox(): Readonly<Ref<readonly LocalSteer[]>> {
	return inject(OUTBOX, EMPTY)
}
