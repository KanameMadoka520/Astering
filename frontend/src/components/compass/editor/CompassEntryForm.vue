<template>
	<form
		ref="rootRef"
		class="compass-desk"
		:aria-labelledby="ids.heading"
		:style="{'--compass-desk-bar': `${Math.round(barHeight)}px`}"
		novalidate
		@submit.prevent="save()"
		@keydown="onShortcut"
	>
		<h1
			:id="ids.heading"
			class="is-sr-only"
		>
			{{ heading }}
		</h1>

		<div
			ref="barRef"
			class="compass-desk__bar"
		>
			<RouterLink
				class="compass-desk__back"
				:to="backTo"
			>
				<Icon
					icon="arrow-left"
					class="compass-desk__back-icon"
					aria-hidden="true"
				/>
				<span class="compass-desk__back-text">{{ backLabel }}</span>
			</RouterLink>
			<div class="compass-desk__state">
				<CompassVisibilityChip :team-id="space.team_id" />
				<CompassSaveStatus
					:state="saveState"
					:saved-at="savedAt"
				/>
				<CompassStateBadge
					v-if="base.state !== 'active'"
					:state="base.state"
				/>
			</div>
			<div class="compass-desk__actions">
				<XButton
					v-if="dirty"
					variant="tertiary"
					:shadow="false"
					icon="undo"
					:aria-disabled="saving"
					@click="askDiscard"
				>
					{{ t('compass.editor.discard') }}
				</XButton>
				<XButton
					variant="primary"
					:shadow="false"
					class="compass-desk__save"
					:loading="saving"
					:aria-disabled="!canSave"
					aria-keyshortcuts="Control+S Meta+S"
					@click="save()"
				>
					{{ t('misc.save') }}
				</XButton>
			</div>
		</div>

		<div class="compass-desk__layout">
			<div class="compass-desk__main">
				<Message
					v-if="staleDraft"
					variant="warning"
				>
					<div class="compass-desk__notice">
						<p class="compass-desk__notice-title">
							{{ t('compass.draft.staleTitle', {
								draftVersion: staleDraft.draft.baseRevision,
								latestVersion: base.revision,
							}) }}
						</p>
						<p>
							{{ t('compass.draft.staleChanged', {fields: fieldList(staleChanges)}) }}
						</p>
						<p class="compass-desk__notice-detail">
							{{ t('compass.draft.staleChoose') }}
						</p>
						<div class="compass-desk__notice-actions">
							<XButton
								variant="secondary"
								:shadow="false"
								@click="continueWithStale"
							>
								{{ t('compass.draft.continue') }}
							</XButton>
							<XButton
								variant="secondary"
								:shadow="false"
								@click="askDiscardStale"
							>
								{{ t('compass.draft.discardMine') }}
							</XButton>
						</div>
					</div>
				</Message>
				<Message
					v-else-if="restoredAt !== null"
					variant="info"
				>
					<div class="compass-desk__notice compass-desk__notice--row">
						<p>
							{{ restoredText }}
						</p>
						<XButton
							variant="tertiary"
							:shadow="false"
							:aria-disabled="saving"
							@click="askDiscardRestored"
						>
							{{ t('compass.draft.discard') }}
						</XButton>
					</div>
				</Message>

				<div
					v-if="conflict"
					ref="conflictRef"
					class="compass-desk__anchor"
				>
					<CompassConflictPanel
						:latest="conflict"
						:fields="fields"
						:space="space"
						:busy="saving"
						@keepMine="keepMine"
						@takeLatest="askTakeLatest"
					/>
				</div>

				<div
					v-if="failure"
					ref="failureRef"
					class="compass-desk__anchor"
				>
					<Message :variant="failure.kind === 'network' ? 'warning' : 'danger'">
						<div class="compass-desk__notice">
							<p
								class="compass-desk__notice-title"
								role="alert"
							>
								{{ t(`compass.editor.failure.${failure.kind}`) }}
							</p>
							<p
								v-if="failure.detail"
								class="compass-desk__notice-detail"
							>
								{{ failure.detail }}
							</p>
							<div class="compass-desk__notice-actions">
								<XButton
									v-if="failure.kind === 'image' && unavailableInBody.length > 0"
									variant="secondary"
									:shadow="false"
									icon="trash-alt"
									@click="removeUnavailableImages"
								>
									{{ t('compass.images.removeUnavailable', {n: unavailableInBody.length}, unavailableInBody.length) }}
								</XButton>
								<XButton
									v-if="failure.kind === 'missing'"
									variant="secondary"
									:shadow="false"
									:loading="saving"
									:aria-disabled="saving"
									@click="saveAsNew"
								>
									{{ t('compass.editor.saveAsNew') }}
								</XButton>
								<XButton
									variant="tertiary"
									:shadow="false"
									@click="dismissFailure"
								>
									{{ t('compass.editor.dismiss') }}
								</XButton>
							</div>
						</div>
					</Message>
				</div>

				<div
					ref="sheetRef"
					class="compass-desk__sheet"
					:inert="holding || undefined"
				>
					<p class="compass-desk__eyebrow">
						<CompassKindLabel :kind="fields.kind" />
						<template v-if="fields.category.trim() !== ''">
							<span
								class="compass-desk__eyebrow-dot"
								aria-hidden="true"
							>·</span>
							<span class="compass-desk__eyebrow-category">{{ fields.category.trim() }}</span>
						</template>
					</p>

					<div class="compass-desk__field">
						<label
							:for="ids.title"
							class="is-sr-only"
						>{{ t('compass.fields.title') }}</label>
						<textarea
							:id="ids.title"
							ref="titleRef"
							v-model="fields.title"
							class="compass-desk__title"
							rows="1"
							:placeholder="t('compass.editor.titlePlaceholder')"
							:aria-invalid="problems.title !== '' || undefined"
							:aria-describedby="noteId('title')"
							autocomplete="off"
							@keydown.enter="onTitleEnter"
						/>
						<CompassFieldNote
							v-if="noteShown('title')"
							:id="`${ids.title}-note`"
							:count="lengths.title"
							:limit="COMPASS_FIELD_LIMITS.title"
							:show-count="countShown('title')"
							:problem="problems.title"
						/>
					</div>

					<div class="compass-desk__field">
						<label
							:for="ids.subtitle"
							class="is-sr-only"
						>{{ t('compass.fields.subtitle') }}</label>
						<input
							:id="ids.subtitle"
							ref="subtitleRef"
							v-model="fields.subtitle"
							class="compass-desk__subtitle"
							type="text"
							:placeholder="t('compass.editor.subtitlePlaceholder')"
							:aria-invalid="problems.subtitle !== '' || undefined"
							:aria-describedby="noteId('subtitle')"
							autocomplete="off"
							@keydown.enter="onSubtitleEnter"
						>
						<CompassFieldNote
							v-if="noteShown('subtitle')"
							:id="`${ids.subtitle}-note`"
							:count="lengths.subtitle"
							:limit="COMPASS_FIELD_LIMITS.subtitle"
							:show-count="countShown('subtitle')"
							:problem="problems.subtitle"
						/>
					</div>

					<div class="compass-desk__field compass-desk__epigraph">
						<label
							:for="ids.quote"
							class="compass-desk__epigraph-label"
						>{{ t('compass.fields.quote') }}</label>
						<textarea
							:id="ids.quote"
							ref="quoteRef"
							v-model="fields.quote"
							class="compass-desk__quote"
							rows="1"
							:placeholder="t('compass.editor.quotePlaceholder')"
							:aria-invalid="problems.quote !== '' || undefined"
							:aria-describedby="noteId('quote')"
						/>
						<CompassFieldNote
							v-if="noteShown('quote')"
							:id="`${ids.quote}-note`"
							:count="lengths.quote"
							:limit="COMPASS_FIELD_LIMITS.quote"
							:show-count="countShown('quote')"
							:problem="problems.quote"
						/>
					</div>

					<div
						class="compass-desk__ornament"
						aria-hidden="true"
					>
						<CompassGlyph kind="guide" />
					</div>

					<div class="compass-desk__body">
						<Editor
							v-model="fields.content"
							always-editing
							:image-source="images.source"
							:allow-task-lists="false"
							:placeholder="t('compass.editor.bodyPlaceholder')"
							@save="save()"
						/>
						<div
							class="compass-desk__media"
							role="group"
							:aria-label="t('compass.images.groupLabel')"
						>
							<XButton
								variant="tertiary"
								:shadow="false"
								class="is-small"
								icon="image"
								@click="imageInput?.click()"
							>
								{{ t('compass.images.add') }}
							</XButton>
							<XButton
								variant="tertiary"
								:shadow="false"
								class="is-small"
								icon="folder"
								@click="images.openDrive()"
							>
								{{ t('compass.images.fromDrive') }}
							</XButton>
							<span
								v-if="bodyImageIds.length > 0"
								class="compass-desk__media-count"
								:class="{'is-full': bodyImageIds.length >= COMPASS_IMAGE_LIMITS.perEntry}"
							>
								{{ t('compass.images.count', {n: bodyImageIds.length, limit: COMPASS_IMAGE_LIMITS.perEntry}) }}
							</span>
							<input
								ref="imageInput"
								type="file"
								class="is-hidden"
								:accept="COMPASS_IMAGE_ACCEPT"
								multiple
								@change="onImageInput"
							>
						</div>
						<p
							v-if="images.notice.value"
							class="compass-desk__media-notice"
							role="alert"
						>
							<span>{{ images.notice.value }}</span>
							<button
								type="button"
								class="compass-desk__media-link"
								@click="images.clearNotice()"
							>
								{{ t('compass.editor.dismiss') }}
							</button>
						</p>
						<p
							v-if="unavailableInBody.length > 0"
							class="compass-desk__media-notice is-warning"
						>
							<span>{{ t('compass.images.unavailableInBody', {n: unavailableInBody.length}, unavailableInBody.length) }}</span>
							<button
								type="button"
								class="compass-desk__media-link"
								@click="removeUnavailableImages"
							>
								{{ t('compass.images.removeUnavailable', {n: unavailableInBody.length}, unavailableInBody.length) }}
							</button>
						</p>
						<CompassImageTray
							v-if="images.items.value.length > 0"
							:items="images.items.value"
							:running="images.running.value"
							@retry="images.retry"
							@cancel="images.cancel()"
							@dismiss="images.dismiss"
							@clearFinished="images.clearFinished()"
						/>
						<p
							v-if="contentNoteShown"
							ref="contentNoteRef"
							class="compass-desk__size"
							:class="{'is-problem': contentTooLarge}"
							:role="contentTooLarge ? 'alert' : undefined"
						>
							{{ contentNote }}
						</p>
					</div>
				</div>
			</div>

			<component
				:is="wide ? 'aside' : 'details'"
				class="compass-desk__aside"
				:class="{'is-collapsible': !wide}"
				:aria-label="wide ? t('compass.editor.details') : undefined"
				:open="wide ? undefined : detailsOpen"
				:inert="holding || undefined"
				@toggle="onDetailsToggle"
			>
				<summary
					v-if="!wide"
					class="compass-desk__summary"
				>
					<span class="compass-desk__summary-title">{{ t('compass.editor.details') }}</span>
					<span class="compass-desk__summary-meta">{{ detailsSummary }}</span>
					<Icon
						icon="chevron-down"
						class="compass-desk__summary-icon"
						aria-hidden="true"
					/>
				</summary>
				<div class="compass-desk__aside-inner">
					<CompassKindPicker
						v-model="fields.kind"
						:label="t('compass.fields.kind')"
						name="compass-entry-kind"
					/>

					<div class="compass-desk__control">
						<label
							:for="ids.category"
							class="compass-desk__label"
						>{{ t('compass.fields.category') }}</label>
						<input
							:id="ids.category"
							ref="categoryRef"
							v-model="fields.category"
							class="input"
							type="text"
							:list="ids.categories"
							:placeholder="t('compass.editor.categoryPlaceholder')"
							:aria-invalid="problems.category !== '' || undefined"
							:aria-describedby="noteId('category')"
							autocomplete="off"
						>
						<datalist :id="ids.categories">
							<option
								v-for="category in categorySuggestions"
								:key="category"
								:value="category"
							/>
						</datalist>
						<CompassFieldNote
							v-if="noteShown('category')"
							:id="`${ids.category}-note`"
							:count="lengths.category"
							:limit="COMPASS_FIELD_LIMITS.category"
							:show-count="countShown('category')"
							:problem="problems.category"
						/>
					</div>

					<CompassTagInput
						v-model="fields.tags"
						:label="t('compass.fields.tags')"
						:suggestions="tagSuggestions"
					/>

					<CompassThemePicker
						v-model="fields.theme"
						:label="t('compass.fields.theme')"
						name="compass-entry-theme"
						include-inherit
						:inherit-from="space.theme"
					/>

					<div
						v-if="currentEntryId === 0"
						class="compass-desk__control"
					>
						<label class="compass-desk__pin">
							<input
								v-model="fields.pinned"
								type="checkbox"
								:aria-describedby="`${ids.pin}-hint`"
							>
							<span class="compass-desk__pin-text">
								<CompassGlyph kind="guide" />
								{{ t('compass.editor.pin') }}
							</span>
						</label>
						<p
							:id="`${ids.pin}-hint`"
							class="compass-desk__hint"
						>
							{{ t('compass.editor.pinHint') }}
						</p>
					</div>

					<p class="compass-desk__hint compass-desk__shortcut">
						{{ t('compass.editor.saveHint') }}
					</p>
				</div>
			</component>
		</div>

		<!-- Every way of throwing text away asks first: the bar's Discard, both draft banners and "use the latest". -->
		<Modal
			v-if="discardDialog"
			:aria-label="discardDialog.title"
			@close="confirmingDiscard = null"
		>
			<Card
				:title="discardDialog.title"
				:shadow="false"
				:padding="false"
				:show-close="true"
				class="compass-desk__dialog compass-desk__discard-dialog has-text-start"
				@close="confirmingDiscard = null"
			>
				<p class="compass-desk__dialog-text">
					{{ discardDialog.text }}
				</p>
				<template #footer>
					<XButton
						variant="secondary"
						:shadow="false"
						autofocus
						@click="confirmingDiscard = null"
					>
						{{ t('compass.leave.stay') }}
					</XButton>
					<XButton
						variant="primary"
						danger
						:shadow="false"
						class="compass-desk__discard-confirm"
						@click="confirmDiscard"
					>
						{{ discardDialog.confirm }}
					</XButton>
				</template>
			</Card>
		</Modal>

		<DrivePicker
			v-if="images.driveOpen.value"
			images
			:busy="images.driveBusy.value"
			@close="images.closeDrive()"
			@select="images.pickFromDrive"
		/>

		<Modal
			v-if="images.replacing.value"
			:aria-label="t('compass.images.replaceTitle')"
			@close="images.closeReplace()"
		>
			<Card
				:title="t('compass.images.replaceTitle')"
				:shadow="false"
				:padding="false"
				:show-close="true"
				class="compass-desk__dialog has-text-start"
				@close="images.closeReplace()"
			>
				<p class="compass-desk__dialog-text">
					{{ t('compass.images.replaceText') }}
				</p>
				<template #footer>
					<XButton
						variant="secondary"
						:shadow="false"
						icon="folder"
						@click="images.openDrive(true)"
					>
						{{ t('compass.images.fromDrive') }}
					</XButton>
					<XButton
						variant="primary"
						:shadow="false"
						icon="cloud-upload-alt"
						autofocus
						@click="replaceInput?.click()"
					>
						{{ t('compass.images.upload') }}
					</XButton>
				</template>
			</Card>
		</Modal>
		<input
			ref="replaceInput"
			type="file"
			class="is-hidden"
			:accept="COMPASS_IMAGE_ACCEPT"
			@change="onReplaceInput"
		>

		<CompassLeaveDialog
			v-if="leaving"
			:store-failed="storeFailed"
			:unsaved="dirty"
			:uploading="images.pending.value"
			@stay="answerLeave('stay')"
			@keep="answerLeave('keep')"
			@discard="answerLeave('discard')"
		/>
	</form>
