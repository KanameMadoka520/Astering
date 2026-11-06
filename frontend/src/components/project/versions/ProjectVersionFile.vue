<template>
	<div class="version-file">
		<img
			v-if="imageUrl"
			:src="imageUrl"
			:alt="name"
			loading="lazy"
		>
		<p
			v-else-if="isLoading"
			role="status"
		>
			{{ t('misc.loading') }}
		</p>
		<LoadError
			v-if="isError"
			:retry="() => refetch()"
		/>
		<XButton
			:loading="downloading"
			:aria-disabled="downloading"
			variant="secondary"
			@click="download"
		>
			{{ t('drive.download') }}
		</XButton>
		<p
			v-if="failure"
			role="alert"
		>
			{{ failure }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {
	computed,
	onScopeDispose,
	ref,
	watch,
} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useObjectUrl} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {
	fetchProjectVersionFile,
	projectVersionFileQuery,
	projectVersionErrorText,
} from '@/client/queries/projectVersions'
import {downloadBlob} from '@/helpers/downloadBlob'
import {isRequestContextAbort} from '@/client/requestContext'

const props = defineProps<{
	project: number,
	version: number,
	file: number,
	name: string,
	image?: boolean,
}>()
const {t} = useI18n({useScope: 'global'})
const downloading = ref(false)
const failure = ref('')
let live = true
let generation = 0
let controller: AbortController | undefined
watch(() => `${props.project}/${props.version}/${props.file}`, () => {
	generation++
	controller?.abort()
	downloading.value = false
	failure.value = ''
})
onScopeDispose(() => {
	live = false
	generation++
	controller?.abort()
})
const {
	data, isError, isLoading, refetch,
} = useQuery(computed(() => ({
	...projectVersionFileQuery(props.project, props.version, props.file),
	enabled: props.image === true,
})))
// Raster images cannot script in our origin. SVG/HTML originals are offered only as downloads.
const imageBlob = computed(() => !isError.value && data.value && /^image\/(?:png|jpeg|gif|webp|avif|bmp)(?:;|$)/i.test(data.value.type)
	? data.value : undefined)
const imageUrl = useObjectUrl(imageBlob)

async function download() {
	if (downloading.value) return
	const request = ++generation
	const abort = new AbortController()
	controller = abort
	const name = props.name
	downloading.value = true
	failure.value = ''
	try {
		const blob = await fetchProjectVersionFile(props.project, props.version, props.file, abort.signal)
		if (!live || request !== generation || abort.signal.aborted) return
		downloadBlob(URL.createObjectURL(blob), name)
	} catch (cause) {
		if (live && request === generation && !abort.signal.aborted && !isRequestContextAbort(cause)) {
			failure.value = projectVersionErrorText(cause)
		}
	} finally {
		if (live && request === generation) downloading.value = false
		if (controller === abort) controller = undefined
	}
}
</script>

<style scoped lang="scss">
.version-file {
	margin-block: var(--space-3);

	img {
		display: block;
		max-inline-size: 100%;
		max-block-size: 30rem;
		margin-block-end: var(--space-2);
		object-fit: contain;
	}
}
</style>
