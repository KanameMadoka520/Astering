<template>
	<DropdownItem
		v-if="supported"
		icon="sliders"
		:aria-disabled="opening || undefined"
		:aria-busy="opening || undefined"
		data-cy="nativeClientSettings"
		@click="open"
	>
		{{ t('androidClient.settings') }}
	</DropdownItem>
</template>

<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import DropdownItem from '@/components/misc/DropdownItem.vue'
import {getNativeAndroidClientInfo, openNativeAndroidClientSettings} from '@/helpers/nativeAndroid'
import {error} from '@/message'

const emit = defineEmits<{
	activate: [],
}>()
const {t} = useI18n({useScope: 'global'})
const supported = ref(false)
const opening = ref(false)
let active = true

onMounted(async () => {
	const info = await getNativeAndroidClientInfo()
	if (active) supported.value = info !== null
})
onBeforeUnmount(() => { active = false })

async function open() {
	if (!supported.value || opening.value) return
	opening.value = true
	emit('activate')
	try {
		await openNativeAndroidClientSettings()
	} catch (cause) {
		if (!active || (cause instanceof Error && cause.message === 'native_context_changed')) return
		error(new Error(t('androidClient.openFailed')))
	} finally {
		opening.value = false
	}
}
</script>
