<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import type {SpeechTelemetry} from '@/helpers/speechTelemetry'

const props = defineProps<{
	liveText: string,
	liveActive: boolean,
	cleanupPending: boolean,
	cleanupProposal: string,
	telemetry?: SpeechTelemetry,
}>()
const emit = defineEmits<{cancelCleanup: []}>()
const {t, locale} = useI18n({useScope: 'global'})
const copy = useCopyToClipboard()
const durations = computed(() => {
	const value = props.telemetry
	if (!value) return []
	const fields = ['stopToTextMS', 'prepareMS', 'requestMS', 'firstTextMS', 'finishMS', 'cleanupMS', 'audioMS'] as const
	return fields.flatMap(key => {
		const ms = value[key]
		return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
			? [{key, value: `${new Intl.NumberFormat(locale.value, {maximumFractionDigits: 2}).format(ms / 1000)} s`}]
			: []
	})
})
</script>

<template>
	<div class="speech-feedback">
		<section
			v-if="liveText && liveActive"
			class="speech-preview"
			data-voice-preview
			:aria-label="t('aronaVoice.livePreview')"
		>
			<strong>{{ t('aronaVoice.livePreview') }}</strong>
			<p>{{ liveText }}</p>
			<small>{{ t('aronaVoice.interimHint') }}</small>
			<button
				type="button"
				@click="copy(liveText)"
			>
				{{ t('aronaVoice.copyPreview') }}
			</button>
		</section>
		<div
			v-if="cleanupPending"
			class="speech-cleanup"
			data-voice-cleanup
			role="status"
		>
			<span>{{ t('aronaVoice.cleaningAfterReady') }}</span>
			<button
				type="button"
				data-voice-cleanup-cancel
				@click="emit('cancelCleanup')"
			>
				{{ t('aronaVoice.keepRaw') }}
			</button>
		</div>
		<details
			v-if="cleanupProposal"
			class="speech-proposal"
			data-voice-cleanup-result
			open
		>
			<summary>{{ t('aronaVoice.cleanupKept') }}</summary>
			<p>{{ cleanupProposal }}</p>
			<button
				type="button"
				@click="copy(cleanupProposal)"
			>
				{{ t('misc.copy') }}
			</button>
		</details>
		<details
			v-if="telemetry"
			class="speech-timings"
			data-voice-stats
		>
			<summary>{{ t('aronaVoice.details') }}</summary>
			<dl>
				<dt>{{ t('aronaVoice.mode') }}</dt><dd>{{ t(`aronaVoice.${telemetry.mode}`) }}</dd>
				<dt>{{ t('aronaVoice.model') }}</dt><dd>{{ telemetry.model }}</dd>
				<template
					v-for="duration in durations"
					:key="duration.key"
				>
					<dt>{{ t(`aronaVoice.metrics.${duration.key}`) }}</dt><dd>{{ duration.value }}</dd>
				</template>
				<template v-if="telemetry.endpoint">
					<dt>{{ t('aronaVoice.endpoint') }}</dt><dd>{{ telemetry.endpoint }}</dd>
				</template>
				<template v-if="telemetry.requestID">
					<dt>{{ t('aronaVoice.requestID') }}</dt><dd>{{ telemetry.requestID }}</dd>
				</template>
			</dl>
			<small>{{ t('aronaVoice.timingHint') }}</small>
		</details>
	</div>
</template>

<style scoped lang="scss">
.speech-feedback {
	display: grid;
	gap: .5rem;
	min-inline-size: 0;
	font-size: .8125rem;

	&:empty { display: none; }

	p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin-block: .4rem;
	}

	small {
		color: var(--grey-600);
		font-size: .75rem;
	}

	summary {
		cursor: pointer;
		color: var(--grey-700);
	}

	button {
		padding: .35rem .5rem;
		border: 1px solid var(--grey-200);
		border-radius: .4rem;
		background: var(--white);
		color: var(--primary);
		cursor: pointer;
		font: inherit;
		margin-inline-start: .4rem;
	}
}

.speech-preview, .speech-proposal {
	padding: .65rem .8rem;
	border: 1px solid var(--grey-200);
	border-radius: .7rem;
	background: var(--grey-50);
	max-block-size: min(13rem, 30dvh);
	overflow: auto;
	overscroll-behavior: contain;
}

.speech-cleanup {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: .35rem .75rem;
	color: var(--grey-600);

	button {
		background: transparent;
		border: 0;
		color: var(--primary);
		cursor: pointer;
		min-block-size: 2rem;
		padding-inline: .15rem;
	}
}

.speech-timings dl {
	display: grid;
	grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
	gap: .25rem .75rem;
	margin-block: .5rem;

	dt { color: var(--grey-600); }

	dd {
		margin: 0;
		overflow-wrap: anywhere;
		font-variant-numeric: tabular-nums;
	}
}
</style>