</template>

<script setup lang="ts">
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	useId,
	watch,
} from 'vue'
import {useI18n} from 'vue-i18n'
import {
	onBeforeRouteLeave,
	onBeforeRouteUpdate,
	type RouteLocationNormalized,
	type RouteLocationRaw,
} from 'vue-router'
import {
	useElementSize,
	useEventListener,
	useMediaQuery,
	useResizeObserver,
} from '@vueuse/core'

import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassKindLabel from '@/components/compass/base/CompassKindLabel.vue'
import CompassStateBadge from '@/components/compass/base/CompassStateBadge.vue'
import CompassVisibilityChip from '@/components/compass/base/CompassVisibilityChip.vue'
import CompassThemePicker from '@/components/compass/base/CompassThemePicker.vue'
import DrivePicker from '@/components/drive/DrivePicker.vue'
import Editor from '@/components/input/AsyncEditor'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Icon from '@/components/misc/Icon'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'
import CompassConflictPanel from './CompassConflictPanel.vue'
import CompassFieldNote from './CompassFieldNote.vue'
import CompassImageTray from './CompassImageTray.vue'
import CompassKindPicker from './CompassKindPicker.vue'
import CompassLeaveDialog from './CompassLeaveDialog.vue'
import CompassSaveStatus, {type CompassSaveState} from './CompassSaveStatus.vue'
import CompassTagInput from './CompassTagInput.vue'
import {COMPASS_IMAGE_ACCEPT, useCompassImageEditing} from './useCompassImageEditing'

