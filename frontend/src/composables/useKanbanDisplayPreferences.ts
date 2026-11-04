import {computed, ref, toValue, watch, type MaybeRefOrGetter} from 'vue'
import {useEventListener} from '@vueuse/core'
import {captureClientRequestContext, type ClientRequestContext} from '@/client/requestContext'

/** How one kanban view shows its cards on this device. Presentation only: no task or bucket changes. */
export type KanbanDisplayMode = 'cards' | 'groups'

type ViewEntry = {mode: KanbanDisplayMode, collapsed: string[], showParents: boolean, used: number}
export type StoredKanbanDisplay = {views: Record<string, ViewEntry>, clock: number}

export const MAX_STORED_VIEWS = 40
export const MAX_COLLAPSED_GROUPS = 400

export function kanbanDisplayStorageKey(context: ClientRequestContext = captureClientRequestContext()): string {
	return `kanban-display:v1:${JSON.stringify([context.apiBaseUrl, context.identity?.type ?? null, context.identity?.id ?? null])}`
}

// Each entry falls back on its own, so one damaged view never resets the others.
export function parseKanbanDisplay(raw: string | null): StoredKanbanDisplay {
	let value: unknown
	try {
		value = raw === null ? null : JSON.parse(raw)
	} catch {
		value = null
	}
	const record = typeof value === 'object' && value !== null ? value as Partial<StoredKanbanDisplay> : {}
	const views: Record<string, ViewEntry> = {}
	for (const [key, entry] of Object.entries(typeof record.views === 'object' && record.views !== null ? record.views : {})) {
		if (typeof entry !== 'object' || entry === null) continue
		views[key] = {
			mode: entry.mode === 'groups' ? 'groups' : 'cards',
			showParents: entry.showParents !== false,
			collapsed: Array.isArray(entry.collapsed)
				? entry.collapsed.filter((item): item is string => typeof item === 'string').slice(-MAX_COLLAPSED_GROUPS)
				: [],
			used: Number.isFinite(entry.used) ? entry.used : 0,
		}
	}
	return {views, clock: Number.isFinite(record.clock) ? record.clock! : 0}
}

/** Returns a new record with the view updated and marked most recent; the least recently used views drop out. */
export function updateKanbanDisplay(
	stored: StoredKanbanDisplay,
	view: string,
	patch: Partial<Pick<ViewEntry, 'mode' | 'collapsed' | 'showParents'>>,
): StoredKanbanDisplay {
	const clock = stored.clock + 1
	const current = stored.views[view] ?? {mode: 'cards', collapsed: [], used: 0}
	const next: ViewEntry = {
		mode: patch.mode ?? current.mode,
		showParents: patch.showParents ?? current.showParents ?? true,
		collapsed: [...new Set(patch.collapsed ?? current.collapsed)].slice(-MAX_COLLAPSED_GROUPS),
		used: clock,
	}
	const views = Object.entries({...stored.views, [view]: next})
		.sort(([, a], [, b]) => b.used - a.used)
		.slice(0, MAX_STORED_VIEWS)
	return {views: Object.fromEntries(views), clock}
}

// Session-only values when localStorage is unavailable or full.
const memory = new Map<string, string>()

function read(key: string): StoredKanbanDisplay {
	if (memory.has(key)) return parseKanbanDisplay(memory.get(key)!)
	try {
		return parseKanbanDisplay(localStorage.getItem(key))
	} catch {
		return parseKanbanDisplay(null)
	}
}

function write(key: string, value: StoredKanbanDisplay) {
	const raw = JSON.stringify(value)
	try {
		localStorage.setItem(key, raw)
		memory.delete(key)
	} catch {
		memory.set(key, raw)
	}
}

/**
 * Display mode and collapsed groups for one project view, per signed-in account (or link share) and API.
 * While `transient` is true (a search or filter is active), collapsing only lasts for that result, so a match is
 * never hidden behind a group collapsed earlier; the remembered state returns once the search ends.
 */
export function useKanbanDisplayPreferences(
	project: MaybeRefOrGetter<number>,
	view: MaybeRefOrGetter<number>,
	transient: MaybeRefOrGetter<string | null> = null,
) {
	const viewKey = computed(() => `${toValue(project)}:${toValue(view)}`)
	const stored = ref<StoredKanbanDisplay>(read(kanbanDisplayStorageKey()))
	const transientCollapsed = ref(new Set<string>())

	function reload() {
		stored.value = read(kanbanDisplayStorageKey())
	}
	watch(viewKey, reload)
	watch(() => toValue(transient), () => {
		transientCollapsed.value = new Set()
	})
	useEventListener(window, 'storage', event => {
		if (event.key === null || event.key === kanbanDisplayStorageKey()) reload()
	})

	const entry = computed(() => stored.value.views[viewKey.value])
	const mode = computed<KanbanDisplayMode>(() => entry.value?.mode ?? 'cards')
	const remembered = computed(() => new Set(entry.value?.collapsed ?? []))
	const collapsed = computed(() => toValue(transient) === null ? remembered.value : transientCollapsed.value)

	function save(patch: Partial<Pick<ViewEntry, 'mode' | 'collapsed' | 'showParents'>>) {
		// Re-read first: another tab or view may have written since this one loaded.
		const key = kanbanDisplayStorageKey()
		stored.value = updateKanbanDisplay(read(key), viewKey.value, patch)
		write(key, stored.value)
	}

	function setCollapsed(keys: readonly string[], value: boolean) {
		const next = new Set(collapsed.value)
		for (const key of keys) {
			if (value) next.add(key)
			else next.delete(key)
		}
		if (toValue(transient) !== null) transientCollapsed.value = next
		else save({collapsed: [...next]})
	}

	return {
		mode,
		showParents: computed(() => entry.value?.showParents ?? true),
		setShowParents: (value: boolean) => save({showParents: value}),
		collapsed,
		setMode: (value: KanbanDisplayMode) => save({mode: value}),
		setCollapsed,
	}
}
