import {captureDraftLease} from '@/helpers/draftScope'
import {
	computed,
	onScopeDispose,
	readonly,
	ref,
	toValue,
	watch,
	type MaybeRefOrGetter,
	type Ref,
} from 'vue'
import {useEventListener} from '@vueuse/core'
import {
	changedCompassDraftFields,
	clearCompassDraft,
	compassDraftKey,
	loadCompassDraft,
	saveCompassDraft,
	type CompassDraft,
	type CompassDraftFields,
} from '@/helpers/compass/drafts'

// Long enough to skip most keystrokes; steady typing still gets written at least this often.
const PERSIST_DELAY = 800
const PERSIST_MAX_WAIT = 4000

export type CompassDraftBase = {
	fields: CompassDraftFields
	// The server revision the fields came from; 0 while the entry does not exist yet.
	revision: number
}

/**
 * - clean: the fields match the saved version, nothing is kept locally
 * - pending: changed, and not yet written to this device
 * - stored: this device holds the changes (the last few keystrokes may still be on their way)
 */
export type CompassDraftPersistence = 'clean' | 'pending' | 'stored'

export type CompassStoredDraft = {
	draft: CompassDraft
	// Written against an older version than the one now open; applying it silently would undo someone's save.
	stale: boolean
}

export type CompassEntryDraftOptions = {
	namespace: MaybeRefOrGetter<string>
	spaceId: number
	// Changes once, from 0 to the new id, when the entry is created from this page.
	entryId: Ref<number>
	fields: Ref<CompassDraftFields>
	base: MaybeRefOrGetter<CompassDraftBase>
	// While true nothing is written or removed, e.g. while the writer decides about an older draft.
	hold?: MaybeRefOrGetter<boolean>
}

export function cloneCompassDraftFields(fields: CompassDraftFields): CompassDraftFields {
	return {
		...fields,
		tags: [...fields.tags],
	}
}

/**
 * Keeps the writing desk's unsaved text on this device, per account, API server, space and entry.
 * The draft is written 800 ms after the last change, removed once the fields match the saved version
 * again, and moved to the entry's own slot when a new entry gets created.
 */
export function useCompassEntryDraft(options: CompassEntryDraftOptions) {
	const {spaceId, entryId, fields} = options

	// Drafts belong to the account that opened the page. A later account switch remounts the desk, and
	// whatever is still pending goes to the account that typed it, never to the next one.
	const owner = ref(toValue(options.namespace))
	let lease = captureDraftLease(toValue(options.namespace))
	watch(() => toValue(options.namespace), namespace => {
		if (owner.value === '') {
			owner.value = namespace
			lease = captureDraftLease(namespace)
		}
	})

	function keyFor(id: number): string {
		return owner.value === '' ? '' : compassDraftKey(owner.value, spaceId, id)
	}

	function holding(): boolean {
		return toValue(options.hold) ?? false
	}

	// Pin belongs to the writing only while the entry does not exist yet; afterwards it is set from the reader.
	function changed(): (keyof CompassDraftFields)[] {
		return changedCompassDraftFields(fields.value, toValue(options.base).fields)
			.filter(field => field !== 'pinned' || entryId.value === 0)
	}

	const initialKey = keyFor(entryId.value)
	const found = initialKey === '' ? null : loadCompassDraft(initialKey, spaceId, entryId.value)
	const stored: CompassStoredDraft | null = found && {
		draft: found,
		stale: entryId.value > 0 && found.baseRevision !== toValue(options.base).revision,
	}

	const changedFields = computed(changed)
	const dirty = computed(() => changedFields.value.length > 0)
	const persistence = ref<CompassDraftPersistence>('clean')
	const storeFailed = ref(false)

	let timer: ReturnType<typeof setTimeout> | undefined
	let pendingSince = 0
	let knownEntryId = entryId.value
	// Set by restore(): the fields were just read from storage, so writing them back would change nothing.
	let restoring = false
	let active = true

	function cancel() {
		if (timer === undefined) return
		clearTimeout(timer)
		timer = undefined
	}

	function removeAt(id: number) {
		const key = keyFor(id)
		if (key !== '') clearCompassDraft(key, lease)
	}

	/** Writes the changes now. Returns false when they could only be kept in this tab's memory. */
	function persistNow(): boolean {
		cancel()
		if (holding() || changed().length === 0) return true
		const key = keyFor(entryId.value)
		// Without an account there is no place that only this person can read: keep nothing.
		if (key === '') {
			storeFailed.value = true
			return false
		}
		const ok = saveCompassDraft(key, {
			v: 1,
			spaceId,
			entryId: entryId.value,
			baseRevision: toValue(options.base).revision,
			savedAt: new Date().toISOString(),
			fields: cloneCompassDraftFields(fields.value),
		}, lease)
		storeFailed.value = !ok
		persistence.value = 'stored'
		return ok
	}

	function schedule() {
		const now = Date.now()
		if (timer !== undefined) {
			if (now - pendingSince >= PERSIST_MAX_WAIT) return
			clearTimeout(timer)
		} else {
			pendingSince = now
		}
		timer = setTimeout(persistNow, PERSIST_DELAY)
	}

	/** Brings storage in line with the fields, the base and the entry id. Runs on every change. */
	function settle() {
		const moved = entryId.value !== knownEntryId
		if (moved) {
			// The text now belongs to the entry that was just created; its old slot must not offer it again.
			removeAt(knownEntryId)
			knownEntryId = entryId.value
		}
		if (holding()) return
		if (changed().length === 0) {
			cancel()
			removeAt(entryId.value)
			restoring = false
			persistence.value = 'clean'
			return
		}
		if (restoring) {
			restoring = false
			persistence.value = 'stored'
			return
		}
		// Unmounted (e.g. a save finished after leaving): there is no later moment to write in. Just moved:
		// the old slot is already gone, so the new one must not wait for the debounce.
		if (!active || moved) {
			persistNow()
			return
		}
		if (persistence.value === 'clean') persistence.value = 'pending'
		schedule()
	}

	watch(
		[
			fields,
			() => toValue(options.base),
			entryId,
			holding,
		],
		() => settle(),
		{deep: true},
	)

	/** Applies a draft read from storage that still matches the open version, without writing it again. */
	function restore(next: CompassDraftFields) {
		restoring = true
		fields.value = cloneCompassDraftFields(next)
	}

	/** Forgets the stored draft. The fields stay as they are; the caller decides what to show. */
	function clear() {
		cancel()
		restoring = false
		removeAt(entryId.value)
		persistence.value = 'clean'
		storeFailed.value = false
	}

	useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
		if (holding() || changed().length === 0) return
		persistNow()
		event.preventDefault()
	})
	// Mobile browsers often skip beforeunload; these are the last reliable moments to write.
	useEventListener(window, 'pagehide', () => {
		if (timer !== undefined) persistNow()
	})
	useEventListener(document, 'visibilitychange', () => {
		if (document.visibilityState === 'hidden' && timer !== undefined) persistNow()
	})

	onScopeDispose(() => {
		active = false
		if (timer !== undefined) persistNow()
	})

	return {
		/** What this device held for the page when it opened, if anything. */
		stored,
		changedFields,
		dirty,
		persistence: readonly(persistence),
		storeFailed: readonly(storeFailed),
		persistNow,
		clear,
		restore,
		settle,
	}
}