import {ApiError} from '@/client/problem'
import {
	normalizeCompassEntry,
	useCreateCompassEntryMutation,
	useUpdateCompassEntryMutation,
	type CompassEntry,
	type CompassSpace,
} from '@/client/queries/compass'
import {
	useCompassAccountNamespace,
	useCompassEntry,
	useCompassTopics,
} from '@/composables/useCompass'
import {
	cloneCompassDraftFields,
	useCompassEntryDraft,
	type CompassStoredDraft,
} from '@/composables/useCompassEntryDraft'
import {
	COMPASS_ERROR_CODES,
	COMPASS_LIMITS,
	utf8Bytes,
	type CompassEntryTheme,
	type CompassKind,
} from '@/helpers/compass/constants'
import {
	changedCompassDraftFields,
	emptyCompassDraftFields,
	type CompassDraftFields,
} from '@/helpers/compass/drafts'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {COMPASS_IMAGE_LIMITS, compassImageIds} from '@/helpers/compass/images'
import {getHumanSize} from '@/helpers/getHumanSize'
import {formatDateShort} from '@/helpers/time/formatDate'
import {getErrorText} from '@/message'
import {
	COMPASS_CONTENT_NOTICE_BYTES,
	COMPASS_FIELD_LIMITS,
	COMPASS_LIMITED_FIELDS,
	compassDeskFailure,
	compassDraftFieldsOf,
	compassFieldLengths,
	compassTextForSave,
	formatCompassFieldList,
	showsCompassCounter,
	type CompassDeskBase,
	type CompassDeskFailure,
	type CompassLimitedField,
} from './entryForm'

const props = withDefaults(defineProps<{
	space: CompassSpace
	// Undefined for a new entry.
	entry?: CompassEntry
	initialKind?: CompassKind
}>(), {
	entry: undefined,
	initialKind: 'note',
})

const emit = defineEmits<{
	// An entry now exists for this text: created here, or saved anew after the old one was deleted.
	created: [entry: CompassEntry]
	theme: [theme: CompassEntryTheme]
}>()

type DeskField = CompassLimitedField | 'content'
type SaveMode = 'create' | 'update' | 'recreate'
type LeaveChoice = 'stay' | 'keep' | 'discard'
// What a confirmed discard throws away: the desk's changes, a restored or stale draft, or the writer's text for the latest version.
type DiscardKind = 'changes' | 'restored' | 'stale' | 'latest'
type DeskFailureNotice = {
	kind: CompassDeskFailure
	detail: string
}

