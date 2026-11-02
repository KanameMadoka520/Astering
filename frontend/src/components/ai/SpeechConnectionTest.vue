<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {SpeechConnectionTestResult} from '@/helpers/speechProviders'

const props = defineProps<{
	canTest: boolean
	canProbe?: boolean
	testing: boolean
	maxBytes: number
	result?: SpeechConnectionTestResult
}>()
const emit = defineEmits<{
	test: [file?: File]
	reset: []
}>()
const {t, locale} = useI18n({useScope: 'global'})
const file = ref<File>()
const previewURL = ref('')
const error = ref('')
const limitMiB = computed(() => props.maxBytes / 1024 / 1024)
const seconds = (ms: number) => new Intl.NumberFormat(locale.value, {maximumFractionDigits: 2}).format(ms / 1000)

function releasePreview() {
	if (previewURL.value) URL.revokeObjectURL(previewURL.value)
	previewURL.value = ''
}
watch(() => props.maxBytes, () => {
	error.value = file.value && file.value.size > props.maxBytes ? t('speechSettings.audioLimit', {size: limitMiB.value})
		: file.value && !file.value.size ? t('speechSettings.emptyAudio') : ''
})
onBeforeUnmount(releasePreview)

function selectFile(event: Event) {
	const input = event.target as HTMLInputElement
	const selected = input.files?.[0]
	if (!selected) return
	emit('reset')
	releasePreview()
	file.value = selected
	error.value = !selected.size ? t('speechSettings.emptyAudio')
		: selected.size > props.maxBytes ? t('speechSettings.audioLimit', {size: limitMiB.value}) : ''
	if (!error.value) previewURL.value = URL.createObjectURL(selected)
	input.value = ''
}
function run() {
	if (!props.canTest || props.testing || !file.value || error.value) return
	emit('test', file.value)
}
function probe() {
	if (!props.canTest || !props.canProbe || props.testing) return
	emit('test')
}
</script>

<template>
	<section
		class="speech-test"
		:aria-label="t('speechSettings.speedTest')"
	>
		<div class="speech-test__heading">
			<h3>{{ t('speechSettings.speedTest') }}</h3>
			<Icon
				icon="play"
				aria-hidden="true"
			/>
		</div>
		<p class="speech-test__hint">
			{{ t('speechSettings.testHint') }}
		</p>
		<template v-if="canProbe">
			<XButton
				type="button"
				variant="secondary"
				:loading="testing"
				:aria-disabled="!canTest || testing"
				@click="probe"
			>
				{{ t('speechSettings.probeConnection') }}
			</XButton>
			<p class="speech-test__hint">
				{{ t('speechSettings.probeHint') }}
			</p>
		</template>
		<label class="speech-test__file">
			<span>{{ t('tcymc.text.audio_file_for_connection_testing') }}</span>
			<input
				type="file"
				accept="audio/*"
				:aria-disabled="testing"
				@change="!testing && selectFile($event)"
			>
			<small>{{ t('speechSettings.audioLimit', {size: limitMiB}) }}</small>
		</label>
		<audio
			v-if="previewURL"
			:src="previewURL"
			controls
			preload="metadata"
			:aria-label="t('speechSettings.previewAudio')"
		/>
		<p
			v-if="error"
			role="alert"
		>
			{{ error }}
		</p>
		<XButton
			type="button"
			icon="play"
			:loading="testing"
			:aria-disabled="!canTest || !file || Boolean(error) || testing"
			@click="run"
		>
			{{ t('speechSettings.runTest') }}
		</XButton>
		<p
			v-if="!canTest"
			class="speech-test__hint"
		>
			{{ t('tcymc.text.save_connection_changes_before_testing_you_can_fetch') }}
		</p>
		<div
			v-if="result"
			class="speech-test__result"
			:class="{'is-error': !result.ok}"
			role="status"
		>
			<div class="speech-test__metrics">
				<strong>{{ t(result.ok
					? result.connectionOnly ? 'speechSettings.probePassed' : 'modelSettings.statusTested'
					: 'modelSettings.statusTestFailed') }}</strong>
				<span v-if="result.elapsedMs !== undefined">
					{{ t('speechSettings.elapsed', {seconds: seconds(result.elapsedMs)}) }}
				</span>
				<span v-if="result.firstTextMs && result.firstTextMs > 0">
					{{ t('speechSettings.firstText', {seconds: seconds(result.firstTextMs)}) }}
				</span>
				<span v-if="result.audioDurationMs && result.audioDurationMs > 0">
					{{ t('speechSettings.duration', {seconds: seconds(result.audioDurationMs)}) }}
				</span>
			</div>
			<p
				v-if="result.text"
				class="speech-test__transcript"
			>
				{{ result.text }}
			</p>
			<code v-if="result.endpoint">{{ result.endpoint }}</code>
		</div>
	</section>
</template>

<style lang="scss" scoped>
.speech-test {
	display: grid;
	justify-items: start;
	gap: var(--space-3);
	min-inline-size: 0;
	padding-block-start: var(--space-5);
	border-block-start: 1px solid var(--border-subtle);

	audio {
		inline-size: min(100%, 28rem);
	}
}

.speech-test__heading,
.speech-test__metrics {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-4);
	inline-size: 100%;

	h3 {
		flex: 1;
		margin: 0;
		font-size: var(--text-md);
	}
}

.speech-test__hint,
.speech-test__file small,
.speech-test__metrics span {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.speech-test__file {
	display: grid;
	gap: var(--space-2);
	inline-size: 100%;

	input {
		max-inline-size: 100%;
		min-block-size: var(--target-min);
	}
}

.speech-test__result {
	display: grid;
	gap: var(--space-3);
	inline-size: 100%;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--success);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);

	&.is-error {
		border-inline-start-color: var(--danger);
	}

	code {
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
}

.speech-test__transcript {
	max-block-size: 16rem;
	margin: 0;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
</style>
