<template>
	<CompassThemeScope
		:theme="theme"
		class="compass-settings-form"
	>
		<div class="compass-settings-form__layout">
			<form
				class="compass-settings-form__form"
				novalidate
				@submit.prevent="save"
				@keydown="onKeydown"
			>
				<FormField
					ref="titleField"
					v-model="title"
					:label="t('compass.settings.field.name')"
					:error="titleError"
					:maxlength="COMPASS_LIMITS.spaceTitle"
					type="text"
					autocomplete="off"
					required
				/>

				<FormField
					:label="t('compass.settings.field.motto')"
					:error="mottoError"
				>
					<template #default="{id, errorId}">
						<textarea
							:id="id"
							ref="mottoInput"
							v-model="motto"
							class="textarea compass-settings-form__motto"
							rows="3"
							:maxlength="COMPASS_LIMITS.motto"
							:placeholder="t('compass.settings.field.mottoPlaceholder')"
							:aria-invalid="mottoError ? true : undefined"
							:aria-describedby="[mottoHintId, errorId].filter(Boolean).join(' ')"
						/>
						<p
							:id="mottoHintId"
							class="compass-settings-form__hint"
						>
							<span>{{ t('compass.settings.field.mottoHint') }}</span>
							<span class="compass-settings-form__count">
								{{ mottoCount }}
							</span>
						</p>
					</template>
				</FormField>

				<div class="compass-settings-form__group">
					<CompassThemePicker
						v-model="theme"
						:label="t('compass.settings.field.theme')"
						name="compass-settings-theme"
						:aria-describedby="themeHintId"
					/>
					<p
						:id="themeHintId"
						class="compass-settings-form__hint"
					>
						{{ t('compass.settings.field.themeHint') }}
					</p>
				</div>

				<div
					class="compass-settings-form__group"
					role="group"
					:aria-labelledby="prefaceLabelId"
					:aria-describedby="prefaceHintId"
				>
					<p
						:id="prefaceLabelId"
						class="compass-settings-form__label"
					>
						{{ t('compass.settings.field.preface') }}
					</p>
					<Editor
						v-model="introduction"
						class="compass-settings-form__editor"
						:class="{'is-invalid': introductionTooLarge}"
						:allow-images="false"
						:allow-task-lists="false"
						always-editing
						:placeholder="t('compass.settings.field.prefacePlaceholder')"
						@save="save()"
					/>
					<p
						:id="prefaceHintId"
						class="compass-settings-form__hint"
					>
						<span>{{ t('compass.settings.field.prefaceHint') }}</span>
						<span
							class="compass-settings-form__count"
							:class="{'is-over': introductionTooLarge}"
						>
							{{ introductionSize }}
						</span>
					</p>
					<p
						v-if="introductionTooLarge"
						class="help is-danger"
						role="alert"
					>
						{{ t('compass.settings.field.prefaceTooLarge', sizeParams) }}
					</p>
				</div>

				<div
					class="compass-settings-form__group"
					role="group"
					:aria-labelledby="sharingLabelId"
				>
					<p
						:id="sharingLabelId"
						class="compass-settings-form__label"
					>
						{{ t('compass.sharing.summaryLabel') }}
					</p>
					<CompassSharingSummary :team-id="space.team_id" />
				</div>

				<section
					v-if="conflict"
					class="compass-settings-form__conflict"
					:aria-labelledby="conflictTitleId"
				>
					<!-- Only the headline is announced; the latest values are read on demand. -->
					<p
						:id="conflictTitleId"
						class="compass-settings-form__conflict-title"
						role="alert"
					>
						<Icon
							class="compass-settings-form__conflict-icon"
							icon="exclamation-circle"
						/>
						<span>{{ t('compass.settings.conflict.title') }}</span>
					</p>
					<p class="compass-settings-form__conflict-text">
						{{ t('compass.settings.conflict.text') }}
					</p>
					<p class="compass-settings-form__latest-label">
						{{ t('compass.settings.conflict.latestLabel') }}
					</p>
					<dl class="compass-settings-form__latest">
						<div
							v-for="row in conflictRows"
							:key="row.key"
							class="compass-settings-form__latest-row"
						>
							<dt class="compass-settings-form__latest-term">
								<span>{{ row.label }}</span>
								<span
									v-if="row.differs"
									class="compass-settings-form__differs"
								>{{ t('compass.settings.conflict.differs') }}</span>
							</dt>
							<dd
								class="compass-settings-form__latest-value"
								:class="{
									'is-empty': row.value === '',
									'is-serif': row.serif,
								}"
							>
								{{ row.value || t('compass.settings.conflict.empty') }}
							</dd>
						</div>
					</dl>
					<div class="compass-settings-form__conflict-actions">
						<XButton
							variant="secondary"
							:shadow="false"
							@click="keepMine"
						>
							{{ t('compass.settings.conflict.keep') }}
						</XButton>
						<XButton
							variant="secondary"
							:shadow="false"
							@click="takeLatest"
						>
							{{ t('compass.settings.conflict.useLatest') }}
						</XButton>
					</div>
				</section>

				<Message
					v-if="saveError"
					variant="danger"
				>
					{{ saveError }}
				</Message>

				<div
					ref="actions"
					class="compass-settings-form__actions"
				>
					<p
						class="compass-settings-form__status"
						:class="{'is-dirty': dirty && !isSaving}"
						role="status"
					>
						<Icon
							v-if="statusIcon"
							:icon="statusIcon"
						/>
						<span v-if="statusText">{{ statusText }}</span>
						<RouterLink
							v-if="showBackLink"
							:to="spaceRoute"
							class="compass-settings-form__back"
						>
							{{ t('compass.settings.backToSpace') }}
						</RouterLink>
					</p>
					<!-- aria-disabled, not disabled: the button keeps focus through the save and after it. -->
					<XButton
						type="submit"
						variant="primary"
						:shadow="false"
						:loading="isBusy"
						:aria-disabled="!canSubmit"
						aria-keyshortcuts="Control+S Meta+S"
					>
						{{ t('misc.save') }}
					</XButton>
				</div>
				<p
					v-if="conflict"
					class="compass-settings-form__hint"
				>
					{{ t('compass.settings.conflict.resolveFirst') }}
				</p>
			</form>

			<div class="compass-settings-form__preview">
				<CompassSpacePreview
					:title="title"
					:motto="motto"
					:theme="theme"
					:sharing="space.team_id > 0 ? 'team' : 'personal'"
					:team-name="teamName"
				/>
			</div>
		</div>

		<Modal
			:enabled="leaveTarget !== null"
			:aria-label="t('compass.settings.leave.title')"
			@close="stay"
		>
			<Card
				:title="t('compass.settings.leave.title')"
				:shadow="false"
				:padding="false"
				:show-close="true"
				class="compass-settings-form__leave has-text-start"
				@close="stay"
			>
				<p class="compass-settings-form__leave-text">
					{{ t('compass.settings.leave.text') }}
				</p>
				<template #footer>
					<XButton
						variant="secondary"
						:shadow="false"
						@click="stay"
					>
						{{ t('compass.settings.leave.stay') }}
					</XButton>
					<XButton
						variant="primary"
						danger
						:shadow="false"
						@click="discardAndLeave"
					>
						{{ t('compass.settings.leave.discard') }}
					</XButton>
				</template>
			</Card>
		</Modal>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed, nextTick, ref, useId, useTemplateRef, watch} from 'vue'
