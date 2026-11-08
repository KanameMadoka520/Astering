<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {liveNoteConnectionsQuery, type LiveNoteReceipt} from '@/client/queries/liveNotes'
import {useLiveNoteRecording} from '@/composables/useLiveNoteRecording'
import XButton from '@/components/input/Button.vue'

const props = defineProps<{noteId: number}>()
const emit = defineEmits<{
	segment: [receipt: LiveNoteReceipt],
	active: [recording: boolean],
}>()
const {t, locale} = useI18n({useScope: 'global'})
const connections = useQuery(liveNoteConnectionsQuery())
const connectionID = ref('')
const allowBackground = ref(false)
const keepAwake = ref(false)
const chosen = computed(() => connections.data.value?.find(item => item.id === connectionID.value))
watch(connections.data, list => {
	if (!list?.some(item => item.id === connectionID.value)) {
		connectionID.value = (list?.find(item => item.default) ?? list?.[0])?.id ?? ''
	}
}, {immediate: true})
const recorder = useLiveNoteRecording({
	noteID: () => props.noteId,
	connectionID: () => connectionID.value,
	sampleRate: () => chosen.value?.sample_rate ?? 16_000,
	language: () => locale.value,
	allowBackground: () => allowBackground.value,
	keepAwake: () => keepAwake.value,
	onSegment: receipt => {
		if (receipt.segment.note_id === props.noteId) emit('segment', receipt)
	},
})
const {
	state, active, error, detail, partial, elapsed, sentBytes, bytesPerSecond,
	bufferedSeconds, savedSegments, model, endpoint, screenAwake,
} = recorder
watch(active, value => emit('active', value), {immediate: true})
const clock = computed(() => {
	const value = Math.floor(elapsed.value)
	return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
		.map(part => String(part).padStart(2, '0')).join(':')
})
const copied = ref(false)
const copyFailed = ref(false)
async function copyPartial() {
	try {
		await navigator.clipboard.writeText(partial.value)
		copied.value = true
		copyFailed.value = false
	} catch {
		copyFailed.value = true
	}
}
watch(partial, () => { copied.value = false; copyFailed.value = false })
const errorKey = computed(() => {
	const keys = ['permission', 'unsupported', 'network', 'buffer_full', 'finalize_timeout', 'interrupted',
		'background', 'microphone', 'authentication', 'note_unavailable', 'already_recording', 'connection', 'provider',
		'save_failed', 'protocol', 'invalid_start']
	return keys.includes(error.value) ? error.value : 'interrupted'
})
async function toggle() {
	if (state.value === 'stopping') return
	if (active.value) await recorder.stop()
	else if (chosen.value) await recorder.start()
}
watch(() => props.noteId, () => { void recorder.stop() })
</script>

<template>
	<section
		class="live-voice"
		:class="{'is-recording': active}"
		:aria-label="t('liveNotes.title')"
	>
		<div class="live-voice__heading">
			<span class="live-voice__title"><Icon icon="microphone" />{{ t('liveNotes.title') }}</span>
			<span class="live-voice__privacy">{{ t('liveNotes.textOnly') }}</span>
		</div>
		<div
			v-if="connections.isPending.value"
			class="live-voice__hint"
			role="status"
		>
			{{ t('liveNotes.loading') }}
		</div>
		<div
			v-else-if="connections.isError.value"
			role="alert"
			class="live-voice__error"
		>
			{{ t('liveNotes.loadError') }}
			<XButton
				variant="tertiary"
				@click="connections.refetch()"
			>
				{{ t('misc.retry') }}
			</XButton>
		</div>
		<div
			v-else-if="!connections.data.value?.length"
			class="live-voice__hint"
		>
			{{ t('liveNotes.noConnection') }}
			<RouterLink to="/user/settings/ai">
				{{ t('liveNotes.configure') }}
			</RouterLink>
		</div>
		<div
			v-else
			class="live-voice__controls"
		>
			<label class="live-voice__connection">
				<span class="is-sr-only">{{ t('liveNotes.connection') }}</span>
				<select
					v-model="connectionID"
					:disabled="active"
					class="input"
				>
					<option
						v-for="item in connections.data.value"
						:key="item.id"
						:value="item.id"
					>{{ item.name }} · {{ item.model }}</option>
				</select>
			</label>
			<XButton
				:icon="active ? 'stop' : 'microphone'"
				:aria-disabled="state === 'stopping'"
				@click="toggle"
			>
				{{ t(active ? 'liveNotes.stop' : 'liveNotes.start') }}
			</XButton>
		</div>
		<div
			v-if="active || elapsed > 0"
			class="live-voice__status"
			role="status"
			aria-live="polite"
		>
			<span
				v-if="active"
				class="live-voice__dot"
				aria-hidden="true"
			/>
			<span>{{ t(`liveNotes.states.${state}`) }}</span>
			<time class="live-voice__clock">{{ clock }}</time>
			<span>{{ t('liveNotes.savedCount', {count: savedSegments}) }}</span>
		</div>
		<div
			v-if="partial"
			class="live-voice__partial"
		>
			<span class="live-voice__caption">{{ t('liveNotes.interim') }}</span>
			<p>{{ partial }}</p>
			<XButton
				v-if="!active"
				variant="tertiary"
				@click="copyPartial"
			>
				{{ t(copied ? 'liveNotes.copied' : 'liveNotes.copyInterim') }}
			</XButton>
			<p
				v-if="copyFailed"
				role="alert"
			>
				{{ t('liveNotes.copyFailed') }}
			</p>
		</div>
		<div
			v-if="error"
			role="alert"
			class="live-voice__error"
		>
			{{ t(`liveNotes.errors.${errorKey}`) }}
			<p
				v-if="detail"
				class="live-voice__detail"
			>
				{{ detail }}
			</p>
		</div>
		<p class="live-voice__hint">
			{{ t(allowBackground ? 'liveNotes.backgroundHint' : 'liveNotes.foregroundHint') }}
		</p>
		<details class="live-voice__diagnostics">
			<summary>{{ t('liveNotes.details') }}</summary>
			<label class="live-voice__option"><input
				v-model="allowBackground"
				type="checkbox"
				:disabled="active"
			> {{ t('liveNotes.allowBackground') }}</label>
			<label class="live-voice__option"><input
				v-model="keepAwake"
				type="checkbox"
				:disabled="active"
			> {{ t('liveNotes.keepAwake') }}</label>
			<p
				v-if="keepAwake && active"
				role="status"
			>
				{{ t(screenAwake ? 'liveNotes.awakeActive' : 'liveNotes.awakeUnavailable') }}
			</p>
			<dl>
				<dt>{{ t('liveNotes.model') }}</dt><dd>{{ model || chosen?.model || '—' }}</dd>
				<dt>{{ t('liveNotes.endpoint') }}</dt><dd>{{ endpoint || chosen?.endpoint || '—' }}</dd>
				<dt>{{ t('liveNotes.upload') }}</dt><dd>{{ (sentBytes / 1024).toFixed(1) }} KiB · {{ (bytesPerSecond / 1024).toFixed(1) }} KiB/s</dd>
				<dt>{{ t('liveNotes.buffer') }}</dt><dd>{{ bufferedSeconds.toFixed(1) }} s / 5 s</dd>
			</dl>
			<p>{{ t('liveNotes.rotationHint') }}</p>
		</details>
	</section>
