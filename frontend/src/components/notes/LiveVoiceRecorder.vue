<script setup lang="ts">
import {computed, ref, useId, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {liveNoteConnectionsQuery, type LiveNoteReceipt} from '@/client/queries/liveNotes'
import {useNoteRecording} from '@/composables/useNoteRecording'
import {useLiveNotePreferences} from '@/composables/useLiveNotePreferences'
import {isNativeAndroid} from '@/helpers/nativeAndroid'
import {timezonesQuery} from '@/client/queries/account'
import {useOfflineNoteSync} from '@/composables/useOfflineNoteSync'
import XButton from '@/components/input/Button.vue'
import OfflineTranscriptViewer from './OfflineTranscriptViewer.vue'

const props = defineProps<{noteId: number}>()
const emit = defineEmits<{
	segment: [receipt: LiveNoteReceipt],
	active: [recording: boolean],
}>()
const {t, locale} = useI18n({useScope: 'global'})
const connections = useQuery(liveNoteConnectionsQuery())
const connectionID = ref('')
const preferences = useLiveNotePreferences()
const {
	allowBackground,
	keepAwake,
	timezone,
	autoAppend,
	ready: preferencesReady,
	loadFailed: preferencesLoadFailed,
	status: preferenceStatus,
} = preferences
const inputID = useId()
const zones = useQuery(timezonesQuery())
const availableZones = computed(() => [...new Set([timezone.value, ...(zones.data.value ?? [])])].sort())
const offline = useOfflineNoteSync()
const {
	available: localAvailable,
	builtIn: localBuiltIn,
	unsupported: localUnsupported,
	status: offlineStatus,
	busy: offlineBusy,
	failed: offlineFailed,
} = offline
const selectedEngine = ref<'online' | 'local'>('online')
const clearConfirm = ref(false)
const outboxOpen = ref(false)
const {page: offlinePage, pageBusy: offlinePageBusy, pageFailed: offlinePageFailed} = offline
const chosen = computed(() => connections.data.value?.find(item => item.id === connectionID.value))
watch(connections.data, list => {
	if (!list?.some(item => item.id === connectionID.value)) {
		connectionID.value = (list?.find(item => item.default) ?? list?.[0])?.id ?? ''
	}
}, {immediate: true})
const nativeRecording = isNativeAndroid()
const recorder = useNoteRecording({
	noteID: () => props.noteId,
	connectionID: () => connectionID.value,
	sampleRate: () => selectedEngine.value === 'local' ? 16_000 : chosen.value?.sample_rate ?? 16_000,
	language: () => selectedEngine.value === 'local' ? 'auto' : locale.value,
	allowBackground: () => allowBackground.value,
	keepAwake: () => keepAwake.value,
	engine: () => selectedEngine.value,
	timezone: () => timezone.value,
	appendToArticle: () => autoAppend.value,
	onSegment: receipt => {
		if (receipt.segment.note_id === props.noteId) emit('segment', receipt)
	},
})
const {
	state,
	actualEngine,
	active,
	error,
	detail,
	partial,
	elapsed,
	sentBytes,
	bytesPerSecond,
	bufferedSeconds,
	savedSegments,
	model,
	endpoint,
	screenAwake,
	retryAttempt,
	retryInSeconds,
	recoveryWarning,
	localText,
	inferenceMS,
} = recorder
const engine = computed(() => active.value ? actualEngine.value : selectedEngine.value)
const browserDiagnostics = computed(() => 'diagnostics' in recorder ? recorder.diagnostics.value : undefined)
const microphoneDB = computed(() => {
	const rms = browserDiagnostics.value?.rms ?? 0
	return rms > 0 ? 20 * Math.log10(rms) : null
})
const microphoneLevelText = computed(() => microphoneDB.value === null
	? t('liveNotes.diagnostics.silent')
	: t('liveNotes.diagnostics.decibels', {value: microphoneDB.value.toFixed(1)}))
function activityAge(seconds: number | null) {
	return seconds === null ? t('liveNotes.diagnostics.notYet')
		: t('liveNotes.diagnostics.secondsAgo', {seconds: Math.floor(seconds)})
}
const showEngineSelector = computed(() => nativeRecording &&
	(localBuiltIn.value || engine.value === 'local' || preferences.engine.value === 'local'))
const needsLocalVerification = computed(() => nativeRecording && engine.value === 'local' &&
	!active.value && !localAvailable.value && !localUnsupported.value)
watch([preferencesReady, preferences.engine, active], ([ready, saved, running]) => {
	if (ready && !running) selectedEngine.value = nativeRecording ? saved : 'online'
}, {immediate: true})
const pendingSync = computed(() => offlineStatus.value?.pending_count ?? 0)
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
		'save_failed', 'protocol', 'invalid_start', 'foreground_required', 'notification_permission', 'invalid_audio', 'capture_empty']
	keys.push('retry_exhausted', 'local_model', 'local_inference', 'local_backpressure', 'local_storage_full',
		'local_storage', 'sync_conflict', 'confirmation_required', 'rate_limited')
	return keys.includes(error.value) ? error.value : 'interrupted'
})
const syncErrorText = computed(() => {
	const code = offlineStatus.value?.sync_error
	return code && ['authentication', 'note_unavailable', 'network', 'rate_limited', 'sync_conflict', 'local_storage'].includes(code)
		? t(`liveNotes.errors.${code}`) : code ? t('liveNotes.offlineActionFailed') : ''
})
async function toggle() {
	if (state.value === 'stopping') return
	if (active.value) await recorder.stop()
	else if ((engine.value === 'local' ? localAvailable.value : chosen.value) && preferencesReady.value) await recorder.start()
}
const preferencesLocked = computed(() => active.value || !preferencesReady.value || preferenceStatus.value === 'saving')
const preferenceStatusKey = computed(() => ({
	idle: 'liveNotes.preferencesSaved',
	saving: 'liveNotes.preferencesSaving',
	saved: 'liveNotes.preferencesSaved',
	error: 'liveNotes.preferencesSaveFailed',
})[preferenceStatus.value])
function guardPreferenceClick(event: Event) {
	if (preferencesLocked.value) event.preventDefault()
}
function changePreference(event: Event, key: 'live_notes_allow_background' | 'live_notes_keep_awake' | 'live_notes_auto_append') {
	if (preferencesLocked.value || !(event.target instanceof HTMLInputElement)) return
	void preferences.setPreference(key, event.target.checked)
}
function changeTimezone(event: Event) {
	if (!(event.target instanceof HTMLSelectElement)) return
	if (preferencesLocked.value) {
		event.target.value = timezone.value
		return
	}
	void preferences.setPreference('live_notes_timezone', event.target.value)
}
function changeEngine(event: Event) {
	if (!(event.target instanceof HTMLSelectElement)) return
	if (preferencesLocked.value) {
		event.target.value = engine.value
		return
	}
	const next = event.target.value
	if (next !== 'online' && next !== 'local') return
	selectedEngine.value = next
	void preferences.setPreference('live_notes_engine', next)
}
async function clearOffline() {
	if (active.value || offlineBusy.value || !clearConfirm.value) return
	await offline.clear()
	if (!offlineFailed.value) clearConfirm.value = false
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
		<label
			v-if="showEngineSelector"
			class="live-voice__engine"
		>
			<span>{{ t('liveNotes.engine') }}</span>
			<select
				:value="engine"
				class="input"
				:aria-disabled="preferencesLocked"
				@change="changeEngine"
			>
				<option value="online">{{ t('liveNotes.onlineEngine') }}</option>
				<option value="local">{{ t('liveNotes.localEngine') }}</option>
			</select>
		</label>
		<p
			v-if="engine === 'local'"
			class="live-voice__hint"
		>
			{{ t('liveNotes.localHint') }}
		</p>
		<div
			v-if="needsLocalVerification"
			class="live-voice__hint"
			role="status"
		>
			<p>{{ t(localBuiltIn ? 'liveNotes.localVerifying' : 'liveNotes.localChecking') }}</p>
			<p>{{ t('liveNotes.localVerificationHelp') }}</p>
			<XButton
				variant="secondary"
				:aria-disabled="offlineBusy"
				@click="offline.sync()"
			>
				{{ t('liveNotes.verifyLocalRetry') }}
			</XButton>
			<p
				v-if="syncErrorText"
				role="alert"
			>
				{{ syncErrorText }}
			</p>
		</div>
		<p
			v-else-if="engine === 'local' && localUnsupported && !active"
			class="live-voice__hint"
			role="status"
		>
			{{ t('liveNotes.localUnavailable') }}
		</p>
		<p
			v-if="!nativeRecording && preferences.engine.value === 'local'"
			class="live-voice__hint"
		>
			{{ t('liveNotes.localAndroidOnly') }}
		</p>
		<div
			v-if="engine === 'online' && connections.isPending.value"
			class="live-voice__hint"
			role="status"
		>
			{{ t('liveNotes.loading') }}
		</div>
		<div
			v-else-if="engine === 'online' && connections.isError.value"
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
			v-else-if="engine === 'online' && !connections.data.value?.length"
			class="live-voice__hint"
		>
			{{ t('liveNotes.noConnection') }}
			<RouterLink to="/user/settings/ai">
				{{ t('liveNotes.configure') }}
			</RouterLink>
		</div>
		<p
			v-if="!preferencesReady"
			:role="preferencesLoadFailed ? 'alert' : 'status'"
			class="live-voice__hint"
		>
			{{ t(preferencesLoadFailed ? 'liveNotes.preferencesLoadFailed' : 'liveNotes.preferencesLoading') }}
			<XButton
				v-if="preferencesLoadFailed"
				variant="tertiary"
				@click="preferences.reload()"
			>
				{{ t('misc.retry') }}
			</XButton>
		</p>
		<div
			v-if="active || (engine === 'local' ? localAvailable : connections.data.value?.length)"
			class="live-voice__controls"
		>
			<label
				v-if="engine === 'online'"
				class="live-voice__connection"
			>
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
				:aria-disabled="state === 'stopping' || (!active && !preferencesReady)"
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
			<span>{{ t(actualEngine === 'local' ? 'liveNotes.localSavedCount' : 'liveNotes.savedCount', {count: savedSegments}) }}</span>
		</div>
		<div
			v-if="browserDiagnostics && active"
			class="live-voice__signal"
		>
			<div class="live-voice__signal-heading">
				<span :id="`${inputID}-level`">{{ t('liveNotes.diagnostics.inputLevel') }}</span>
				<span>{{ microphoneLevelText }}</span>
			</div>
			<p v-if="browserDiagnostics.microphoneName">
				{{ browserDiagnostics.microphoneName }}
			</p>
			<meter
				:min="-60"
				:max="0"
				:value="Math.max(-60, microphoneDB ?? -60)"
				:aria-labelledby="`${inputID}-level`"
				:aria-valuetext="microphoneLevelText"
			/>
			<p>
				{{ t('liveNotes.diagnostics.sending', {
					size: (sentBytes / 1024).toFixed(1),
					speed: active ? (bytesPerSecond / 1024).toFixed(1) : '0.0',
				}) }}
			</p>
			<p
				v-if="active && browserDiagnostics.warning"
				class="live-voice__signal-warning"
				role="status"
			>
				{{ t(`liveNotes.diagnostics.${browserDiagnostics.warning}`) }}
			</p>
		</div>
		<p
			v-if="state === 'reconnecting' && retryAttempt"
			class="live-voice__hint"
			role="status"
		>
			{{ t('liveNotes.retryStatus', {attempt: retryAttempt, seconds: retryInSeconds}) }}
		</p>
		<p
			v-if="recoveryWarning"
			class="live-voice__hint"
			role="status"
		>
			{{ t('liveNotes.recoveryWarning') }}
		</p>
		<div
			v-if="localText"
			class="live-voice__partial"
		>
			<span class="live-voice__caption">{{ t('liveNotes.localResult') }}</span>
			<p>{{ localText }}</p>
		</div>
		<div
			v-if="localAvailable && pendingSync > 0"
			class="live-voice__outbox"
			role="status"
		>
			<p>{{ t('liveNotes.pendingSync', {count: pendingSync, size: ((offlineStatus?.pending_bytes ?? 0) / 1024).toFixed(1)}) }}</p>
			<XButton
				variant="secondary"
				:aria-disabled="offlineBusy"
				@click="offline.sync()"
			>
				{{ t('liveNotes.syncNow') }}
			</XButton>
			<XButton
				variant="secondary"
				@click="outboxOpen = true; offline.loadPage()"
			>
				{{ t('liveNotes.viewPending') }}
			</XButton>
			<p
				v-if="syncErrorText"
				role="alert"
			>
				{{ syncErrorText }}
			</p>
			<XButton
				v-if="!clearConfirm"
				variant="tertiary"
				:aria-disabled="active || offlineBusy"
				@click="!active && !offlineBusy && (clearConfirm = true)"
			>
				{{ t('liveNotes.clearPending') }}
			</XButton>
			<div
				v-else
				class="live-voice__clear"
			>
				<p>{{ t('liveNotes.clearPendingWarning') }}</p>
				<XButton
					:aria-disabled="active || offlineBusy"
					@click="clearOffline"
				>
					{{ t('liveNotes.confirmClear') }}
				</XButton>
				<XButton
					variant="tertiary"
					@click="clearConfirm = false"
				>
					{{ t('misc.cancel') }}
				</XButton>
			</div>
		</div>
		<p
			v-if="offlineFailed && nativeRecording"
			class="live-voice__error"
			role="alert"
		>
			{{ t('liveNotes.offlineActionFailed') }}
		</p>
		<OfflineTranscriptViewer
			v-if="outboxOpen"
			:page="offlinePage"
			:busy="offlinePageBusy"
			:failed="offlinePageFailed"
			:timezone="timezone"
			@close="outboxOpen = false"
			@load="offline.loadPage($event)"
		/>
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
			<p
				v-if="browserDiagnostics?.requestID"
				class="live-voice__detail"
			>
				{{ t('liveNotes.diagnostics.trace', {id: browserDiagnostics.requestID}) }}
			</p>
		</div>
		<p class="live-voice__hint">
			{{ t(allowBackground ? nativeRecording ? 'liveNotes.nativeBackgroundHint' : 'liveNotes.backgroundHint' : 'liveNotes.foregroundHint') }}
		</p>
		<details class="live-voice__diagnostics">
			<summary>{{ t('liveNotes.details') }}</summary>
			<label class="live-voice__option"><input
				:checked="autoAppend"
				type="checkbox"
				:aria-disabled="preferencesLocked"
				@click="guardPreferenceClick"
				@change="changePreference($event, 'live_notes_auto_append')"
			> {{ t('liveNotes.autoAppend') }}</label>
			<p class="live-voice__hint">
				{{ t('liveNotes.autoAppendHint') }}
			</p>
			<label :for="`${inputID}-timezone`">{{ t('liveNotes.timezone') }}</label>
			<select
				:id="`${inputID}-timezone`"
				:value="timezone"
				class="input"
				:aria-disabled="preferencesLocked"
				@change="changeTimezone"
			>
				<option
					v-for="zone in availableZones"
					:key="zone"
					:value="zone"
				>
					{{ zone }}
				</option>
			</select>
			<p class="live-voice__hint">
				{{ t('liveNotes.timezoneHint') }}
			</p>
			<label class="live-voice__option"><input
				:checked="allowBackground"
				type="checkbox"
				:aria-disabled="preferencesLocked"
				@click="guardPreferenceClick"
				@change="changePreference($event, 'live_notes_allow_background')"
			> {{ t(nativeRecording ? 'liveNotes.nativeAllowBackground' : 'liveNotes.allowBackground') }}</label>
			<label class="live-voice__option"><input
				:checked="keepAwake"
				type="checkbox"
				:aria-disabled="preferencesLocked"
				@click="guardPreferenceClick"
				@change="changePreference($event, 'live_notes_keep_awake')"
			> {{ t('liveNotes.keepAwake') }}</label>
			<p class="live-voice__hint">
				{{ t('liveNotes.preferencesHint') }}
			</p>
			<p
				v-if="preferenceStatus !== 'idle'"
				:role="preferenceStatus === 'error' ? 'alert' : 'status'"
				class="live-voice__hint"
			>
				{{ t(preferenceStatusKey) }}
				<XButton
					v-if="preferenceStatus === 'error'"
					variant="tertiary"
					@click="preferences.retry()"
				>
					{{ t('misc.retry') }}
				</XButton>
			</p>
			<p
				v-if="keepAwake && active"
				role="status"
			>
				{{ t(screenAwake ? 'liveNotes.awakeActive' : 'liveNotes.awakeUnavailable') }}
			</p>
			<dl>
				<dt>{{ t('liveNotes.model') }}</dt><dd>{{ model || (engine === 'local' ? offlineStatus?.model : chosen?.model) || '—' }}</dd>
				<dt>{{ t('liveNotes.endpoint') }}</dt><dd>{{ endpoint || (engine === 'local' ? t('liveNotes.onDevice') : chosen?.endpoint) || '—' }}</dd>
				<dt>{{ t('liveNotes.upload') }}</dt><dd>{{ (sentBytes / 1024).toFixed(1) }} KiB · {{ (bytesPerSecond / 1024).toFixed(1) }} KiB/s</dd>
				<dt>{{ t('liveNotes.buffer') }}</dt><dd>{{ bufferedSeconds.toFixed(1) }} s</dd>
				<template v-if="browserDiagnostics">
					<dt>{{ t('liveNotes.diagnostics.capture') }}</dt>
					<dd>
						{{ t('liveNotes.diagnostics.captureCount', {
							frames: browserDiagnostics.captureFrames,
							size: (browserDiagnostics.capturedBytes / 1024).toFixed(1),
						}) }}
					</dd>
					<template v-if="active">
						<dt>{{ t('liveNotes.diagnostics.lastCapture') }}</dt>
						<dd>{{ activityAge(browserDiagnostics.captureAgeSeconds) }}</dd>
						<dt>{{ t('liveNotes.diagnostics.lastUpload') }}</dt>
						<dd>{{ activityAge(browserDiagnostics.uploadAgeSeconds) }}</dd>
						<dt>{{ t('liveNotes.diagnostics.lastTranscript') }}</dt>
						<dd>{{ activityAge(browserDiagnostics.transcriptAgeSeconds) }}</dd>
					</template>
					<template v-if="browserDiagnostics.requestID">
						<dt>{{ t('liveNotes.diagnostics.requestID') }}</dt>
						<dd>{{ browserDiagnostics.requestID }}</dd>
					</template>
					<template v-if="browserDiagnostics.providerCode">
						<dt>{{ t('liveNotes.diagnostics.providerCode') }}</dt>
						<dd>{{ browserDiagnostics.providerCode }}</dd>
					</template>
					<template v-if="browserDiagnostics.providerRequestID">
						<dt>{{ t('liveNotes.diagnostics.providerRequestID') }}</dt>
						<dd>{{ browserDiagnostics.providerRequestID }}</dd>
					</template>
					<template v-if="browserDiagnostics.providerTaskID">
						<dt>{{ t('liveNotes.diagnostics.providerTaskID') }}</dt>
						<dd>{{ browserDiagnostics.providerTaskID }}</dd>
					</template>
					<template v-if="browserDiagnostics.server">
						<dt>{{ t('liveNotes.diagnostics.serverAudio') }}</dt>
						<dd>
							{{ t('liveNotes.diagnostics.serverAudioValue', {
								size: (browserDiagnostics.server.received_bytes / 1024).toFixed(1),
								seconds: (browserDiagnostics.server.audio_duration_ms / 1000).toFixed(1),
							}) }}
						</dd>
						<dt>{{ t('liveNotes.diagnostics.serverText') }}</dt>
						<dd>
							{{ t('liveNotes.diagnostics.serverTextValue', {
								partial: browserDiagnostics.server.partial_updates,
								saved: browserDiagnostics.server.saved_segments,
							}) }}
						</dd>
						<dt>{{ t('liveNotes.diagnostics.serverElapsed') }}</dt>
						<dd>{{ (browserDiagnostics.server.elapsed_ms / 1000).toFixed(1) }} s</dd>
						<dt>{{ t('liveNotes.diagnostics.serverFirstText') }}</dt>
						<dd>
							{{ browserDiagnostics.server.partial_updates || browserDiagnostics.server.saved_segments
								? `${(browserDiagnostics.server.first_text_ms / 1000).toFixed(1)} s`
								: t('liveNotes.diagnostics.notYet') }}
						</dd>
					</template>
				</template>
				<template v-if="localBuiltIn">
					<dt>{{ t('liveNotes.localModel') }}</dt><dd>{{ offlineStatus?.model }} · {{ ((offlineStatus?.bytes ?? 0) / 1024 / 1024).toFixed(1) }} MiB</dd>
					<dt v-if="engine === 'local'">
						{{ t('liveNotes.inferenceTime') }}
					</dt><dd v-if="engine === 'local'">
						{{ inferenceMS }} ms
					</dd>
				</template>
			</dl>
			<p v-if="browserDiagnostics">
				{{ t('liveNotes.diagnostics.help') }}
			</p>
			<p v-if="browserDiagnostics?.server">
				{{ t('liveNotes.diagnostics.snapshotHelp') }}
			</p>
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
	&__engine {
		display: grid;
		gap: .4rem;
		margin-block-end: .75rem;
		font-size: .85rem;
	}
	&__outbox {
		margin-block-start: .75rem;
		padding: .75rem;
		border-radius: .65rem;
		background: var(--grey-100);
		font-size: .8rem;
	}
	&__outbox :deep(.button) {
		min-block-size: 2.75rem;
		margin-inline-end: .5rem;
		margin-block-start: .5rem;
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
	&__signal {
		margin-block-start: .75rem;
		padding: .65rem .75rem;
		border-radius: .65rem;
		background: var(--grey-100);
		font-size: .78rem;
		font-variant-numeric: tabular-nums;
		line-height: 1.6;
	}
	&__signal-heading {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: .25rem .75rem;
	}
	&__signal meter {
		display: block;
		inline-size: 100%;
		block-size: 1rem;
		accent-color: var(--primary);
	}
	&__signal p {
		margin-block: .2rem 0;
		overflow-wrap: anywhere;
	}
	&__signal-warning {
		color: var(--grey-700);
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