import {
	onBeforeRouteLeave,
	onBeforeRouteUpdate,
	useRouter,
	type RouteLocationNormalized,
} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useEventListener} from '@vueuse/core'

import Editor from '@/components/input/AsyncEditor'
import XButton from '@/components/input/Button.vue'
import FormField from '@/components/input/FormField.vue'
import Card from '@/components/misc/Card.vue'
import Icon from '@/components/misc/Icon'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'
import CompassThemePicker from '@/components/compass/base/CompassThemePicker.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassSharingSummary from './CompassSharingSummary.vue'
import CompassSpacePreview from './CompassSpacePreview.vue'

import {
	normalizeCompassSpace,
	useUpdateCompassSpaceMutation,
	type CompassSpace,
	type CompassSpaceText,
	type RawCompassSpace,
} from '@/client/queries/compass'
import {useCompassSpace} from '@/composables/useCompass'
import {useTeam} from '@/composables/useTeams'
import {
	COMPASS_LIMITS,
	runeLength,
	utf8Bytes,
	type CompassTheme,
} from '@/helpers/compass/constants'
import {classifyCompassFailure, type CompassFailure} from '@/helpers/compass/errors'
import {compassPlainText} from '@/helpers/compass/readerHtml'
import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import {getHumanSize} from '@/helpers/getHumanSize'
import {getErrorText} from '@/message'