const {t, locale} = useI18n({useScope: 'global'})
const namespace = useCompassAccountNamespace()

const uid = useId()
const ids = {
	heading: `${uid}-heading`,
	title: `${uid}-title`,
	subtitle: `${uid}-subtitle`,
	quote: `${uid}-quote`,
	category: `${uid}-category`,
	categories: `${uid}-categories`,
	pin: `${uid}-pin`,
}

// The desk is keyed per entry and space (CompassEntryEditor) and seeds once: a background refetch must
// never replace what is being typed. Later versions arrive only through the conflict panel.
/* eslint-disable vue/no-setup-props-reactivity-loss */
const spaceId = props.space.id
const seed = props.entry ? compassDraftFieldsOf(props.entry) : emptyCompassDraftFields(props.initialKind)
const currentEntryId = ref(props.entry?.id ?? 0)
const base = ref<CompassDeskBase>({
	fields: cloneCompassDraftFields(seed),
	revision: props.entry?.revision ?? 0,
	state: props.entry?.state ?? 'active',
})
/* eslint-enable vue/no-setup-props-reactivity-loss */
const fields = ref<CompassDraftFields>(cloneCompassDraftFields(seed))

// A draft written against an older version waits for the writer's decision; the desk is paused meanwhile.
const staleDraft = ref<CompassStoredDraft | null>(null)
const holding = computed(() => staleDraft.value !== null)

const draft = useCompassEntryDraft({
	namespace,
	spaceId,
	entryId: currentEntryId,
	fields,
	base: () => base.value,
	hold: holding,
})
const {dirty, persistence, storeFailed} = draft

const restoredAt = ref<string | null>(null)

// Pin is part of the writing only until the entry exists.
function withBasePin(next: CompassDraftFields): CompassDraftFields {
	return currentEntryId.value > 0
		? {
			...next,
			pinned: base.value.fields.pinned,
		}
		: next
}

function writingChanges(a: CompassDraftFields, b: CompassDraftFields): (keyof CompassDraftFields)[] {
	return changedCompassDraftFields(a, b).filter(field => field !== 'pinned' || currentEntryId.value === 0)
}

const found = draft.stored
// The base still equals `seed` here (and base.value may not be read at setup level: no-ref-object-reactivity-loss).
if (found && writingChanges(found.draft.fields, seed).length === 0) {
	draft.clear()
} else if (found?.stale) {
	staleDraft.value = found
} else if (found) {
	draft.restore(withBasePin(found.draft.fields))
	restoredAt.value = found.draft.savedAt
}

const staleChanges = computed(() => staleDraft.value
	? writingChanges(staleDraft.value.draft.fields, base.value.fields)
	: [])

function fieldList(list: (keyof CompassDraftFields)[]): string {
	return formatCompassFieldList(list.map(field => t(`compass.fields.${field}`)), locale.value)
}

const restoredText = computed(() => {
	const time = formatDateShort(restoredAt.value)
	return time === ''
		? t('compass.draft.restoredNoTime')
		: t('compass.draft.restored', {time})
})

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const images = useCompassImageEditing(spaceId)
const imageInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const bodyImageIds = computed(() => compassImageIds(fields.value.content))
// Pictures the editor could not show here, e.g. copied from another space or removed from the drive.
const unavailableInBody = computed(() => bodyImageIds.value.filter(id => images.unavailable.value.has(id)))

function takeFiles(event: Event): File[] {
	const input = event.target as HTMLInputElement
	const files = Array.from(input.files ?? [])
	// Picking the same file again must fire another change.
	input.value = ''
	return files
}

function onImageInput(event: Event) {
	images.addFromButton(takeFiles(event))
}

function onReplaceInput(event: Event) {
	images.replaceWithFiles(takeFiles(event))
}

// A refused image is named in the message ("Image 12 is not available…"); when that id is in the body, the
// desk points it out. The count limit names no image, only the number 100.
function flagRefusedImage(cause: unknown) {
	if (!(cause instanceof ApiError) || cause.code === COMPASS_ERROR_CODES.imageLimit) return
	for (const match of cause.detail.matchAll(/\bImage (\d{1,19})\b/g)) {
		const id = Number(match[1])
		if (bodyImageIds.value.includes(id)) images.markUnavailable(id)
	}
}

function removeUnavailableImages() {
	images.removeUnavailable()
	if (failure.value?.kind === 'image') failure.value = null
}

const topics = useCompassTopics(spaceId)
const categorySuggestions = computed(() => topics.categories.value.map(category => category.name))
const tagSuggestions = computed(() => topics.tags.value.map(tag => tag.name))

// Reads the latest version when a save meets a newer one.
const latestEntry = useCompassEntry(currentEntryId)
const createEntry = useCreateCompassEntryMutation()
const updateEntry = useUpdateCompassEntryMutation()

const saving = ref(false)
const savedAt = ref<Date | null>(null)
// Set by a save attempt: from then on an empty title is pointed out.
const attempted = ref(false)
const failure = ref<DeskFailureNotice | null>(null)
const conflict = ref<CompassEntry | null>(null)
const confirmingDiscard = ref<DiscardKind | null>(null)
const leaving = ref(false)

const wide = useMediaQuery('(min-width: 1024px)')
const detailsOpen = ref(true)

const rootRef = ref<HTMLFormElement | null>(null)
const barRef = ref<HTMLElement | null>(null)
const sheetRef = ref<HTMLElement | null>(null)
const titleRef = ref<HTMLTextAreaElement | null>(null)
const subtitleRef = ref<HTMLInputElement | null>(null)
const quoteRef = ref<HTMLTextAreaElement | null>(null)
const categoryRef = ref<HTMLInputElement | null>(null)
const contentNoteRef = ref<HTMLElement | null>(null)
const conflictRef = ref<HTMLElement | null>(null)
const failureRef = ref<HTMLElement | null>(null)

// Sticky offsets below the bar (editor toolbar, scroll margins) follow its real, wrapping height.
const {height: barHeight} = useElementSize(barRef, undefined, {box: 'border-box'})

let alive = true

const heading = computed(() => currentEntryId.value === 0
	? t('compass.editor.headingNew', {space: props.space.title})
	: t('compass.editor.headingEdit', {title: base.value.fields.title || t('compass.conflict.untitled')}))

const backTo = computed<RouteLocationRaw>(() => currentEntryId.value > 0
	? {
		name: 'compass.entry',
		params: {entryId: currentEntryId.value},
	}
	: {
		name: 'compass.space',
		params: {spaceId},
	})

