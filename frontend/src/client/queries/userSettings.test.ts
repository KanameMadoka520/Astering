import {beforeEach, describe, expect, it, vi} from 'vitest'

import type {SupportedLocale} from '@/i18n'
import {createUserSettingsDraft, normalizeUserSettings} from './account'

describe('normalizeUserSettings', () => {
	beforeEach(() => {
		vi.stubGlobal('navigator', {language: 'de-DE'})
	})

	it('falls back to the browser language when the api returns an empty language', () => {
		// The api sends a plain string, which can be outside the SupportedLocale union
		const settings = normalizeUserSettings({language: '' as SupportedLocale})

		expect(settings.language).toBe('de-DE')
	})

	it('falls back to the browser language when the api returns null', () => {
		const settings = normalizeUserSettings({language: null as never})

		expect(settings.language).toBe('de-DE')
	})

	it('falls back to the browser language when no language is passed', () => {
		const settings = normalizeUserSettings({})

		expect(settings.language).toBe('de-DE')
	})

	it('keeps the language returned by the api', () => {
		const settings = normalizeUserSettings({language: 'fr-FR'})

		expect(settings.language).toBe('fr-FR')
	})

	it('defaults live recording preferences to off and only accepts explicit booleans', () => {
		const defaults = normalizeUserSettings().frontend_settings
		expect(defaults.live_notes_allow_background).toBe(false)
		expect(defaults.live_notes_keep_awake).toBe(false)
		const enabled = normalizeUserSettings({frontend_settings: {
			live_notes_allow_background: true,
			live_notes_keep_awake: true,
		}}).frontend_settings
		expect(enabled.live_notes_allow_background).toBe(true)
		expect(enabled.live_notes_keep_awake).toBe(true)
		const malformed = normalizeUserSettings({frontend_settings: {
			live_notes_allow_background: 'true',
			live_notes_keep_awake: 1,
		}}).frontend_settings
		expect(malformed.live_notes_allow_background).toBe(false)
		expect(malformed.live_notes_keep_awake).toBe(false)
	})

	it('gives the form a draft that does not share nested objects with the read path', () => {
		const stored = normalizeUserSettings({frontend_settings: {quick_add_default_reminders: [{relative_period: 60}]}})
		const draft = createUserSettingsDraft(stored)

		draft.frontend_settings.quick_add_default_reminders[0].relative_period = 120

		expect(stored.frontend_settings.quick_add_default_reminders[0].relative_period).toBe(60)
	})

	it('drops extra settings links whose url is not http(s)', () => {
		const settings = normalizeUserSettings({
			extra_settings_links: {
				a: {
					text: 'x',
					url: 'javascript:alert(1)',
				},
				b: {
					text: 'y',
					url: '/settings',
				},
			},
		})

		expect(settings.extra_settings_links).toEqual({
			b: {
				text: 'y',
				url: '/settings',
			},
		})
	})
})