type SpaceVersion = CompassSpaceText & {
	revision: number
}

type ConflictRow = {
	key: string
	label: string
	value: string
	differs: boolean
	serif: boolean
}

const props = defineProps<{
	// Seeds the draft once (the parent keys this form by space id); refetches never overwrite it.
	space: CompassSpace
}>()

const {t} = useI18n({useScope: 'global'})
const router = useRouter()

const uid = useId()
const mottoHintId = `${uid}-motto-hint`
const themeHintId = `${uid}-theme-hint`
const prefaceLabelId = `${uid}-preface-label`
const prefaceHintId = `${uid}-preface-hint`
const sharingLabelId = `${uid}-sharing-label`
const conflictTitleId = `${uid}-conflict-title`

const PREFACE_EXCERPT_LENGTH = 280

function versionOf(space: CompassSpace): SpaceVersion {
	return {
		title: space.title,
		motto: space.motto,
		introduction: space.introduction,
		theme: space.theme,
		revision: space.revision,
	}
}

// The editor answers an emptied document with `<p></p>`; that is no preface.
function comparable(text: CompassSpaceText): CompassSpaceText {
	return {
		title: text.title.trim(),
		motto: text.motto.trim(),
		introduction: isEditorContentEmpty(text.introduction) ? '' : text.introduction,
		theme: text.theme,
	}
}

function sameText(a: CompassSpaceText, b: CompassSpaceText): boolean {
	const left = comparable(a)
	const right = comparable(b)
	return left.title === right.title &&
		left.motto === right.motto &&
		left.introduction === right.introduction &&
		left.theme === right.theme
}

/* eslint-disable vue/no-setup-props-reactivity-loss -- keyed form: one snapshot, never replaced by a refetch */
// The saved version the draft builds on: its revision goes with the save and it defines "unsaved".
const base = ref<SpaceVersion>(versionOf(props.space))
const title = ref(props.space.title)
const motto = ref(props.space.motto)
const introduction = ref(props.space.introduction)
const theme = ref<CompassTheme>(props.space.theme)
/* eslint-enable vue/no-setup-props-reactivity-loss */

const draft = computed<CompassSpaceText>(() => comparable({
	title: title.value,
	motto: motto.value,
	introduction: introduction.value,
	theme: theme.value,
}))

const dirty = computed(() => !sameText(draft.value, base.value))

const titleField = useTemplateRef<InstanceType<typeof FormField>>('titleField')
const mottoInput = useTemplateRef<HTMLTextAreaElement>('mottoInput')
const actions = useTemplateRef<HTMLElement>('actions')

// "Required" waits for a save attempt; size limits show as soon as they are crossed.
const attempted = ref(false)

const titleError = computed(() => {
	if (draft.value.title === '') {
		return attempted.value ? t('compass.settings.field.nameRequired') : ''
	}
	return runeLength(draft.value.title) > COMPASS_LIMITS.spaceTitle
		? t('compass.settings.field.nameTooLong', {max: COMPASS_LIMITS.spaceTitle})
		: ''
})