const backLabel = computed(() => currentEntryId.value > 0
	? t('compass.editor.backToEntry')
	: t('compass.editor.backToSpace', {space: props.space.title}))

const saveState = computed<CompassSaveState>(() => {
	if (saving.value) return 'saving'
	if (dirty.value && storeFailed.value) return 'unstored'
	if (dirty.value && (failure.value !== null || conflict.value !== null)) return 'failed'
	// Saved text with pictures still on their way is not finished yet.
	if (images.pending.value > 0) return 'uploading'
	if (!dirty.value) return currentEntryId.value === 0 ? 'new' : 'saved'
	return persistence.value === 'stored' ? 'stored' : 'dirty'
})

// An existing entry with nothing changed has nothing to save; a new one explains what is missing instead.
const canSave = computed(() => !saving.value && !holding.value && (currentEntryId.value === 0 || dirty.value))

const detailsSummary = computed(() => [t(`compass.kind.${fields.value.kind}`), fields.value.category.trim()]
	.filter(part => part !== '')
	.join(' · '))

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const lengths = computed(() => compassFieldLengths(fields.value))

const problems = computed(() => {
	const result: Record<CompassLimitedField, string> = {
		title: '',
		subtitle: '',
		quote: '',
		category: '',
	}
	for (const field of COMPASS_LIMITED_FIELDS) {
		const limit = COMPASS_FIELD_LIMITS[field]
		const over = lengths.value[field] - limit
		if (over > 0) {
			result[field] = t('compass.editor.tooLong', {
				over,
				limit,
			})
		}
	}
	if (attempted.value && result.title === '' && lengths.value.title === 0) {
		result.title = t('compass.editor.titleRequired')
	}
	return result
})

function countShown(field: CompassLimitedField): boolean {
	return showsCompassCounter(lengths.value[field], COMPASS_FIELD_LIMITS[field])
}

function noteShown(field: CompassLimitedField): boolean {
	return countShown(field) || problems.value[field] !== ''
}

function noteId(field: CompassLimitedField): string | undefined {
	return noteShown(field) ? `${ids[field]}-note` : undefined
}

// UTF-16 length times three bounds the UTF-8 size, so ordinary bodies skip encoding on every keystroke.
const contentBytes = computed(() => {
	const content = fields.value.content
	return content.length * 3 < COMPASS_CONTENT_NOTICE_BYTES ? 0 : utf8Bytes(content)
})
const contentNoteShown = computed(() => contentBytes.value >= COMPASS_CONTENT_NOTICE_BYTES)
const contentTooLarge = computed(() => contentBytes.value > COMPASS_LIMITS.contentBytes)
const contentNote = computed(() => {
	const sizes = {
		size: getHumanSize(contentBytes.value),
		limit: getHumanSize(COMPASS_LIMITS.contentBytes),
	}
	return contentTooLarge.value
		? t('compass.editor.contentTooLarge', sizes)
		: t('compass.editor.contentSize', sizes)
})

function blockingField(): DeskField | null {
	if (lengths.value.title === 0) return 'title'
	const over = COMPASS_LIMITED_FIELDS.find(field => lengths.value[field] > COMPASS_FIELD_LIMITS[field])
	if (over) return over
	return contentTooLarge.value ? 'content' : null
}

async function focusProblem(field: DeskField) {
	if (field === 'category' && !wide.value) detailsOpen.value = true
	await nextTick()
	if (field === 'content') {
		contentNoteRef.value?.scrollIntoView({block: 'nearest'})
		return
	}
	const targets: Record<CompassLimitedField, HTMLElement | null> = {
		title: titleRef.value,
		subtitle: subtitleRef.value,
		quote: quoteRef.value,
		category: categoryRef.value,
	}
	targets[field]?.focus()
}

