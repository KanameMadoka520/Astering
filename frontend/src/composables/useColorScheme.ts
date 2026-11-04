import {computed, readonly} from 'vue'
import {createSharedComposable, usePreferredColorScheme} from '@vueuse/core'
import {useAuthStore} from '@/stores/auth'

// Shared account preference; App applies the resolved scheme once initial navigation has loaded it.
export const useColorScheme = createSharedComposable(() => {
	const authStore = useAuthStore()
	const store = computed(() => authStore.settings.frontend_settings.color_schema)
	const preferredColorScheme = usePreferredColorScheme()
	const isStarlight = computed(() => store.value === 'starlight')
	const isDark = computed(() => store.value === 'auto'
		? preferredColorScheme.value === 'dark'
		: store.value === 'dark' || isStarlight.value)

	return {
		store,
		isDark: readonly(isDark),
		isStarlight: readonly(isStarlight),
	}
})
