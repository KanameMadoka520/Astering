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
import {computed, onBeforeUnmount, ref} from 'vue'
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
import {
	compassMarkdownFilename,
	compassSpaceToMarkdown,
	downloadCompassMarkdown,
} from '@/helpers/compass/exportMarkdown'
import {formatDateLong} from '@/helpers/time/formatDate'

const props = defineProps<{
	space: CompassSpace
}>()

const {t} = useI18n({useScope: 'global'})

type ExportPhase = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

const isOpen = ref(false)
const phase = ref<ExportPhase>('idle')
// total is -1 until the list of entries has been read.
const progress = ref({
	done: 0,
	total: -1,
})
const saved = ref({
	file: '',
	count: 0,
})
const errorText = ref('')

let controller: AbortController | null = null
// Each start, cancel and close bumps the run, so a late answer from an earlier run changes nothing.
let run = 0

const statusText = computed(() => {
	switch (phase.value) {
		case 'running':
			return progress.value.total < 0
				? t('compass.export.preparing')
				: t('compass.export.progress', {
					done: progress.value.done,
					total: progress.value.total,
				})
		case 'done':
			return t('compass.export.done', {
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
		done: 0,
		total: -1,
	}
	errorText.value = ''

	let entries: CompassEntry[]
	try {
		entries = await fetchCompassEntriesForExport(space.id, (done, total) => {
			if (current !== run) return
			progress.value = {
				done,
				total,
			}
		}, abort.signal)
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

	const markdown = compassSpaceToMarkdown(space, entries, {
		kind: entry => t(`compass.kind.${entry.kind}`),
		exportedFrom: t('compass.export.exportedFrom', {date: formatDateLong(new Date())}),
		contents: t('compass.export.contents'),
	})
	const file = compassMarkdownFilename(space.title, t('compass.home.defaultTitle'))
	downloadCompassMarkdown(markdown, file)
	saved.value = {
		file,
		count: entries.length,
	}
	phase.value = 'done'
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
