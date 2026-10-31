<template>
	<XButton
		variant="secondary"
		icon="download"
		:shadow="false"
		@click="isOpen = true"
	>
		{{ t('compass.export.button') }}
	</XButton>

	<Modal
		:enabled="isOpen"
		:aria-label="t('compass.export.title')"
		@close="close"
	>
		<Card
			:title="t('compass.export.title')"
			:shadow="false"
			:padding="false"
			:show-close="true"
			class="compass-export has-text-start"
			@close="close"
		>
			<div class="compass-export__body">
				<p>{{ t('compass.export.explain') }}</p>
				<p class="compass-export__aside">
					{{ t('compass.export.local') }}
				</p>

				<label class="compass-export__option">
					<input
						v-model="includeImages"
						type="checkbox"
						:disabled="phase === 'running'"
						:aria-describedby="imagesHintId"
					>
					<span>{{ t('compass.export.includeImages') }}</span>
				</label>
				<p
					:id="imagesHintId"
					class="compass-export__aside"
				>
					{{ includeImages ? t('compass.export.includeImagesHint') : t('compass.export.referencesHint') }}
				</p>

				<div class="compass-export__progress">
					<p
						class="compass-export__status"
						role="status"
						aria-live="polite"
					>
						{{ statusText }}
					</p>
					<progress
						v-if="phase === 'running'"
						class="compass-export__bar"
						:value="progress.total > 0 ? progress.done : undefined"
						:max="Math.max(progress.total, 1)"
						aria-hidden="true"
					/>
				</div>

				<p
					v-if="phase === 'done' && saved.missing > 0"
					class="compass-export__error"
					role="alert"
				>
					{{ t('compass.export.imagesMissing', {n: saved.missing}, saved.missing) }}
				</p>
				<p
					v-if="errorText"
					class="compass-export__error"
					role="alert"
				>
					{{ errorText }}
				</p>
			</div>
			<template #footer>
				<XButton
					variant="secondary"
					:shadow="false"
					@click="phase === 'running' ? cancel() : close()"
				>
					{{ phase === 'running' ? t('misc.cancel') : t('misc.close') }}
				</XButton>
				<XButton
					variant="primary"
					icon="download"
					:shadow="false"
					:loading="phase === 'running'"
					@click="start"
				>
					{{ phase === 'idle' ? t('compass.export.start') : t('compass.export.again') }}
				</XButton>
			</template>
		</Card>
	</Modal>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import {
	fetchCompassEntriesForExport,
	type CompassEntry,
	type CompassSpace,
} from '@/client/queries/compass'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {buildCompassBundle, compassBodiesImageIds} from '@/helpers/compass/exportBundle'
import {
	compassExportBaseName,
	compassSpaceToMarkdown,
	downloadCompassFile,
	downloadCompassMarkdown,
	type CompassExportLabels,
} from '@/helpers/compass/exportMarkdown'
import type {CompassImageRef} from '@/helpers/compass/images'
import {formatDateLong} from '@/helpers/time/formatDate'
import {ZipTooLargeError} from '@/helpers/zipStore'

const props = defineProps<{
	space: CompassSpace
}>()

const {t} = useI18n({useScope: 'global'})

type ExportPhase = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

const isOpen = ref(false)
const phase = ref<ExportPhase>('idle')
// Pictures go into a ZIP next to the Markdown; without them the text keeps their references.
const includeImages = ref(true)
const imagesHintId = useId()
// total is -1 until the list of entries has been read.
const progress = ref({
	step: 'entries' as 'entries' | 'images',
	done: 0,
	total: -1,
})
const saved = ref({
	file: '',
	count: 0,
	images: 0,
	missing: 0,
})
const errorText = ref('')

let controller: AbortController | null = null
// Each start, cancel and close bumps the run, so a late answer from an earlier run changes nothing.
let run = 0

const statusText = computed(() => {
	switch (phase.value) {
		case 'running':
			if (progress.value.total < 0) return t('compass.export.preparing')
			return progress.value.step === 'images'
				? t('compass.export.imagesProgress', {
					done: progress.value.done,
					total: progress.value.total,
				})
				: t('compass.export.progress', {
					done: progress.value.done,
					total: progress.value.total,
				})
		case 'done':
			return saved.value.images > 0
				? t('compass.export.doneImages', {
					file: saved.value.file,
					n: saved.value.count,
					images: saved.value.images,
				}, saved.value.count)
				: t('compass.export.done', {
					file: saved.value.file,
					n: saved.value.count,
				}, saved.value.count)
		case 'cancelled':
			return t('compass.export.cancelled')
		default:
			return ''
	}
})

