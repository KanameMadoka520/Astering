import {computed, readonly, ref, type ComputedRef, type Ref} from 'vue'
import {captureClientRequestContext, type ClientRequestContext} from '@/client/requestContext'

/** How Arona replies open by default on this device. Presentation only: saved steps and tool records are untouched. */
export type AronaDisplayPreferences = {
	showIntermediate: boolean
	expandReasoning: boolean
	expandToolDetails: boolean
}

export const defaultAronaDisplayPreferences: Readonly<AronaDisplayPreferences> = Object.freeze({
	showIntermediate: true,
	expandReasoning: false,
	expandToolDetails: false,
})

export function aronaDisplayStorageKey(context: ClientRequestContext = captureClientRequestContext()): string {
	return `arona-display:v1:${JSON.stringify([context.apiBaseUrl, context.identity?.type ?? null, context.identity?.id ?? null])}`
}

// One state for every card, the floating panel and the full page.
const state = ref<AronaDisplayPreferences>({...defaultAronaDisplayPreferences})
const exposed = readonly(state)
// Session-only values when localStorage is unavailable or full.
const memory = new Map<string, AronaDisplayPreferences>()
let loadedKey: string | null = null
let listening = false

const FIELDS = ['showIntermediate', 'expandReasoning', 'expandToolDetails'] as const
type StoredPreferences = Partial<Record<keyof AronaDisplayPreferences, unknown>>

// Each field falls back on its own, so one bad value never resets the others.
function merge(base: AronaDisplayPreferences, value: unknown): AronaDisplayPreferences {
	const record: StoredPreferences = typeof value === 'object' && value !== null ? value as StoredPreferences : {}
	const next = {...base}
	for (const name of FIELDS) {
		const item = record[name]
		if (typeof item === 'boolean') next[name] = item
	}
	return next
}

function parse(raw: string | null): AronaDisplayPreferences {
	let value: unknown
	try {
		value = raw === null ? null : JSON.parse(raw)
	} catch {
		value = null
	}
	return merge({...defaultAronaDisplayPreferences}, value)
}

function read(key: string): AronaDisplayPreferences {
	const kept = memory.get(key)
	if (kept) return {...kept}
	try {
		return parse(localStorage.getItem(key))
	} catch {
		return {...defaultAronaDisplayPreferences}
	}
}

function write(key: string, value: AronaDisplayPreferences | null) {
	try {
		if (value === null) localStorage.removeItem(key)
		else localStorage.setItem(key, JSON.stringify(value))
		memory.delete(key)
	} catch {
		if (value === null) memory.delete(key)
		else memory.set(key, {...value})
	}
}

// The key follows the signed-in account and API, so re-read whenever it changes.
function sync(): string {
	const key = aronaDisplayStorageKey()
	if (key !== loadedKey) {
		loadedKey = key
		state.value = read(key)
	}
	return key
}

function listen() {
	if (listening || typeof window === 'undefined') return
	listening = true
	// Other tabs may change these preferences, clear storage or sign in to another account.
	window.addEventListener('storage', event => {
		if (event.key === null) loadedKey = null
		const key = sync()
		if (event.key === key) state.value = parse(event.newValue)
	})
}

export function useAronaDisplayPreferences(): {
	preferences: Readonly<Ref<AronaDisplayPreferences>>
	update(patch: Partial<AronaDisplayPreferences>): void
	reset(): void
	} {
	listen()
	sync()
	return {
		preferences: exposed,
		update(patch) {
			const key = sync()
			state.value = merge(state.value, patch)
			write(key, state.value)
		},
		reset() {
			const key = sync()
			state.value = {...defaultAronaDisplayPreferences}
			write(key, null)
		},
	}
}

/**
 * Open state for one disclosure: follows its preference until the user toggles it, then stays local to it.
 * Bind :open="open" and @toggle="onToggle".
 */
export function usePreferredOpen(preferred: () => boolean): {open: ComputedRef<boolean>, onToggle(event: Event): void} {
	const choice = ref<boolean | null>(null)
	const open = computed(() => choice.value ?? preferred())
	return {
		open,
		onToggle(event) {
			const next = (event.target as HTMLDetailsElement).open
			// Applying a preference also fires toggle; only a real difference is the user's own choice.
			if (next !== open.value) choice.value = next
		},
	}
}
