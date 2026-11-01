import {describe, it, expect} from 'vitest'

import {SHORTCUTS} from '@/constants/shortcuts'
import {shortcutBindingToDisplay} from '@/helpers/shortcut'

import {KEYBOARD_SHORTCUTS} from './shortcuts'

function getGroup(title: string) {
	const group = KEYBOARD_SHORTCUTS.find(group => group.title === title)
	expect(group).toBeDefined()
	return group!
}

function getShortcut(title: string, groupTitle: string) {
	const group = getGroup(groupTitle)
	const shortcut = group.shortcuts.find(shortcut => shortcut.title === title)
	expect(shortcut).toBeDefined()
	return shortcut!
}

describe('keyboard shortcuts help data', () => {
	it('uses the centralized toggle menu shortcut for the general help entry', () => {
		const shortcut = getShortcut('keyboardShortcuts.toggleMenu', 'keyboardShortcuts.general')

		expect(shortcut.keys).toEqual(shortcutBindingToDisplay(SHORTCUTS.toggleMenu).keys)
		expect(shortcut.combination).toBeUndefined()
	})

	it('uses the centralized show keyboard shortcuts binding for the help dialog trigger', () => {
		expect(shortcutBindingToDisplay(SHORTCUTS.showKeyboardShortcuts)).toEqual({
			keys: ['shift', '/'],
		})
	})

	it('uses the centralized overview navigation shortcut with sequence display', () => {
		const shortcut = getShortcut('keyboardShortcuts.navigation.overview', 'keyboardShortcuts.navigation.title')
		const expected = shortcutBindingToDisplay(SHORTCUTS.navigation.overview)

		expect(shortcut.keys).toEqual(expected.keys)
		expect(shortcut.combination).toEqual(expected.combination)
	})

	it('uses the centralized due date shortcut for the task detail help entry', () => {
		const shortcut = getShortcut('keyboardShortcuts.task.dueDate', 'keyboardShortcuts.task.title')
		const expected = shortcutBindingToDisplay(SHORTCUTS.taskDetail.dueDate)

		expect(shortcut.keys).toEqual(expected.keys)
		expect(shortcut.combination).toEqual(expected.combination)
	})

	// The "g …" go-to sequences are all bound through SHORTCUTS (the ". ." copy sequences are wired by hand in the task detail).
	it('lists only "g …" sequences that something actually listens for', () => {
		const bindings: string[] = []
		const collect = (value: unknown) => {
			if (typeof value === 'string') bindings.push(value)
			else if (value && typeof value === 'object') Object.values(value).forEach(collect)
		}
		collect(SHORTCUTS)
		const bound = bindings.map(binding => JSON.stringify(shortcutBindingToDisplay(binding)))

		const listed = KEYBOARD_SHORTCUTS.flatMap(group => group.shortcuts)
			.filter(shortcut => shortcut.combination === 'then' && shortcut.keys[0] === 'g')
		expect(listed.length).toBeGreaterThan(0)
		for (const shortcut of listed) {
			expect(bound, shortcut.title).toContain(JSON.stringify({keys: shortcut.keys, combination: 'then'}))
		}
	})
})