function failureText(cause: unknown): string {
	if (cause instanceof ZipTooLargeError) return t('compass.export.tooLarge')
	switch (classifyCompassFailure(cause)) {
		case 'network':
			return t('compass.export.offline')
		case 'missing':
		case 'forbidden':
			return t('compass.export.lost')
		default:
			return t('compass.export.failed')
	}
}

async function start() {
	if (phase.value === 'running') return
	const current = ++run
	controller?.abort()
	const abort = new AbortController()
	controller = abort
	const space = props.space
	phase.value = 'running'
	progress.value = {
		step: 'entries',
		done: 0,
		total: -1,
	}
	errorText.value = ''
	const withImages = includeImages.value

	const labels: CompassExportLabels = {
		kind: entry => t(`compass.kind.${entry.kind}`),
		exportedFrom: t('compass.export.exportedFrom', {date: formatDateLong(new Date())}),
		contents: t('compass.export.contents'),
	}
	const baseName = compassExportBaseName(space.title, t('compass.home.defaultTitle'))

	let entries: CompassEntry[]
	try {
		entries = await fetchCompassEntriesForExport(space.id, (done, total) => {
			if (current !== run) return
			progress.value = {
				step: 'entries',
				done,
				total,
			}
		}, abort.signal)
		if (current !== run) return
		const imageIds = compassBodiesImageIds(entries.map(entry => entry.content))
		if (imageIds.length > 0 && withImages) {
			const bundle = await buildCompassBundle({
				spaceId: space.id,
				baseName,
				imageIds,
				markdown: images => compassSpaceToMarkdown(space, entries, labels, images),
				missing: missingImageText,
				signal: abort.signal,
				onProgress: (done, total) => {
					if (current !== run) return
					progress.value = {
						step: 'images',
						done,
						total,
					}
				},
			})
			if (current !== run) return
			downloadCompassFile(bundle.blob, bundle.filename)
			saved.value = {
				file: bundle.filename,
				count: entries.length,
				images: bundle.images,
				missing: bundle.missing,
			}
		} else {
			if (imageIds.length > 0) labels.imagesNote = t('compass.export.referencesNote')
			const file = `${baseName}.md`
			downloadCompassMarkdown(compassSpaceToMarkdown(space, entries, labels), file)
			saved.value = {
				file,
				count: entries.length,
				images: 0,
				missing: 0,
			}
		}
	} catch (cause) {
		if (current !== run || abort.signal.aborted) return
		if (classifyCompassFailure(cause) === 'aborted') {
			phase.value = 'idle'
			return
		}
		phase.value = 'failed'
		errorText.value = failureText(cause)
		return
	} finally {
		if (controller === abort) controller = null
	}
	if (current !== run) return
	phase.value = 'done'
}

function missingImageText(image: CompassImageRef): string {
	return image.alt
		? t('compass.export.imageMissingNamed', {alt: image.alt})
		: t('compass.export.imageMissing')
}

function cancel() {
	if (phase.value !== 'running') return
	run++
	controller?.abort()
	controller = null
	phase.value = 'cancelled'
}

function close() {
	run++
	controller?.abort()
	controller = null
	isOpen.value = false
	phase.value = 'idle'
	progress.value = {
		step: 'entries',
		done: 0,
		total: -1,
	}
	errorText.value = ''
}

onBeforeUnmount(() => {
	run++
	controller?.abort()
})
</script>

<style lang="scss" scoped>
.compass-export__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-inline-size: 34rem;
	padding: var(--space-4) var(--space-5);
	line-height: var(--leading-normal);
}

.compass-export__aside {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.compass-export__option {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	font-weight: var(--weight-medium);
	cursor: pointer;

	input {
		flex: none;
		inline-size: 1.125rem;
		block-size: 1.125rem;
		margin: 0;
		accent-color: var(--primary);
	}
}

.compass-export__progress {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

// One line is always reserved, so the dialog does not jump when the export starts.
.compass-export__status {
	min-block-size: 1.5em;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.compass-export__bar {
	inline-size: 100%;
	block-size: .375rem;
	overflow: hidden;
	border: 0;
	border-radius: var(--radius-full);
	background: var(--surface-active);
	accent-color: var(--primary);
	appearance: none;

	&::-webkit-progress-bar {
		background: var(--surface-active);
	}

	&::-webkit-progress-value {
		border-radius: var(--radius-full);
		background: var(--primary);
	}

	&::-moz-progress-bar {
		border-radius: var(--radius-full);
		background: var(--primary);
	}
}

.compass-export__error {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-md);
}
</style>