const mottoLength = computed(() => runeLength(draft.value.motto))
const mottoCount = computed(() => t('compass.settings.field.count', {
	count: mottoLength.value,
	max: COMPASS_LIMITS.motto,
}))
const mottoError = computed(() => mottoLength.value > COMPASS_LIMITS.motto
	? t('compass.settings.field.mottoTooLong', {max: COMPASS_LIMITS.motto})
	: '')

const introductionBytes = computed(() => utf8Bytes(draft.value.introduction))
const introductionTooLarge = computed(() => introductionBytes.value > COMPASS_LIMITS.introductionBytes)
const sizeParams = computed(() => ({
	size: getHumanSize(introductionBytes.value),
	max: getHumanSize(COMPASS_LIMITS.introductionBytes),
}))
const introductionSize = computed(() => t('compass.settings.field.prefaceSize', sizeParams.value))

const update = useUpdateCompassSpaceMutation()
const isSaving = computed(() => update.isPending.value)
// After a 409 the latest version is read first; saving again meanwhile could only meet the same 409.
const loadingLatest = ref(false)
const isBusy = computed(() => isSaving.value || loadingLatest.value)
const {refetch} = useCompassSpace(() => props.space.id)

const team = useTeam(() => props.space.team_id)
const teamName = computed(() => team.data.value?.name ?? '')

const spaceRoute = computed(() => ({
	name: 'compass.space',
	params: {spaceId: props.space.id},
}))

// The latest saved version after a 409, shown until the person picks which one to continue from.
const conflict = ref<SpaceVersion | null>(null)
const saveError = ref('')
const notice = ref<'' | 'saved' | 'latest'>('')
// After "Keep my changes" the next save knowingly replaces the version that was just shown.
const overwriting = ref(false)

const canSubmit = computed(() => dirty.value &&
	conflict.value === null &&
	!introductionTooLarge.value &&
	!isBusy.value)

watch(dirty, isDirty => {
	if (isDirty) {
		notice.value = ''
	} else {
		overwriting.value = false
	}
})

const statusText = computed(() => {
	if (isSaving.value) return t('compass.settings.status.saving')
	if (dirty.value) {
		return overwriting.value
			? t('compass.settings.status.overwrite')
			: t('compass.settings.status.unsaved')
	}
	if (notice.value === 'saved') return t('compass.settings.status.saved')
	if (notice.value === 'latest') return t('compass.settings.status.loadedLatest')
	return ''
})

const statusIcon = computed(() => !isSaving.value && !dirty.value && notice.value === 'saved'
	? 'check'
	: undefined)

const showBackLink = computed(() => !isSaving.value && !dirty.value && notice.value !== '')

function adopt(version: SpaceVersion) {
	base.value = version
	title.value = version.title
	motto.value = version.motto
	introduction.value = version.introduction
	theme.value = version.theme
}

// Saved elsewhere while nothing here is unsaved: follow along instead of keeping a stale base.
watch(() => props.space.revision, revision => {
	if (revision <= base.value.revision || dirty.value || isSaving.value || conflict.value !== null) return
	adopt(versionOf(props.space))
})

function failureText(failure: CompassFailure, cause: unknown): string {
	switch (failure) {
		case 'forbidden':
			return t('compass.settings.error.forbidden')
		case 'missing':
			return t('compass.settings.error.missing')
		case 'network':
			return t('compass.settings.error.network')
		default:
			return t('compass.settings.error.failed', {reason: getErrorText(cause)})
	}
}