/** Points at the first field that keeps the entry from saving; true when there is one. */
async function blocked(): Promise<boolean> {
	const field = blockingField()
	if (field === null) return false
	attempted.value = true
	await focusProblem(field)
	return true
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save() {
	if (!canSave.value) return
	if (await blocked()) return
	await submit(currentEntryId.value === 0 ? 'create' : 'update')
}

async function saveAsNew() {
	if (saving.value || holding.value) return
	if (await blocked()) return
	await submit('recreate')
}

async function submit(mode: SaveMode) {
	const focused = document.activeElement
	const snapshot = cloneCompassDraftFields(fields.value)
	const text = compassTextForSave(snapshot)
	saving.value = true
	// "Save as a new entry" lives in the failure message; it stays (and keeps focus) until that save succeeds.
	if (mode !== 'recreate') failure.value = null
	let saved: CompassEntry
	try {
		saved = mode === 'update'
			? normalizeCompassEntry(await updateEntry.mutateAsync({
				entryId: currentEntryId.value,
				spaceId,
				entry: {
					...text,
					// Pin and state come from the version the text builds on, so the save never rolls them back.
					pinned: base.value.fields.pinned,
					state: base.value.state,
				},
				revision: base.value.revision,
			}))
			: await createEntry.mutateAsync({
				spaceId,
				entry: {
					...text,
					pinned: snapshot.pinned,
				},
			})
	} catch (cause) {
		saving.value = false
		await handleFailure(cause, mode !== 'update')
		await keepFocus(focused)
		return
	}
	saving.value = false
	settleSaved(saved, snapshot)
	if (mode !== 'update' && alive) emit('created', saved)
	await keepFocus(focused)
}

// Saving can remove the control that had focus (pin box, Discard, a banner's button); Save takes over then.
async function keepFocus(previous: Element | null) {
	await nextTick()
	if (alive && previous instanceof HTMLElement && !previous.isConnected) await focusSave()
}

function settleSaved(saved: CompassEntry, snapshot: CompassDraftFields) {
	// The server cleans the body (link attributes and the like). Comparing against its copy would mark a
	// just-saved entry as changed again, so the base keeps the text that was sent.
	base.value = {
		fields: {
			...compassTextForSave(snapshot),
			pinned: saved.pinned,
		},
		revision: saved.revision,
		state: saved.state,
	}
	currentEntryId.value = saved.id
	conflict.value = null
	failure.value = null
	restoredAt.value = null
	attempted.value = false
	savedAt.value = new Date()
	// Also runs when the desk was left while saving: the draft then moves or goes right away.
	draft.settle()
}

async function handleFailure(cause: unknown, creating: boolean) {
	const kind = classifyCompassFailure(cause)
	if (kind === 'aborted') return
	// Whatever went wrong, the text has to survive a reload from here on.
	draft.persistNow()
	if (kind === 'conflict' && !creating) {
		await showLatest()
		return
	}
	if (kind === 'image') flagRefusedImage(cause)
	// The server names the image that cannot be used; that is the detail worth reading.
	await showFailure(compassDeskFailure(kind, creating), kind === 'other' || kind === 'image' ? getErrorText(cause) : '')
}

async function showFailure(kind: CompassDeskFailure, detail: string) {
	failure.value = {
		kind,
		detail,
	}
	await nextTick()
	failureRef.value?.scrollIntoView({block: 'nearest'})
}

async function showLatest() {
	const entryId = currentEntryId.value
	const result = await latestEntry.refetch()
	if (entryId !== currentEntryId.value) return
	if (result.isError || !result.data) {
		const kind = classifyCompassFailure(result.error)
		if (kind === 'aborted') return
		if (kind === 'missing') {
			await showFailure('missing', '')
			return
		}
		await showFailure('conflictUnloaded', result.error ? getErrorText(result.error) : '')
		return
	}
	conflict.value = result.data
	await nextTick()
	conflictRef.value?.scrollIntoView({block: 'start'})
}

// The next save knowingly replaces the version just shown.
async function keepMine() {
	const latest = conflict.value
	if (!latest || saving.value) return
	base.value = {
		fields: compassDraftFieldsOf(latest),
		revision: latest.revision,
		state: latest.state,
	}
	conflict.value = null
	failure.value = null
	await focusSave()
}

function askTakeLatest() {
	if (!conflict.value || saving.value) return
	confirmingDiscard.value = 'latest'
}

async function takeLatest() {
	const latest = conflict.value
	if (!latest || saving.value) return
	const next = compassDraftFieldsOf(latest)
	base.value = {
		fields: next,
		revision: latest.revision,
		state: latest.state,
	}
	fields.value = cloneCompassDraftFields(next)
	conflict.value = null
	failure.value = null
	draft.clear()
	await focusTitle()
}

async function dismissFailure() {
	failure.value = null
	await focusTitle()
}

// ---------------------------------------------------------------------------
// Drafts and discarding
// ---------------------------------------------------------------------------

async function focusTitle() {
	await nextTick()
	titleRef.value?.focus()
}

async function focusSave() {
	await nextTick()
	rootRef.value?.querySelector<HTMLElement>('.compass-desk__save')?.focus()
}

function askDiscard() {
	if (saving.value || !dirty.value) return
	confirmingDiscard.value = 'changes'
}

function askDiscardRestored() {
	if (saving.value) return
	confirmingDiscard.value = 'restored'
}

function askDiscardStale() {
	if (!staleDraft.value) return
	confirmingDiscard.value = 'stale'
}

const discardDialog = computed(() => {
	switch (confirmingDiscard.value) {
		case 'changes': return {
			title: t('compass.editor.discardTitle'),
			text: currentEntryId.value === 0 ? t('compass.editor.discardTextNew') : t('compass.editor.discardText'),
			confirm: t('compass.editor.discardConfirm'),
		}
		case 'restored':
		case 'stale': return {
			title: t('compass.draft.discardTitle'),
			text: t('compass.draft.discardText'),
			confirm: t('compass.draft.discard'),
		}
		case 'latest': return {
			title: t('compass.conflict.takeLatestTitle'),
			text: t('compass.conflict.takeLatestText'),
			confirm: t('compass.conflict.takeLatest'),
		}
		default: return null
	}
})

async function confirmDiscard() {
	const kind = confirmingDiscard.value
	confirmingDiscard.value = null
	if (kind === 'changes') await discardChanges()
	else if (kind === 'restored') await discardRestored()
	else if (kind === 'stale') await discardStale()
	else if (kind === 'latest') await takeLatest()
}

async function discardChanges() {
	fields.value = cloneCompassDraftFields(base.value.fields)
	draft.clear()
	failure.value = null
	restoredAt.value = null
	attempted.value = false
	await focusTitle()
}

async function discardRestored() {
	// The save in flight would make its text the base, and the discarded draft would come back as changes.
	if (saving.value) return
	fields.value = cloneCompassDraftFields(base.value.fields)
	draft.clear()
	restoredAt.value = null
	await focusTitle()
}

async function continueWithStale() {
	const stale = staleDraft.value
	if (!stale) return
	fields.value = withBasePin(cloneCompassDraftFields(stale.draft.fields))
	staleDraft.value = null
	await focusTitle()
}

async function discardStale() {
	if (!staleDraft.value) return
	draft.clear()
	staleDraft.value = null
	await focusTitle()
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

let resolveLeave: ((allow: boolean) => void) | null = null

function askLeave(): Promise<boolean> {
	// A second navigation while the dialog is open replaces the first one.
	resolveLeave?.(false)
	leaving.value = true
	return new Promise(resolve => {
		resolveLeave = resolve
	})
}

function answerLeave(choice: LeaveChoice) {
	const resolve = resolveLeave
	resolveLeave = null
	leaving.value = false
	if (choice === 'keep') draft.persistNow()
	if (choice === 'discard') draft.clear()
	resolve?.(choice !== 'stay')
}

// The edit address of the entry on this desk (e.g. right after creating it) is not a departure.
function staysOnDesk(to: RouteLocationNormalized): boolean {
	return currentEntryId.value > 0 &&
		to.name === 'compass.entry.edit' &&
		Number(to.params.entryId) === currentEntryId.value
}

async function confirmLeave(to: RouteLocationNormalized): Promise<boolean> {
	// Images still uploading are lost on leaving too, even when the text itself is saved.
	if (staysOnDesk(to) || (!dirty.value && images.pending.value === 0)) return true
	return askLeave()
}

onBeforeRouteLeave(to => confirmLeave(to))
onBeforeRouteUpdate(to => confirmLeave(to))

// Closing the tab cancels uploads as well; the draft composable only asks for unsaved text.
useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
	if (images.pending.value === 0) return
	event.preventDefault()
})

// ---------------------------------------------------------------------------
// Keyboard and layout
// ---------------------------------------------------------------------------

function onShortcut(event: KeyboardEvent) {
	if (event.defaultPrevented || event.isComposing) return
	if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
	if (event.key.toLowerCase() !== 's') return
	// The browser's "save page" dialog is never what a writer means here.
	event.preventDefault()
	if (confirmingDiscard.value || leaving.value) return
	save()
}

// Dialogs are teleported out of the form, and focus may sit on the page itself.
useEventListener(window, 'keydown', onShortcut)

function onTitleEnter(event: KeyboardEvent) {
	// An input method confirms its candidate with Enter.
	if (event.isComposing) return
	event.preventDefault()
	subtitleRef.value?.focus()
}

function onSubtitleEnter(event: KeyboardEvent) {
	if (event.isComposing) return
	event.preventDefault()
	quoteRef.value?.focus()
}

// A title is one line, even when pasted with line breaks.
watch(() => fields.value.title, title => {
	if (/[\r\n]/.test(title)) fields.value.title = title.replace(/\s*[\r\n]+\s*/g, ' ')
})

