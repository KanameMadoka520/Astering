import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {effectScope, nextTick, ref} from 'vue'

const identity = vi.hoisted(() => ({current: {type: 1, id: 7} as {type: number, id: number} | null}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => ({identity: identity.current, authSessionEpoch: 0, apiBaseUrl: 'https://api.test/api/v1'}),
}))

import {
	MAX_COLLAPSED_GROUPS,
	MAX_STORED_VIEWS,
	kanbanDisplayStorageKey,
	parseKanbanDisplay,
	updateKanbanDisplay,
	useKanbanDisplayPreferences,
} from './useKanbanDisplayPreferences'

function mount(project = ref(1), view = ref(4), transient = ref<string | null>(null)) {
	const scope = effectScope()
	const preferences = scope.run(() => useKanbanDisplayPreferences(project, view, transient))!
	return {preferences, scope, project, view, transient}
}

describe('kanban display preferences', () => {
	beforeEach(() => {
		localStorage.clear()
		identity.current = {type: 1, id: 7}
	})
	afterEach(() => localStorage.clear())

	it('defaults to cards and remembers groups per project view', async () => {
		const {preferences, view, scope} = mount()
		expect(preferences.mode.value).toBe('cards')
		preferences.setMode('groups')
		expect(preferences.mode.value).toBe('groups')

		view.value = 5
		await nextTick()
		expect(preferences.mode.value).toBe('cards')
		view.value = 4
		await nextTick()
		expect(preferences.mode.value).toBe('groups')
		scope.stop()
	})

	it('keeps accounts and link shares apart', () => {
		const first = mount()
		first.preferences.setMode('groups')
		first.preferences.setCollapsed(['3:10'], true)
		first.scope.stop()

		identity.current = {type: 2, id: 7}
		const share = mount()
		expect(share.preferences.mode.value).toBe('cards')
		expect(share.preferences.collapsed.value.size).toBe(0)
		share.scope.stop()
		expect(kanbanDisplayStorageKey()).not.toBe(kanbanDisplayStorageKey({
			identity: {type: 1, id: 7} as never,
			authSessionEpoch: 0,
			apiBaseUrl: 'https://api.test/api/v1',
		}))
	})

	it('collapses reversibly and keeps search-time collapsing out of the remembered state', async () => {
		const {preferences, transient, scope} = mount()
		preferences.setCollapsed(['3:10', '3:20'], true)
		preferences.setCollapsed(['3:20'], false)
		expect([...preferences.collapsed.value]).toEqual(['3:10'])

		transient.value = '{"q":"step"}'
		await nextTick()
		// A search shows every match: the remembered collapse does not apply to it.
		expect(preferences.collapsed.value.size).toBe(0)
		preferences.setCollapsed(['3:30'], true)
		expect([...preferences.collapsed.value]).toEqual(['3:30'])

		transient.value = null
		await nextTick()
		expect([...preferences.collapsed.value]).toEqual(['3:10'])
		scope.stop()
	})

	it('bounds stored views and collapsed groups, dropping the least recently used', () => {
		let stored = parseKanbanDisplay(null)
		for (let view = 1; view <= MAX_STORED_VIEWS + 5; view++) stored = updateKanbanDisplay(stored, `1:${view}`, {mode: 'groups'})
		expect(Object.keys(stored.views)).toHaveLength(MAX_STORED_VIEWS)
		expect(stored.views['1:1']).toBeUndefined()
		expect(stored.views[`1:${MAX_STORED_VIEWS + 5}`]?.mode).toBe('groups')

		const many = Array.from({length: MAX_COLLAPSED_GROUPS + 10}, (_, i) => `1:${i}`)
		stored = updateKanbanDisplay(stored, '1:1', {collapsed: many})
		expect(stored.views['1:1'].collapsed).toHaveLength(MAX_COLLAPSED_GROUPS)
		expect(stored.views['1:1'].collapsed.at(-1)).toBe(many.at(-1))
	})

	it('survives damaged storage', () => {
		expect(parseKanbanDisplay('{not json').views).toEqual({})
		const parsed = parseKanbanDisplay(JSON.stringify({views: {'1:4': {mode: 'odd', collapsed: [1, '2:3']}, '1:5': null}}))
		expect(parsed.views['1:4']).toEqual({mode: 'cards', collapsed: ['2:3'], showParents: true, used: 0})
		expect(parsed.views['1:5']).toBeUndefined()
	})

	it('keeps working in memory when storage refuses writes', () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('full', 'QuotaExceededError')
		})
		const {preferences, scope} = mount()
		preferences.setMode('groups')
		expect(preferences.mode.value).toBe('groups')
		scope.stop()
		setItem.mockRestore()
	})
})