async function save() {
	if (isBusy.value) return
	attempted.value = true
	if (conflict.value !== null || !dirty.value) return
	if (titleError.value) {
		titleField.value?.focus()
		return
	}
	if (mottoError.value) {
		mottoInput.value?.focus()
		return
	}
	if (introductionTooLarge.value) return

	saveError.value = ''
	const sent = draft.value
	let saved: RawCompassSpace
	try {
		saved = await update.mutateAsync({
			spaceId: props.space.id,
			...sent,
			revision: base.value.revision,
		})
	} catch (cause) {
		const failure = classifyCompassFailure(cause)
		if (failure === 'aborted') return
		if (failure === 'conflict') {
			await showLatest()
			return
		}
		saveError.value = failureText(failure, cause)
		return
	}

	const next = normalizeCompassSpace(saved)
	const version: SpaceVersion = {
		title: next.title,
		motto: next.motto,
		introduction: next.introduction,
		theme: next.theme,
		revision: next.revision > 0 ? next.revision : base.value.revision,
	}
	// Words typed while the request ran stay as unsaved changes on top of the new base.
	if (sameText(draft.value, sent)) {
		adopt(version)
	} else {
		base.value = version
	}
	overwriting.value = false
	notice.value = 'saved'
}

async function showLatest() {
	loadingLatest.value = true
	const result = await refetch().finally(() => {
		loadingLatest.value = false
	})
	if (result.isError || !result.data) {
		if (classifyCompassFailure(result.error) === 'aborted') return
		saveError.value = t('compass.settings.conflict.reloadFailed')
		return
	}
	const latest = versionOf(result.data)
	// Someone saved exactly these words already: nothing to choose between.
	if (sameText(latest, draft.value)) {
		adopt(latest)
		notice.value = 'latest'
		return
	}
	overwriting.value = false
	conflict.value = latest
}

async function focusSave() {
	await nextTick()
	actions.value?.querySelector<HTMLElement>('button[type="submit"]')?.focus()
}

function keepMine() {
	const latest = conflict.value
	if (latest === null) return
	base.value = latest
	conflict.value = null
	overwriting.value = dirty.value
	focusSave()
}

function takeLatest() {
	const latest = conflict.value
	if (latest === null) return
	adopt(latest)
	conflict.value = null
	overwriting.value = false
	saveError.value = ''
	notice.value = 'latest'
	focusSave()
}

function excerpt(html: string): string {
	const characters = Array.from(compassPlainText(html).replace(/\s+/g, ' ').trim())
	return characters.length > PREFACE_EXCERPT_LENGTH
		? `${characters.slice(0, PREFACE_EXCERPT_LENGTH).join('')}…`
		: characters.join('')
}

const conflictRows = computed<ConflictRow[]>(() => {
	const latest = conflict.value
	if (latest === null) return []
	const theirs = comparable(latest)
	const mine = draft.value
	return [
		{
			key: 'title',
			label: t('compass.settings.field.name'),
			value: theirs.title,
			differs: theirs.title !== mine.title,
			serif: true,
		},
		{
			key: 'motto',
			label: t('compass.settings.field.motto'),
			value: theirs.motto,
			differs: theirs.motto !== mine.motto,
			serif: true,
		},
		{
			key: 'theme',
			label: t('compass.settings.field.theme'),
			value: t(`compass.theme.${theirs.theme}`),
			differs: theirs.theme !== mine.theme,
			serif: false,
		},
		{
			key: 'preface',
			label: t('compass.settings.field.preface'),
			value: excerpt(theirs.introduction),
			differs: theirs.introduction !== mine.introduction,
			serif: false,
		},
	]
})

function onKeydown(event: KeyboardEvent) {
	const saveShortcut = event.key.toLowerCase() === 's' &&
		(event.ctrlKey || event.metaKey) &&
		!event.altKey &&
		!event.shiftKey
	if (!saveShortcut) return
	event.preventDefault()
	save()
}

// Leaving with unsaved changes asks first; the route is only followed after an explicit discard.
const leaveTarget = ref<string | null>(null)
let leaving = false

function confirmLeave(to: RouteLocationNormalized) {
	if (leaving || !dirty.value) return true
	leaveTarget.value = to.fullPath
	return false
}

onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)

function stay() {
	leaveTarget.value = null
}

async function discardAndLeave() {
	const target = leaveTarget.value
	if (target === null) return
	leaving = true
	leaveTarget.value = null
	const failure = await router.push(target)
	// Another guard stopped the navigation: the draft is still here and still protected.
	if (failure) leaving = false
}

useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
	if (!dirty.value) return
	event.preventDefault()
	// Older browsers only ask when a return value is set.
	event.returnValue = ''
})
</script>

<style lang="scss" scoped>
.compass-settings-form {
	container-type: inline-size;
}

.compass-settings-form__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-6);
}

.compass-settings-form__form {
	display: flex;
	flex-direction: column;
	gap: var(--space-6);
	min-inline-size: 0;
	max-inline-size: 40rem;

	:deep(.field) {
		margin-block-end: 0;
	}
}

// Stacked: the preview comes first, right under the heading.
.compass-settings-form__preview {
	order: -1;
	min-inline-size: 0;
	max-inline-size: 40rem;
}

@container (min-width: 54rem) {
	.compass-settings-form__layout {
		grid-template-columns: minmax(0, 40rem) minmax(15rem, 1fr);
		align-items: start;
		gap: var(--space-8);
	}

	.compass-settings-form__preview {
		position: sticky;
		inset-block-start: calc(var(--header-height) + var(--space-6));
		order: 0;
		max-inline-size: none;
	}
}

.compass-settings-form__group {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
}

.compass-settings-form__label {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.compass-settings-form__motto {
	min-block-size: 5.5rem;
	resize: vertical;
}

.compass-settings-form__editor {
	min-inline-size: 0;

	&.is-invalid {
		border-radius: $radius;
		outline: 1px solid var(--danger);
		outline-offset: 2px;
	}
}

.compass-settings-form__hint {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-1) 0 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.compass-settings-form__count {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;

	&.is-over {
		color: var(--danger-text);
		font-weight: var(--weight-semibold);
	}
}

.compass-settings-form__conflict {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-md);
	background: var(--tint-warning);
}

.compass-settings-form__conflict-title {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: 0;
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-normal);
}

.compass-settings-form__conflict-icon {
	flex: none;
	margin-block-start: .2rem;
}

.compass-settings-form__conflict-text {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
	line-height: var(--leading-normal);
}

.compass-settings-form__latest-label {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .06em;
	text-transform: uppercase;
}

.compass-settings-form__latest {
	display: flex;
	flex-direction: column;
	margin: 0;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface);
}

.compass-settings-form__latest-row {
	display: grid;
	grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
	gap: var(--space-1) var(--space-3);
	padding: var(--space-2) var(--space-3);

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}
}

@container (max-width: 30rem) {
	.compass-settings-form__latest-row {
		grid-template-columns: minmax(0, 1fr);
	}
}

.compass-settings-form__latest-term {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-settings-form__differs {
	padding: 0 var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	color: var(--text-primary);
	font-size: var(--text-2xs);
	font-weight: var(--weight-medium);
	white-space: nowrap;
}

.compass-settings-form__latest-value {
	margin: 0;
	color: var(--compass-ink);
	font-size: var(--text-md);
	line-height: var(--leading-normal);
	white-space: pre-line;
	overflow-wrap: anywhere;

	&.is-serif {
		font-family: var(--compass-serif);
		font-size: var(--text-base);
	}

	&.is-empty {
		color: var(--text-tertiary);
		font-family: inherit;
		font-style: italic;
	}
}

.compass-settings-form__conflict-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.compass-settings-form__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-2) var(--space-4);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--compass-rule);
}

.compass-settings-form__status {
	display: flex;
	flex: 1 1 12rem;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	min-block-size: var(--control-height);
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);

	&.is-dirty {
		color: var(--compass-ink);
		font-weight: var(--weight-medium);
	}
}

.compass-settings-form__back {
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-underline-offset: .2em;

	&:focus-visible {
		@include focus-ring;
	}

	@media (pointer: coarse) {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--target-min);
	}
}

.compass-settings-form__leave-text {
	max-inline-size: 30rem;
	margin: 0;
	padding: var(--space-4);
	line-height: var(--leading-normal);
}
</style>
