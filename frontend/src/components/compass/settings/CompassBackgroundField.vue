<template>
	<div
		class="compass-background"
		role="group"
		:aria-labelledby="labelId"
		:aria-describedby="hintId"
	>
		<p
			:id="labelId"
			class="compass-background__label"
		>
			{{ t('compass.background.label') }}
		</p>
		<p
			:id="hintId"
			class="compass-background__hint"
		>
			{{ modelValue.background_file_id > 0 ? t('compass.background.hintPhoto') : t('compass.background.hintSky') }}
		</p>

		<template v-if="modelValue.background_file_id > 0">
			<CompassFocusPicker
				v-if="photo.url.value"
				:url="photo.url.value"
				:focus-x="modelValue.background_focus_x"
				:focus-y="modelValue.background_focus_y"
				@change="setFocus"
			/>
			<p
				v-else-if="photo.state.value === 'failed'"
				class="compass-background__missing"
				role="alert"
			>
				{{ t('compass.background.unavailable') }}
			</p>
			<p
				v-else
				class="compass-background__loading"
			>
				{{ t('compass.images.loading') }}
			</p>

			<SegmentedControl
				class="compass-background__scrim"
				:model-value="modelValue.background_scrim"
				:options="scrimOptions"
				:label="t('compass.background.scrim')"
				@update:modelValue="setScrim"
			/>
			<p class="compass-background__hint">
				{{ t('compass.background.scrimHint') }}
			</p>
		</template>

		<div class="compass-background__actions">
			<XButton
				variant="secondary"
				:shadow="false"
				icon="cloud-upload-alt"
				:loading="uploading"
				:aria-disabled="busy"
				@click="pickFile"
			>
				{{ modelValue.background_file_id > 0 ? t('compass.background.replaceUpload') : t('compass.images.upload') }}
			</XButton>
			<XButton
				variant="secondary"
				:shadow="false"
				icon="folder"
				:aria-disabled="busy"
				@click="openDrive"
			>
				{{ t('compass.images.fromDrive') }}
			</XButton>
			<XButton
				v-if="modelValue.background_file_id > 0"
				variant="tertiary"
				:shadow="false"
				icon="undo"
				:aria-disabled="busy"
				@click="clear"
			>
				{{ t('compass.background.clear') }}
			</XButton>
			<input
				ref="fileInput"
				type="file"
				class="is-hidden"
				:accept="COMPASS_IMAGE_ACCEPT"
				@change="onFile"
			>
		</div>

		<div
			v-if="record"
			class="compass-background__progress"
		>
			<UploadProgressRow :row="record" />
			<button
				v-if="uploading"
				type="button"
				class="compass-background__link"
				@click="cancelUpload"
			>
				{{ t('misc.cancel') }}
			</button>
		</div>
		<p
			v-if="problem"
			class="compass-background__problem"
			role="alert"
		>
			{{ problem }}
		</p>

		<DrivePicker
			v-if="driveOpen"
			images
			:busy="driveBusy"
			@close="closeDrive"
			@select="pickFromDrive"
		/>
	</div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useUploadDriveMutation, type DriveEntry} from '@/client/queries/drive'
import type {CompassSpaceBackground} from '@/client/queries/compass'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {useCompassImageUrl} from '@/components/compass/base/useCompassImageUrl'
import {COMPASS_IMAGE_ACCEPT} from '@/components/compass/editor/useCompassImageEditing'
import DrivePicker from '@/components/drive/DrivePicker.vue'
import XButton from '@/components/input/Button.vue'
import SegmentedControl from '@/components/input/SegmentedControl.vue'
import UploadProgressRow from '@/components/misc/UploadProgressRow.vue'
import {
	COMPASS_BACKGROUND_SCRIMS,
	type CompassBackgroundScrim,
} from '@/helpers/compass/constants'
import {isCompassImageType, isUploadableCompassImage} from '@/helpers/compass/images'
import {fetchCompassImageBlob} from '@/helpers/compass/imageUrls'
import {chooseImageBatch, uploads} from '@/helpers/uploadTransport'
import {getErrorText} from '@/message'
import CompassFocusPicker from './CompassFocusPicker.vue'

const props = defineProps<{
	spaceId: number
	modelValue: CompassSpaceBackground
}>()

const emit = defineEmits<{
	'update:modelValue': [value: CompassSpaceBackground]
}>()

const {t} = useI18n({useScope: 'global'})
const labelId = useId()
const hintId = useId()

const photo = useCompassImageUrl(() => props.spaceId, () => props.modelValue.background_file_id)
const upload = useUploadDriveMutation()

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const recordId = ref('')
const problem = ref('')
const driveOpen = ref(false)
const driveBusy = ref(false)
const busy = computed(() => uploading.value || driveBusy.value)

let controller: AbortController | undefined
// Ends with the form: an open format question goes away instead of uploading later.
const life = new AbortController()

const record = computed(() => recordId.value === ''
	? undefined
	: uploads.value.find(row => row.id === recordId.value))

