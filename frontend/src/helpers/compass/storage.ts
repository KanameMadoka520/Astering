/**
 * Local storage for Compass, always under an account namespace (API server + user id). Values that
 * storage refuses (private mode, full quota) live in memory for this session so nothing typed is lost
 * just because the browser would not persist it.
 */

import {isDraftLeaseCurrent, type DraftLease} from '@/helpers/draftScope'

const PREFIX = 'tcymc-compass'
const DRAFT_PREFIX = `${PREFIX}-draft:`

const memory = new Map<string, string>()
const memoryLeases = new Map<string, DraftLease>()

export function compassAccountNamespace(apiBaseUrl: string, userId: number): string {
	return `${encodeURIComponent(apiBaseUrl)}:${userId}`
}

export function compassStorageKey(kind: string, namespace: string, ...parts: (string | number)[]): string {
	return [`${PREFIX}-${kind}:v1`, namespace, ...parts].join(':')
}

export function readCompassStorage(key: string): string | null {
	if (memory.has(key)) {
		const lease = memoryLeases.get(key)
		if (!lease || isDraftLeaseCurrent(lease)) return memory.get(key) ?? null
		memory.delete(key)
		memoryLeases.delete(key)
	}
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

/** Returns false when only the in-memory copy could be kept. */
export function writeCompassStorage(key: string, value: string, lease?: DraftLease): boolean {
	// Drafts the user just removed on logout stay removed, even if an unmounting desk still flushes.
	if (key.startsWith(DRAFT_PREFIX) && lease && (
		!isDraftLeaseCurrent(lease) || !key.startsWith(`${DRAFT_PREFIX}v1:${lease.namespace}:`)
	)) return true
	try {
		localStorage.setItem(key, value)
		memory.delete(key)
		memoryLeases.delete(key)
		return true
	} catch {
		memory.set(key, value)
		if (lease) memoryLeases.set(key, lease)
		else memoryLeases.delete(key)
		return false
	}
}

export function removeCompassStorage(key: string, lease?: DraftLease) {
	if (key.startsWith(DRAFT_PREFIX) && lease && (
		!isDraftLeaseCurrent(lease) || !key.startsWith(`${DRAFT_PREFIX}v1:${lease.namespace}:`)
	)) return
	memory.delete(key)
	memoryLeases.delete(key)
	try {
		localStorage.removeItem(key)
	} catch {
		// Nothing persisted to remove.
	}
}

/** Removes every key with this prefix, including copies only kept in memory. */
export function removeCompassStorageByPrefix(prefix: string) {
	for (const key of [...memory.keys()]) {
		if (key.startsWith(prefix)) {
			memory.delete(key)
			memoryLeases.delete(key)
		}
	}
	try {
		const keys: string[] = []
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index)
			if (key?.startsWith(prefix)) keys.push(key)
		}
		keys.forEach(key => localStorage.removeItem(key))
	} catch {
		// Nothing persisted to remove.
	}
}

/** Keys with this prefix, wherever they are kept. */
export function compassStorageKeys(prefix: string): string[] {
	const keys = new Set([...memory.keys()].filter(key => key.startsWith(prefix) && readCompassStorage(key) !== null))
	try {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index)
			if (key?.startsWith(prefix)) keys.add(key)
		}
	} catch {
		// Storage the browser refuses to read holds nothing.
	}
	return [...keys]
}

export function readCompassJson(key: string): unknown {
	const raw = readCompassStorage(key)
	if (raw === null) return null
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Last opened space
// ---------------------------------------------------------------------------

export function lastCompassSpaceKey(namespace: string): string {
	return compassStorageKey('last-space', namespace)
}

export function readLastCompassSpace(namespace: string): number {
	if (namespace === '') return 0
	const value = Number(readCompassStorage(lastCompassSpaceKey(namespace)))
	return Number.isInteger(value) && value > 0 ? value : 0
}

export function rememberCompassSpace(namespace: string, spaceId: number) {
	if (namespace === '' || spaceId <= 0) return
	writeCompassStorage(lastCompassSpaceKey(namespace), String(spaceId))
}

// ---------------------------------------------------------------------------
// Reading preferences
// ---------------------------------------------------------------------------

export const COMPASS_READING_FONTS = ['serif', 'sans'] as const
export type CompassReadingFont = typeof COMPASS_READING_FONTS[number]

export const COMPASS_READING_SIZES = ['small', 'medium', 'large'] as const
export type CompassReadingSize = typeof COMPASS_READING_SIZES[number]

export type CompassReadingPrefs = {
	font: CompassReadingFont
	size: CompassReadingSize
}

export const DEFAULT_COMPASS_READING_PREFS: CompassReadingPrefs = {
	font: 'serif',
	size: 'medium',
}

export function compassReadingPrefsKey(namespace: string): string {
	return compassStorageKey('reading', namespace)
}

export function parseCompassReadingPrefs(value: unknown): CompassReadingPrefs {
	const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
	return {
		font: (COMPASS_READING_FONTS as readonly unknown[]).includes(record.font)
			? record.font as CompassReadingFont
			: DEFAULT_COMPASS_READING_PREFS.font,
		size: (COMPASS_READING_SIZES as readonly unknown[]).includes(record.size)
			? record.size as CompassReadingSize
			: DEFAULT_COMPASS_READING_PREFS.size,
	}
}
