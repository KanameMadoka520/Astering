import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
	compassAccountNamespace,
	compassReadingPrefsKey,
	compassStorageKey,
	DEFAULT_COMPASS_READING_PREFS,
	lastCompassSpaceKey,
	parseCompassReadingPrefs,
	readCompassJson,
	readCompassStorage,
	readLastCompassSpace,
	rememberCompassSpace,
	removeCompassStorage,
	writeCompassStorage,
} from './storage'

const namespace = compassAccountNamespace('https://a.example/api/v2', 7)
const key = compassStorageKey('test', namespace, 'value')

function refusingStorage(stored: Map<string, string>) {
	return {
		getItem: (name: string) => stored.get(name) ?? null,
		setItem: () => {
			throw new DOMException('Quota exceeded', 'QuotaExceededError')
		},
		removeItem: (name: string) => {
			stored.delete(name)
		},
	}
}

beforeEach(() => {
	localStorage.clear()
})

afterEach(() => {
	vi.unstubAllGlobals()
	// The in-memory fallback outlives a test; clear it through the module.
	removeCompassStorage(key)
	localStorage.clear()
})

describe('keys', () => {
	it('separates API servers and accounts, even when the URL contains the separator', () => {
		expect(namespace).toBe('https%3A%2F%2Fa.example%2Fapi%2Fv2:7')
		const keys = new Set([
			lastCompassSpaceKey(namespace),
			lastCompassSpaceKey(compassAccountNamespace('https://b.example/api/v2', 7)),
			lastCompassSpaceKey(compassAccountNamespace('https://a.example/api/v2', 8)),
			lastCompassSpaceKey(compassAccountNamespace('https://a.example:7/api/v2', 0)),
		])

		expect(keys.size).toBe(4)
	})

	it('versions every kind of value under its own prefix', () => {
		expect(compassStorageKey('draft', namespace, 3, 'new')).toBe(`tcymc-compass-draft:v1:${namespace}:3:new`)
		expect(lastCompassSpaceKey(namespace)).toBe(`tcymc-compass-last-space:v1:${namespace}`)
		expect(compassReadingPrefsKey(namespace)).toBe(`tcymc-compass-reading:v1:${namespace}`)
	})
})

describe('readCompassStorage / writeCompassStorage', () => {
	it('persists, reads and removes a value', () => {
		expect(writeCompassStorage(key, 'kept')).toBe(true)
		expect(localStorage.getItem(key)).toBe('kept')
		expect(readCompassStorage(key)).toBe('kept')

		removeCompassStorage(key)

		expect(localStorage.getItem(key)).toBeNull()
		expect(readCompassStorage(key)).toBeNull()
	})

	it('keeps a refused write for the session, ahead of the older stored copy', () => {
		const stored = new Map([[key, 'older']])
		vi.stubGlobal('localStorage', refusingStorage(stored))

		expect(writeCompassStorage(key, 'newer')).toBe(false)
		expect(readCompassStorage(key)).toBe('newer')

		removeCompassStorage(key)

		expect(stored.has(key)).toBe(false)
		expect(readCompassStorage(key)).toBeNull()
	})

	it('lets a later successful write replace the session copy', () => {
		vi.stubGlobal('localStorage', refusingStorage(new Map()))
		writeCompassStorage(key, 'offline')
		vi.unstubAllGlobals()

		expect(writeCompassStorage(key, 'online')).toBe(true)
		localStorage.setItem(key, 'changed in another tab')

		expect(readCompassStorage(key)).toBe('changed in another tab')
	})

	it('reads nothing instead of throwing when storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new DOMException('Denied', 'SecurityError')
			},
		})

		expect(readCompassStorage(key)).toBeNull()
		expect(readCompassJson(key)).toBeNull()
	})

	it('parses JSON and ignores what is not JSON', () => {
		writeCompassStorage(key, '{"a":1}')
		expect(readCompassJson(key)).toEqual({a: 1})

		writeCompassStorage(key, '{broken')
		expect(readCompassJson(key)).toBeNull()
	})
})

describe('last opened space', () => {
	it('remembers one space per account', () => {
		const other = compassAccountNamespace('https://a.example/api/v2', 8)
		rememberCompassSpace(namespace, 12)
		rememberCompassSpace(other, 4)

		expect(readLastCompassSpace(namespace)).toBe(12)
		expect(readLastCompassSpace(other)).toBe(4)
	})

	it('never remembers without an account or for an invalid id', () => {
		rememberCompassSpace(namespace, 5)
		rememberCompassSpace(namespace, 0)
		rememberCompassSpace(namespace, -1)
		rememberCompassSpace('', 9)

		expect(readLastCompassSpace(namespace)).toBe(5)
		expect(readCompassStorage(lastCompassSpaceKey(''))).toBeNull()
		expect(readLastCompassSpace('')).toBe(0)
	})

	it('treats anything but a positive whole number as no space', () => {
		for (const value of ['0', '-3', '2.5', 'abc', '']) {
			localStorage.setItem(lastCompassSpaceKey(namespace), value)
			expect(readLastCompassSpace(namespace)).toBe(0)
		}
	})
})

describe('parseCompassReadingPrefs', () => {
	it('keeps valid choices', () => {
		expect(parseCompassReadingPrefs({font: 'sans', size: 'large'})).toEqual({font: 'sans', size: 'large'})
	})

	it('repairs each unknown field on its own', () => {
		expect(parseCompassReadingPrefs({font: 'mono', size: 'small'})).toEqual({font: 'serif', size: 'small'})
		expect(parseCompassReadingPrefs({font: 'sans', size: 'huge'})).toEqual({font: 'sans', size: 'medium'})
	})

	it('falls back to the defaults for anything that is not an object', () => {
		for (const value of [null, undefined, 'sans', 3, []]) {
			expect(parseCompassReadingPrefs(value)).toEqual(DEFAULT_COMPASS_READING_PREFS)
		}
	})
})