const scrimOptions = computed(() => COMPASS_BACKGROUND_SCRIMS.map(value => ({
	value,
	label: t(`compass.background.scrims.${value}`),
})))

function change(patch: Partial<CompassSpaceBackground>) {
	emit('update:modelValue', {...props.modelValue, ...patch})
}

function setFocus(focus: {x: number, y: number}) {
	change({
		background_focus_x: focus.x,
		background_focus_y: focus.y,
	})
}

function setScrim(scrim: CompassBackgroundScrim) {
	change({background_scrim: scrim})
}

// The focus and veil stay as they were, so choosing a photo again starts from them.
function clear() {
	if (busy.value) return
	problem.value = ''
	change({background_file_id: 0})
}

function dropRecord() {
	const id = recordId.value
	recordId.value = ''
	if (id !== '') uploads.value = uploads.value.filter(row => row.id !== id)
}

function pickFile() {
	if (busy.value) return
	fileInput.value?.click()
}

async function onFile(event: Event) {
	const input = event.target as HTMLInputElement
	const file = input.files?.[0]
	input.value = ''
	if (!file || busy.value) return
	problem.value = ''
	if (!file.type.startsWith('image/')) {
		problem.value = t('compass.images.unsupported', {name: file.name})
		return
	}
	const context = captureClientRequestContext()
	const batch = await chooseImageBatch([file], life.signal)
	if (!batch) return
	if (life.signal.aborted || !isClientRequestContextCurrent(context)) {
		batch.release()
		return
	}
	if (!isUploadableCompassImage(file, batch.choice)) {
		batch.release()
		problem.value = t('compass.images.unsupported', {name: file.name})
		return
	}
	dropRecord()
	const own = new AbortController()
	controller = own
	recordId.value = crypto.randomUUID()
	uploading.value = true
	try {
		const saved = await upload.mutateAsync({
			file,
			signal: own.signal,
			headers: batch.headers(recordId.value),
			quiet: true,
		})
		if (!isClientRequestContextCurrent(context)) return
		const fileId = saved?.file_id ?? 0
		if (fileId <= 0) throw new Error(t('compass.images.uploadFailed'))
		if (!isCompassImageType(saved?.file?.mime)) {
			problem.value = t('compass.images.unsupportedUploaded', {name: file.name})
			return
		}
		change({background_file_id: fileId})
		dropRecord()
	} catch (cause) {
		if (!isClientRequestContextCurrent(context) || isRequestContextAbort(cause) || own.signal.aborted) return
		problem.value = getErrorText(cause) || t('compass.images.uploadFailed')
	} finally {
		batch.release()
		if (controller === own) controller = undefined
		uploading.value = false
	}
}

function cancelUpload() {
	controller?.abort()
}

function openDrive() {
	if (busy.value) return
	problem.value = ''
	driveOpen.value = true
}

function closeDrive() {
	if (!driveBusy.value) driveOpen.value = false
}

async function pickFromDrive(file: DriveEntry) {
	if (driveBusy.value) return
	problem.value = ''
	if (!isCompassImageType(file.file?.mime)) {
		problem.value = t('compass.images.unsupported', {name: file.file?.name ?? ''})
		return
	}
	const context = captureClientRequestContext()
	driveBusy.value = true
	try {
		// Read through the space, as the band will: a file in the recycle bin cannot be used.
		await fetchCompassImageBlob(props.spaceId, file.file_id)
	} catch (cause) {
		if (!isClientRequestContextCurrent(context) || isRequestContextAbort(cause)) return
		problem.value = t('compass.images.driveUnavailable', {name: file.file?.name ?? ''})
		return
	} finally {
		driveBusy.value = false
	}
	if (!isClientRequestContextCurrent(context)) return
	change({background_file_id: file.file_id})
	driveOpen.value = false
}

onBeforeUnmount(() => {
	life.abort()
	controller?.abort()
	dropRecord()
})
</script>

<style lang="scss" scoped>
.compass-background {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
}

.compass-background__label {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.compass-background__hint {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.compass-background__scrim {
	align-self: flex-start;
	margin-block-start: var(--space-2);
}

.compass-background__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-start: var(--space-1);

	@media (pointer: coarse) {
		:deep(.button) {
			min-block-size: var(--target-min);
		}
	}
}

.compass-background__loading,
.compass-background__missing {
	display: flex;
	align-items: center;
	justify-content: center;
	min-block-size: 6rem;
	margin: 0;
	padding: var(--space-4);
	border: 1px dashed var(--compass-rule-strong);
	border-radius: var(--radius-md);
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
	text-align: center;
}

.compass-background__missing {
	color: var(--danger-text);
}

.compass-background__progress {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	font-size: var(--text-sm);

	> :first-child {
		flex: 1 1 12rem;
		min-inline-size: 0;
	}
}

.compass-background__link {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--compass-accent);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-background__problem {
	margin: 0;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}
</style>