function grow(element: HTMLTextAreaElement | null) {
	if (!element) return
	element.style.blockSize = 'auto'
	const frame = element.offsetHeight - element.clientHeight
	element.style.blockSize = `${element.scrollHeight + frame}px`
}

function growAll() {
	grow(titleRef.value)
	grow(quoteRef.value)
}

watch(() => [fields.value.title, fields.value.quote], growAll, {flush: 'post'})

// Line wrapping changes with the width only; growing changes the height, which must not loop back here.
let sheetWidth = 0
useResizeObserver(sheetRef, entries => {
	const width = entries[0]?.contentRect.width ?? 0
	if (width === sheetWidth) return
	sheetWidth = width
	growAll()
})

function onDetailsToggle(event: Event) {
	if (event.target instanceof HTMLDetailsElement) detailsOpen.value = event.target.open
}

watch(() => fields.value.theme, theme => emit('theme', theme), {immediate: true})

onMounted(() => {
	growAll()
	// A fresh page starts at the title, except on phones where the keyboard would cover half the screen.
	if (currentEntryId.value === 0 && !holding.value && window.innerWidth > 769) titleRef.value?.focus()
})

onBeforeUnmount(() => {
	alive = false
	resolveLeave?.(false)
	resolveLeave = null
})

defineExpose({focusTitle})
</script>

<style lang="scss" scoped>
.compass-desk {
	--compass-desk-offset: calc(var(--header-height) + var(--compass-desk-bar, 0px));

	max-inline-size: 72rem;
	margin-inline: auto;

	// The page already keeps focus clear of the app header (theme.scss); this adds the desk's own bar.
	:deep(:where(input, textarea, select, button, a, summary, [tabindex])) {
		scroll-margin-block-start: calc(var(--compass-desk-bar, 0px) + var(--space-4));
	}
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

.compass-desk__bar {
	position: sticky;
	inset-block-start: var(--header-height);
	z-index: var(--layer-sticky);
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-4);
	margin-block-end: var(--space-5);
	padding-block: var(--space-2);
	border-block-end: 1px solid var(--compass-rule);
	background: var(--surface-app);

	@media print {
		display: none;
	}
}

.compass-desk__back {
	display: inline-flex;
	flex: none;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	max-inline-size: min(20rem, 45vw);
	min-block-size: max(var(--control-height), var(--target-min));
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);

	&:hover {
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-desk__back-icon {
	flex: none;
}

.compass-desk__back-text {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.compass-desk__state {
	display: flex;
	flex: 1 1 12rem;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	min-inline-size: 0;
}

.compass-desk__actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-2);
	margin-inline-start: auto;

	@media (pointer: coarse) {
		:deep(.button) {
			min-block-size: var(--target-min);
		}
	}
}

// On a phone the status gets a line of its own under the back link and the buttons.
@media (width <= 640px) {
	.compass-desk__state {
		flex-basis: 100%;
		order: 3;
	}
}

@media (width <= 480px) {
	.compass-desk__back {
		justify-content: center;
		min-inline-size: var(--target-min);
	}

	// Still the link's name for assistive technology; only the arrow shows.
	.compass-desk__back-text {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

.compass-desk__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-5);

	> * {
		justify-self: center;
		inline-size: 100%;
		max-inline-size: 46rem;
	}

	@media screen and (width >= 1024px) {
		grid-template-columns: minmax(0, 46rem) 18rem;
		justify-content: center;
		align-items: start;
		gap: var(--space-8);

		> * {
			max-inline-size: none;
		}
	}
}

.compass-desk__main {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	min-inline-size: 0;
}

.compass-desk__anchor {
	scroll-margin-block-start: calc(var(--compass-desk-bar, 0px) + var(--space-4));
}

.compass-desk__notice {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);

	p {
		margin: 0;
	}
}

.compass-desk__notice--row {
	flex-flow: row wrap;
	align-items: center;
	justify-content: space-between;
}

.compass-desk__notice-title {
	font-weight: var(--weight-semibold);
}

