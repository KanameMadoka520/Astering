<template>
	<img
		v-if="url"
		ref="element"
		class="drive-thumbnail"
		:src="url"
		:alt="decorative ? '' : (file.file?.name || '')"
		loading="lazy"
		decoding="async"
	>
	<span
		v-else
		ref="element"
		class="drive-file-symbol"
		aria-hidden="true"
	><Icon :icon="symbol" /></span>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useObjectUrl} from '@vueuse/core'
import type {DriveEntry} from '@/client/queries/drive'
import {drivePreviewQuery} from '@/client/queries/drive'
import {useNearViewport} from '@/composables/useNearViewport'

const props = withDefaults(defineProps<{
	file: DriveEntry
	// Next to the file name the picture adds nothing for screen readers.
	decorative?: boolean
}>(), {
	decorative: false,
})
const PREVIEWABLE = /^image\/(png|jpeg|webp|gif)$/
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024

const mime = computed(() => props.file.file?.mime ?? '')
const image = computed(() => PREVIEWABLE.test(mime.value) && (props.file.file?.size ?? 0) < MAX_PREVIEW_BYTES)
const symbol = computed(() => {
	if (mime.value.startsWith('image/')) return 'file-image'
	return mime.value === 'application/pdf' ? 'file-pdf' : 'file'
})
// A page holds 60 cards; `loading="lazy"` cannot delay bytes fetched before the image has a URL.
const element = ref<HTMLElement>()
const near = useNearViewport(element)
const query = useQuery(computed(() => ({
	...drivePreviewQuery(props.file.file_id),
	enabled: image.value && !props.file.purging && near.value,
})))
const url = useObjectUrl(computed(() => image.value ? query.data.value : undefined))
</script>

<style scoped>
.drive-thumbnail {
	display: block;
	inline-size: 100%;
	block-size: 100%;
	object-fit: cover;
}

.drive-file-symbol {
	display: grid;
	place-items: center;
	inline-size: 100%;
	block-size: 100%;
	color: var(--accent-text);
	font-size: var(--thumb-icon-size, var(--text-2xl));
}
</style>
