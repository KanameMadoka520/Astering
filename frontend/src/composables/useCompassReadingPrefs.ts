import {ref, watch} from 'vue'
import {useEventListener} from '@vueuse/core'
import {useCompassAccountNamespace} from '@/composables/useCompass'
import {
	compassReadingPrefsKey,
	parseCompassReadingPrefs,
	readCompassJson,
	writeCompassStorage,
	DEFAULT_COMPASS_READING_PREFS,
	type CompassReadingPrefs,
} from '@/helpers/compass/storage'

/** Font and size for long reading, kept per account on this device and synced across tabs. */
export function useCompassReadingPrefs() {
	const namespace = useCompassAccountNamespace()
	const prefs = ref<CompassReadingPrefs>({...DEFAULT_COMPASS_READING_PREFS})

	watch(namespace, value => {
		prefs.value = value === ''
			? {...DEFAULT_COMPASS_READING_PREFS}
			: parseCompassReadingPrefs(readCompassJson(compassReadingPrefsKey(value)))
	}, {immediate: true})

	useEventListener(window, 'storage', event => {
		if (namespace.value === '' || event.key !== compassReadingPrefsKey(namespace.value)) return
		prefs.value = parseCompassReadingPrefs(readCompassJson(event.key))
	})

	function setPrefs(next: Partial<CompassReadingPrefs>) {
		prefs.value = {...prefs.value, ...next}
		if (namespace.value !== '') {
			writeCompassStorage(compassReadingPrefsKey(namespace.value), JSON.stringify(prefs.value))
		}
	}

	return {prefs, setPrefs}
}
