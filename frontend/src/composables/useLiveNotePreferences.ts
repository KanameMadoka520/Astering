import {computed, onScopeDispose, ref} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {currentUserQuery, normalizeUserSettings, useUpdateSettingsMutation} from '@/client/queries/account'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {AUTH_TYPES} from '@/constants/auth'
import type {FrontendSettings} from '@/helpers/userSettings'

type RecordingPreferences = Pick<FrontendSettings,
	'live_notes_allow_background' | 'live_notes_keep_awake' | 'live_notes_timezone' | 'live_notes_auto_append' | 'live_notes_engine'>
type PreferenceKey = keyof RecordingPreferences

/** Account settings store choices, never microphone permission or an active recording. */
export function useLiveNotePreferences() {
	const owner = captureClientRequestContext()
	let disposed = false
	const current = () => !disposed && isClientRequestContextCurrent(owner)
	const account = useQuery({
		...currentUserQuery(owner.identity?.id ?? 0, AUTH_TYPES.USER),
		enabled: owner.identity?.type === AUTH_TYPES.USER && current(),
	})
	const mutation = useUpdateSettingsMutation()
	const draft = ref<Partial<RecordingPreferences>>({})
	const status = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
	const ready = computed(() => !!account.data.value && current())
	const saved = computed(() => normalizeUserSettings(account.data.value?.settings).frontend_settings)
	const allowBackground = computed(() => current() &&
		(draft.value.live_notes_allow_background ?? saved.value.live_notes_allow_background))
	const keepAwake = computed(() => current() &&
		(draft.value.live_notes_keep_awake ?? saved.value.live_notes_keep_awake))
	const autoAppend = computed(() => current() &&
		(draft.value.live_notes_auto_append ?? saved.value.live_notes_auto_append))
	const engine = computed(() => draft.value.live_notes_engine ?? saved.value.live_notes_engine)
	const timezone = computed(() => {
		const zone = (draft.value.live_notes_timezone ?? saved.value.live_notes_timezone) || account.data.value?.settings?.timezone
		try {
			return new Intl.DateTimeFormat('en', {timeZone: zone || undefined}).resolvedOptions().timeZone
		} catch {
			return 'UTC'
		}
	})

	async function persist() {
		if (!ready.value || !current() || !owner.identity || status.value === 'saving') return
		const patch = {...draft.value}
		if (!Object.keys(patch).length) return
		status.value = 'saving'
		try {
			await mutation.mutateAsync({
				id: owner.identity.id,
				type: AUTH_TYPES.USER,
				edits: {frontend_settings: patch},
				showMessage: false,
			})
			if (!current()) return
			draft.value = {}
			status.value = 'saved'
		} catch {
			// A failed write must not silently undo the user's visible choice.
			if (current()) status.value = 'error'
		}
	}

	async function setPreference<K extends PreferenceKey>(key: K, value: RecordingPreferences[K]) {
		if (!ready.value || !current() || status.value === 'saving') return
		if (key === 'live_notes_timezone') {
			try {
				new Intl.DateTimeFormat('en', {timeZone: String(value)}).format()
			} catch {
				return
			}
		}
		draft.value = {...draft.value, [key]: value}
		await persist()
	}

	async function reload() {
		if (current()) await account.refetch()
	}

	onScopeDispose(() => { disposed = true })
	return {
		allowBackground,
		keepAwake,
		timezone,
		autoAppend,
		engine,
		ready,
		loadFailed: account.isError,
		status,
		setPreference,
		retry: persist,
		reload,
	}
}