</template>

<style scoped lang="scss">
.live-voice {
	padding: 1rem;
	border: 1px solid var(--grey-200);
	border-radius: .85rem;
	background: var(--white);
	transition: border-color .18s ease;

	&.is-recording {
		border-color: var(--primary);
	}
	&__heading, &__title, &__controls, &__status {
		display: flex;
		align-items: center;
		gap: .65rem;
	}
	&__heading {
		justify-content: space-between;
		flex-wrap: wrap;
		margin-block-end: .75rem;
	}
	&__title {
		font-weight: 600;
	}
	&__title :deep(svg) {
		inline-size: 1rem;
		flex-shrink: 0;
	}
	&__privacy, &__hint, &__caption {
		color: var(--grey-600);
		font-size: .78rem;
		line-height: 1.6;
	}
	&__hint {
		margin-block: .65rem 0;
	}
	&__connection {
		flex: 1;
		min-inline-size: 0;
	}
	&__connection select {
		inline-size: 100%;
		min-block-size: 2.75rem;
		text-overflow: ellipsis;
	}
	&__controls :deep(.button) {
		min-block-size: 2.75rem;
		flex-shrink: 0;
	}
	&__status {
		flex-wrap: wrap;
		font-size: .8rem;
		margin-block-start: .85rem;
	}
	&__clock {
		font-variant-numeric: tabular-nums;
	}
	&__dot {
		inline-size: .5rem;
		block-size: .5rem;
		border-radius: 50%;
		background: var(--primary);
	}
	&__partial {
		margin-block-start: .8rem;
		padding: .65rem .8rem;
		border-inline-start: 2px solid var(--primary);
		background: var(--grey-100);
	}
	&__partial p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin-block: .25rem;
	}
	&__error {
		margin-block-start: .7rem;
		color: var(--danger);
		font-size: .85rem;
		overflow-wrap: anywhere;
	}
	&__detail {
		white-space: pre-wrap;
		margin-block: .35rem;
	}
	&__diagnostics {
		margin-block-start: .75rem;
		font-size: .78rem;
		color: var(--grey-600);
	}
	&__diagnostics summary {
		cursor: pointer;
		padding-block: .35rem;
	}
	&__option {
		display: flex;
		align-items: center;
		gap: .5rem;
		min-block-size: 2.75rem;
		cursor: pointer;
	}
	&__diagnostics dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: .4rem .7rem;
	}
	&__diagnostics dd {
		margin: 0;
		overflow-wrap: anywhere;
		user-select: text;
	}
}
@media (width <= 480px) {
	.live-voice {
		padding: .8rem;
	}
	.live-voice__controls {
		flex-wrap: wrap;
	}
	.live-voice__connection {
		flex-basis: 100%;
	}
	.live-voice__controls :deep(.button) {
		inline-size: 100%;
	}
}
@media (prefers-reduced-motion: reduce) {
	.live-voice {
		transition: none;
	}
}
</style>