.compass-desk__notice-detail {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.compass-desk__notice-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

@media (pointer: coarse) {
	.compass-desk__notice :deep(.button) {
		min-block-size: var(--target-min);
	}
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

.compass-desk__sheet {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
	padding: clamp(1.25rem, 4vw, 2.75rem) clamp(1rem, 4.5vw, 3.25rem) clamp(1.5rem, 4vw, 3rem);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background: var(--compass-paper);

	// Paused until the writer decides about an older draft (see the banner above).
	&[inert] {
		opacity: .6;
	}

	@media print {
		padding: 0;
		border: 0;
	}
}

.compass-desk__eyebrow {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	margin: 0 0 var(--space-3);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-desk__eyebrow-dot {
	color: var(--compass-ink-faint);
}

.compass-desk__eyebrow-category {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-desk__field {
	min-inline-size: 0;
}

.compass-desk__title,
.compass-desk__subtitle,
.compass-desk__quote {
	display: block;
	inline-size: 100%;
	margin: 0;
	padding: 0;
	border: 0;
	border-radius: 0;
	background: transparent;
	box-shadow: none;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	resize: none;

	&::placeholder {
		color: var(--compass-ink-faint);
		opacity: 1;
	}
}

// Borderless headings with a rule that appears on hover and turns to the accent while typing.
.compass-desk__title,
.compass-desk__subtitle {
	padding-block-end: var(--space-1);
	border-block-end: 2px solid transparent;
	transition: border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-block-end-color: var(--compass-rule-strong);
	}

	&:focus {
		border-block-end-color: var(--compass-accent);
	}

	&[aria-invalid='true'] {
		border-block-end-color: var(--danger);
	}
}

.compass-desk__title {
	overflow: hidden;
	font-size: 2rem;
	font-weight: var(--weight-semibold);
	line-height: 1.3;
	letter-spacing: .005em;

	@media screen and (width <= 640px) {
		font-size: 1.6rem;
	}
}

.compass-desk__subtitle {
	margin-block-start: var(--space-2);
	color: var(--compass-ink-soft);
	font-size: 1.15rem;
	line-height: 1.5;
}

// Touch layouts force fields to 16px against iOS zoom (theme.scss); these are larger anyway.
@media (pointer: coarse) {
	.compass-desk__title {
		font-size: 1.6rem !important;
	}

	.compass-desk__subtitle,
	.compass-desk__quote {
		font-size: 1.1rem !important;
	}
}

.compass-desk__epigraph {
	margin-block-start: var(--space-5);
	padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
	border-inline-start: 2px solid var(--compass-accent);
	border-start-end-radius: var(--radius-sm);
	border-end-end-radius: var(--radius-sm);
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:focus-within {
		border-inline-start-color: var(--focus-ring-color);
		background: var(--compass-accent-tint);
	}
}

.compass-desk__epigraph-label {
	display: block;
	margin-block-end: var(--space-1);
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .06em;
	text-transform: uppercase;
}

.compass-desk__quote {
	overflow: hidden;
	color: var(--compass-ink-soft);
	font-size: 1.1rem;
	line-height: 1.7;
}

.compass-desk__ornament {
	--compass-glyph-size: .8rem;

	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-block: var(--space-6) var(--space-4);
	color: var(--compass-accent);

	&::before,
	&::after {
		flex: 1;
		block-size: 1px;
		background: var(--compass-rule);
		content: '';
	}

	@media print {
		display: none;
	}
}

.compass-desk__body {
	min-inline-size: 0;

	:deep(.tiptap__wrapper.tiptap__wrapper-is-editing) {
		border-color: var(--compass-rule-strong);
		background: transparent;
	}

	:deep(.tiptap__wrapper.tiptap__wrapper-is-editing:focus-within) {
		border-color: var(--focus-ring-color);
	}

	// Long pieces keep their formatting tools in reach, right under the desk's bar.
	:deep(.editor-toolbar) {
		position: sticky;
		inset-block-start: var(--compass-desk-offset);
		z-index: 2;
		border-start-start-radius: var(--radius-md);
		border-start-end-radius: var(--radius-md);
		background: var(--compass-paper);
	}

	// Written in the face it will be read in.
	:deep(.ProseMirror) {
		min-block-size: 18rem;
		color: var(--compass-ink);
		font-family: var(--compass-serif);
		font-size: 1.125rem;
		line-height: 1.85;
		overflow-wrap: break-word;
	}

	:deep(.tiptap__editor-is-edit-enabled .ProseMirror) {
		padding: var(--space-4) clamp(var(--space-3), 3vw, var(--space-5));
	}

	:deep(.ProseMirror :where(h1, h2, h3, h4, h5, h6)) {
		font-family: var(--compass-serif);
		line-height: 1.35;
	}

	:deep(.ProseMirror blockquote) {
		border-inline-start-color: var(--compass-accent);
	}
}

.compass-desk__media {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	margin-block-start: var(--space-2);

	@media print {
		display: none;
	}
}

.compass-desk__media-count {
	margin-inline-start: auto;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	&.is-full {
		color: var(--danger-text);
		font-weight: var(--weight-medium);
	}
}

.compass-desk__media-notice {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-2) 0 0;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--compass-rule);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);

	&.is-warning {
		border-inline-start-color: var(--warning);
		background: var(--tint-warning);
	}

	> span {
		flex: 1 1 14rem;
		min-inline-size: 0;
		overflow-wrap: anywhere;
	}

	@media print {
		display: none;
	}
}

.compass-desk__media-link {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--compass-accent);
	font: inherit;
	font-weight: var(--weight-medium);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

// The editor draws images from the space, at their own size and never wider than the sheet.
.compass-desk__body :deep(.compass-editor-image) {
	position: relative;
	margin: 1.2em 0;
	border-radius: var(--radius-md);
	cursor: grab;

	img {
		display: block;
		max-inline-size: 100%;
		block-size: auto;
		margin-inline: auto;
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
	}

	&[data-state='loading'] img:not([width]),
	&[data-state='failed'] img {
		display: none;
	}

	&.is-selected img,
	&.is-selected .compass-editor-image__note {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
	}
}

.compass-desk__body :deep(.compass-editor-image__note) {
	display: flex;
	align-items: center;
	justify-content: center;
	min-block-size: 6rem;
	padding: var(--space-4);
	border: 1px dashed var(--compass-rule-strong);
	border-radius: var(--radius-md);
	color: var(--compass-ink-faint);
	font-family: var(--compass-sans);
	font-size: var(--text-sm);
	text-align: center;

	&[hidden] {
		display: none;
	}
}

.compass-desk__body :deep(.compass-editor-image__caption) {
	margin-block-start: .5em;
	color: var(--compass-ink-soft);
	font-family: var(--compass-sans);
	font-size: .85em;
	line-height: 1.55;
	text-align: center;

	&[hidden] {
		display: none;
	}
}

.compass-desk__size {
	margin: var(--space-2) 0 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	&.is-problem {
		color: var(--danger-text);
		font-weight: var(--weight-medium);
	}
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

.compass-desk__aside {
	min-inline-size: 0;

	&[inert] {
		opacity: .6;
	}

	@media print {
		display: none;
	}
}

.compass-desk__aside-inner {
	display: flex;
	flex-direction: column;
	gap: var(--space-6);
}

.compass-desk__aside.is-collapsible {
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background: var(--compass-paper);

	.compass-desk__aside-inner {
		padding: var(--space-2) var(--space-4) var(--space-5);
	}
}

.compass-desk__summary {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-block-size: max(var(--control-height-lg), var(--target-min));
	padding: var(--space-2) var(--space-4);
	border-radius: var(--radius-lg);
	cursor: pointer;
	list-style: none;

	&::-webkit-details-marker {
		display: none;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-desk__summary-title {
	flex: none;
	color: var(--compass-ink);
	font-weight: var(--weight-semibold);
}

.compass-desk__summary-meta {
	flex: 1;
	min-inline-size: 0;
	overflow: hidden;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.compass-desk__summary-icon {
	flex: none;
	color: var(--compass-ink-faint);
	transition: transform var(--motion-fast) var(--ease-standard);

	.compass-desk__aside[open] > .compass-desk__summary & {
		transform: rotate(180deg);
	}
}

.compass-desk__control {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
}

.compass-desk__label {
	margin-block-end: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-desk__pin {
	display: flex;
	align-items: flex-start;
	gap: var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-md);
	background: var(--compass-paper);
	cursor: pointer;

	input {
		flex: none;
		inline-size: 1.125rem;
		block-size: 1.125rem;
		margin: .15rem 0 0;
		accent-color: var(--compass-accent);
	}

	&:has(input:checked) {
		border-color: var(--compass-accent);
		background: var(--compass-accent-tint);
	}
}

.compass-desk__pin-text {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--compass-ink);
	font-weight: var(--weight-medium);
}

.compass-desk__hint {
	margin: var(--space-2) 0 0;
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	line-height: 1.5;
}

.compass-desk__shortcut {
	margin: 0;
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--compass-rule);
}

// ---------------------------------------------------------------------------
// Discard dialog
// ---------------------------------------------------------------------------

.compass-desk__dialog {
	max-inline-size: 30rem;
	margin-block-end: 0;
}

.compass-desk__dialog-text {
	margin: 0;
	padding: var(--space-4);
}
</style>
