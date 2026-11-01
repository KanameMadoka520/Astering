<template>
	<section
		ref="root"
		class="drive-browser"
		:class="{
			'is-picker': picker,
			'is-drop-target': isOverDropZone,
		}"
		:aria-label="t('drive.title')"
	>
		<PageHeader
			v-if="!picker"
			class="drive-heading"
			:title="t('drive.title')"
			:description="t('drive.subtitle')"
		>
			<template #actions>
				<XButton
					icon="cloud-upload-alt"
					:loading="batchActive"
					:disabled="busy"
					@click="input?.click()"
				>
					{{ t('drive.upload') }}
				</XButton>
			</template>
		</PageHeader>
		<input
			ref="input"
			type="file"
			multiple
			hidden
			:accept="images ? 'image/*' : undefined"
			@change="uploadChosenFiles"
		>
		<div class="drive-top">
			<header
				v-if="picker"
				class="drive-picker-heading"
			>
				<h2>{{ t('drive.choose') }}</h2>
				<p
					class="drive-busy"
					role="status"
				>
					<template v-if="busy">
						{{ t('drive.applying') }}
					</template>
				</p>
				<div class="drive-picker-actions">
					<XButton
						variant="secondary"
						class="is-small"
						icon="cloud-upload-alt"
						:shadow="false"
						:loading="batchActive"
						:disabled="busy"
						@click="input?.click()"
					>
						{{ t('drive.upload') }}
					</XButton>
					<slot name="picker-actions" />
				</div>
			</header>
			<div class="drive-toolbar">
				<div class="drive-search">
					<input
						v-model="search"
						class="input"
						type="search"
						:placeholder="t('drive.search')"
						:aria-label="t('drive.search')"
					>
					<Icon
						icon="search"
						class="drive-search-icon"
					/>
				</div>
				<div class="select drive-category">
					<select
						v-model="category"
						:aria-label="t('drive.category')"
					>
						<option value="">
							{{ t('drive.allCategories') }}
						</option>
						<option
							v-for="c in categories"
							:key="c"
						>
							{{ c }}
						</option>
					</select>
				</div>
				<label
					class="drive-toggle"
					:class="{'is-active': pinned}"
				>
					<input
						v-model="pinned"
						type="checkbox"
						class="drive-toggle-input"
					>
					<Icon :icon="pinned ? 'star' : ['far', 'star']" />
					<span :class="{'is-sr-only': compact}">{{ t('drive.pinnedOnly') }}</span>
				</label>
				<XButton
					v-if="!picker"
					variant="secondary"
					class="drive-trash-toggle"
					:class="{'is-active': trash}"
					:icon="trash ? 'arrow-left' : 'trash-alt'"
					:icon-only="compact"
					:shadow="false"
					@click="trash = !trash"
				>
					{{ trash ? t('drive.backToFiles') : t('drive.trash') }}
				</XButton>
			</div>
			<div class="drive-status">
				<p
					ref="summary"
					class="drive-summary"
					tabindex="-1"
					aria-live="polite"
				>
					<!-- Only real numbers: nothing while loading, after a failed load or while switching to the recycle bin. -->
					<template v-if="query.data.value">
						{{ t('drive.stats', {count: total, size: formatSize(query.data.value.bytes ?? 0)}) }}
					</template>
				</p>
				<div
					class="drive-view-toggle"
					role="group"
					:aria-label="t('drive.layout')"
				>
					<button
						v-for="option in viewOptions"
						:key="option.value"
						v-tooltip="option.label"
						type="button"
						class="drive-view-option"
						:aria-label="option.label"
						:aria-pressed="view === option.value"
						@click="storedView = option.value"
					>
						<Icon :icon="option.icon" />
					</button>
				</div>
			</div>
		</div>
		<div class="drive-body">
			<p
				v-if="trash"
				class="drive-note"
			>
				<Icon
					icon="circle-info"
					class="drive-note-icon"
				/>
				<span>{{ t('drive.trashNote') }}</span>
			</p>
			<div
				v-if="batchTotal"
				class="drive-upload-status"
				role="status"
			>
				<span>{{ batchSummary }}</span>
				<progress
					class="drive-upload-progress"
					:value="batchUploaded + batchFailed.length"
					:max="batchTotal"
					aria-hidden="true"
				/>
				<XButton
					v-if="batchActive"
					variant="tertiary"
					class="is-small"
					:shadow="false"
					@click="uploadController?.abort()"
				>
					{{ t('misc.cancel') }}
				</XButton>
			</div>
			<div
				v-if="!batchActive && batchFailed.length"
				class="drive-upload-failed"
				role="alert"
			>
				<p>{{ t('drive.uploadFailed', {count: batchFailed.length}, batchFailed.length) }}</p>
				<ul>
					<li
						v-for="(failure, index) in batchFailed"
						:key="index"
					>
						<span class="drive-upload-failed-name">{{ failure.file.name }}</span>
						<span
							v-if="failure.reason"
							class="drive-muted"
						> · {{ failure.reason }}</span>
					</li>
				</ul>
				<XButton
					variant="secondary"
					class="is-small"
					:shadow="false"
					:disabled="busy"
					@click="retryFailedUploads"
				>
					{{ t('drive.retryFailed') }}
				</XButton>
			</div>
			<p
				v-if="dropRejected"
				class="drive-note"
				role="status"
			>
				<Icon
					icon="circle-info"
					class="drive-note-icon"
				/>
				<span>{{ t('drive.dropRejected') }}</span>
			</p>
			<LoadError
				v-if="query.isError.value"
				:message="t('drive.loadError')"
				:retry="() => query.refetch()"
			/>
			<div
				v-if="query.isPending.value"
				class="drive-files is-skeleton"
				:class="`is-${view}`"
				role="status"
			>
				<span class="is-sr-only">{{ t('misc.loading') }}</span>
				<div
					v-for="n in 8"
					:key="n"
					class="drive-skeleton"
					aria-hidden="true"
				>
					<span class="drive-skeleton-thumb" />
					<span class="drive-skeleton-line" />
					<span class="drive-skeleton-line is-short" />
				</div>
			</div>
			<EmptyState
				v-else-if="query.data.value && !files.length"
				:icon="trash ? 'trash-alt' : 'folder'"
				:title="hasFilters ? t('drive.noMatches') : trash ? t('drive.emptyTrash') : t('drive.empty')"
			>
				<template
					v-if="hasFilters || !trash"
					#default
				>
					<XButton
						v-if="hasFilters"
						variant="secondary"
						:shadow="false"
						@click="clearFilters"
					>
						{{ t('drive.clearFilters') }}
					</XButton>
					<XButton
						v-else
						variant="secondary"
						icon="cloud-upload-alt"
						:shadow="false"
						:disabled="busy || batchActive"
						@click="input?.click()"
					>
						{{ t('drive.upload') }}
					</XButton>
				</template>
			</EmptyState>
			<div
				v-else-if="files.length"
				class="drive-files"
				:class="[`is-${view}`, {'is-refreshing': query.isPlaceholderData.value || busy}]"
				:aria-busy="query.isFetching.value || busy || undefined"
			>
				<article
					v-for="file in files"
					:key="file.file_id"
					class="drive-card"
				>
					<!-- Mouse shortcut only: the labelled buttons below carry the same action for keyboards and screen readers. -->
					<button
						type="button"
						class="drive-preview"
						tabindex="-1"
						aria-hidden="true"
						@click="picker ? choose(file) : inspect(file)"
					>
						<DriveThumbnail
							:file="file"
							decorative
						/>
					</button>
					<div class="drive-card-body">
						<p class="drive-card-name">
							<template v-if="file.pinned">
								<span class="is-sr-only">{{ t('chatHistory.pinned') }}</span>
								<span
									class="drive-pin"
									aria-hidden="true"
								>{{ '★ ' }}</span>
							</template>{{ file.file?.name }}
						</p>
						<p class="drive-card-meta">
							<span class="drive-meta-size">{{ formatSize(file.file?.size ?? 0) }}</span>
							<span
								v-if="formatDay(cardDate(file))"
								class="drive-meta-date"
							>
								<span
									class="drive-meta-separator"
									aria-hidden="true"
								>·</span>
								<span class="is-sr-only">{{ trash ? t('drive.trashedOn') : t('drive.uploadedOn') }}</span>
								<time :datetime="cardDate(file)">{{ formatDay(cardDate(file)) }}</time>
							</span>
							<span
								v-if="file.category"
								class="drive-card-category"
							>{{ file.category }}</span>
						</p>
					</div>
					<div class="drive-card-actions">
						<XButton
							v-if="picker"
							variant="secondary"
							class="is-small drive-choose"
							:shadow="false"
							:aria-disabled="busy || undefined"
							@click="choose(file)"
						>
							{{ t('drive.choose') }}
						</XButton>
						<template v-else>
							<XButton
								v-tooltip="t('drive.details')"
								variant="tertiary"
								class="is-small"
								icon="circle-info"
								icon-only
								:shadow="false"
								@click="inspect(file)"
							>
								{{ t('drive.details') }}
							</XButton>
							<XButton
								v-tooltip="trashActionLabel(file)"
								variant="tertiary"
								class="is-small"
								:icon="file.purging ? 'redo' : trash ? 'undo' : 'trash-alt'"
								icon-only
								:shadow="false"
								:loading="pendingId === file.file_id"
								:aria-disabled="change.isPending.value || undefined"
								@click="trashAction(file)"
							>
								{{ trashActionLabel(file) }}
							</XButton>
						</template>
					</div>
				</article>
			</div>
			<div
				v-if="total > PAGE_SIZE"
				class="drive-pagination"
			>
				<XButton
					variant="secondary"
					class="is-small"
					:shadow="false"
					:aria-disabled="page <= 1 || undefined"
					@click="goToPage(page - 1)"
				>
					{{ t('drive.previous') }}
				</XButton>
				<span class="drive-page">{{ t('projectTimeline.pageOf', {page, total: pageCount}) }}</span>
				<XButton
					variant="secondary"
					class="is-small"
					:shadow="false"
					:aria-disabled="page >= pageCount || undefined"
					@click="goToPage(page + 1)"
				>
					{{ t('drive.next') }}
				</XButton>
			</div>
		</div>
		<div
			v-if="!picker"
			class="drive-drop-hint"
			aria-hidden="true"
		>
			<Icon icon="cloud-upload-alt" />
			<span>{{ batchActive ? t('drive.dropBusy') : t('task.attachment.drop') }}</span>
		</div>
		<Modal
			class="drive-dialog drive-details-dialog"
			:enabled="selected !== null"
			:wide="true"
			:aria-label="t('drive.details')"
			@close="closeDetails"
		>
			<div
				v-if="selected"
				class="drive-details"
			>
				<header class="drive-details-heading">
					<h2>{{ t('drive.details') }}</h2>
					<XButton
						icon="times"
						variant="tertiary"
						:aria-label="t('misc.closeDialog')"
						:aria-disabled="change.isPending.value || undefined"
						@click="closeDetails"
					/>
				</header>
				<div class="drive-details-body">
					<div class="drive-details-file">
						<div
							v-if="!selected.purging"
							class="drive-detail-preview"
						>
							<DriveThumbnail :file="selected" />
						</div>
						<dl class="drive-detail-meta">
							<div>
								<dt>{{ t('drive.size') }}</dt>
								<dd>{{ formatSize(selected.file?.size ?? 0) }}</dd>
							</div>
							<div v-if="selected.file?.mime">
								<dt>{{ t('drive.type') }}</dt>
								<dd>{{ selected.file.mime }}</dd>
							</div>
							<div v-if="formatDay(selected.file?.created)">
								<dt>{{ t('drive.uploadedOn') }}</dt>
								<dd>
									<time :datetime="selected.file?.created">{{ formatDay(selected.file?.created) }}</time>
								</dd>
							</div>
							<div v-if="formatDay(selected.trashed_at)">
								<dt>{{ t('drive.trashedOn') }}</dt>
								<dd>
									<time :datetime="selected.trashed_at">{{ formatDay(selected.trashed_at) }}</time>
								</dd>
							</div>
						</dl>
						<XButton
							variant="secondary"
							icon="download"
							:shadow="false"
							:loading="downloading"
							:disabled="selected.purging"
							@click="download(selected)"
						>
							{{ t('drive.download') }}
						</XButton>
					</div>
					<div class="drive-details-main">
						<label class="drive-field">
							<span class="drive-field-label">{{ t('drive.name') }}</span>
							<input
								v-model="name"
								class="input"
								maxlength="255"
								:disabled="selectedTrashed"
							>
						</label>
						<label class="drive-field">
							<span class="drive-field-label">{{ t('drive.category') }}</span>
							<input
								v-model="editCategory"
								class="input"
								maxlength="120"
								:disabled="selectedTrashed"
								:placeholder="t('drive.categoryHint')"
								:list="categoryListId"
							>
							<datalist :id="categoryListId">
								<option
									v-for="c in categories"
									:key="c"
									:value="c"
								/>
							</datalist>
						</label>
						<label class="drive-check">
							<input
								v-model="editPinned"
								type="checkbox"
								:disabled="selectedTrashed"
							>
							<span>{{ t('drive.pin') }}</span>
						</label>
						<section class="drive-usages-section">
							<h3>{{ t('drive.usedIn') }}</h3>
							<p
								v-if="usages.isPending.value"
								class="drive-muted"
								role="status"
							>
								{{ t('misc.loading') }}
							</p>
							<LoadError
								v-else-if="usages.isError.value"
								:message="usagesError"
								:retry="() => usages.refetch()"
							/>
							<ul
								v-else-if="usageCount"
								class="drive-usages"
							>
								<li
									v-for="(usage, index) in usages.data.value"
									:key="index"
								>
									<span
										v-if="usage.restricted"
										class="drive-muted"
									>{{ t('drive.restricted') }}</span>
									<RouterLink
										v-else
										:to="usage.url || '/drive'"
										@click="closeDetails"
									>
										{{ usageLabel(usage) }}
									</RouterLink>
								</li>
							</ul>
							<p
								v-else
								class="drive-muted"
							>
								{{ t('drive.unused') }}
							</p>
						</section>
						<p
							v-if="selectedTrashed && usageCount"
							class="drive-note"
						>
							<Icon
								icon="circle-info"
								class="drive-note-icon"
							/>
							<span>{{ t('drive.unlinkFirst') }}</span>
						</p>
						<div
							v-if="action !== 'edit'"
							:id="confirmId"
							class="drive-confirm"
							:class="{'is-danger': action === 'purge'}"
						>
							<p>{{ action === 'purge' ? t('drive.purgeWarning') : t('drive.trashWarning') }}</p>
							<label
								v-if="action === 'purge'"
								class="drive-field"
							>
								<span class="drive-field-label">{{ t('drive.typeName') }}</span>
								<input
									v-model="confirmName"
									class="input"
									autocomplete="off"
									:placeholder="selected.file?.name"
								>
							</label>
							<label
								v-else-if="usageCount"
								class="drive-check"
							>
								<input
									v-model="confirmed"
									type="checkbox"
								>
								<span>{{ t('drive.confirmUsed') }}</span>
							</label>
						</div>
					</div>
				</div>
				<footer class="drive-detail-actions">
					<div
						v-if="action === 'edit'"
						class="drive-detail-actions-start"
					>
						<XButton
							v-if="selectedTrashed"
							danger
							:shadow="false"
							:disabled="!usagesReady || usageCount > 0"
							@click="action = 'purge'"
						>
							{{ t('drive.purge') }}
						</XButton>
						<XButton
							v-else
							variant="secondary"
							danger
							icon="trash-alt"
							:shadow="false"
							@click="action = 'trash'"
						>
							{{ t('drive.moveToTrash') }}
						</XButton>
					</div>
					<div class="drive-detail-actions-end">
						<XButton
							variant="secondary"
							:shadow="false"
							@click="closeDetails"
						>
							{{ t('misc.cancel') }}
						</XButton>
						<XButton
							v-if="action === 'edit' && !selectedTrashed"
							:shadow="false"
							:loading="change.isPending.value"
							:disabled="!name.trim()"
							@click="apply('edit')"
						>
							{{ t('misc.save') }}
						</XButton>
						<XButton
							v-if="action !== 'edit'"
							danger
							:shadow="false"
							:loading="change.isPending.value"
							:disabled="!canConfirm"
							:aria-describedby="confirmId"
							@click="apply(action)"
						>
							{{ action === 'purge' ? t('drive.purge') : t('drive.moveToTrash') }}
						</XButton>
					</div>
				</footer>
			</div>
		</Modal>
		<Modal
			class="drive-dialog drive-leave-dialog"
			:enabled="leaveTarget !== null"
			:aria-label="t('drive.leave.title')"
			@close="stayForUploads"
			@opened="focusLeaveStay"
		>
			<div class="drive-details drive-leave">
				<header class="drive-details-heading">
					<h2>{{ t('drive.leave.title') }}</h2>
				</header>
				<p class="drive-leave-text">
					{{ t('drive.leave.text') }}
				</p>
				<footer class="drive-detail-actions">
					<div class="drive-detail-actions-end">
						<XButton
							variant="secondary"
							:shadow="false"
							data-leave-stay
							@click="stayForUploads"
						>
							{{ t('drive.leave.stay') }}
						</XButton>
						<XButton
							danger
							:shadow="false"
							@click="leaveAndCancelUploads"
						>
							{{ t('drive.leave.leave') }}
						</XButton>
					</div>
				</footer>
			</div>
		</Modal>
	</section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, useId, watch} from 'vue'
import {useQuery, useQueryClient} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {refDebounced, useDropZone, useMediaQuery, useStorage} from '@vueuse/core'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import type {DriveChangeWritable, DriveUsage} from '@/client/generated'
import {
	driveBlobQuery,
	driveQuery,
	driveUsagesQuery,
	useChangeDriveMutation,
	useUploadDriveMutation,
	type DriveEntry,
} from '@/client/queries/drive'
import {runUploadQueue} from '@/helpers/uploadQueue'
import {chooseImageBatch, type ImageBatch} from '@/helpers/uploadTransport'
import {isRequestContextAbort} from '@/client/requestContext'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
import {error, getErrorText} from '@/message'
import Modal from '@/components/misc/Modal.vue'
import EmptyState from '@/components/misc/state/EmptyState.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import DriveThumbnail from './DriveThumbnail.vue'

type DriveView = 'grid' | 'list'
type DetailAction = 'edit' | 'trash' | 'purge'

const props = withDefaults(defineProps<{
	picker?: boolean
	images?: boolean
	busy?: boolean
}>(), {
	picker: false,
	images: false,
	busy: false,
})
const emit = defineEmits<{select: [file: DriveEntry]}>()
const PAGE_SIZE = 60
const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

const {t, locale} = useI18n()
const client = useQueryClient()

const search = ref('')
const category = ref('')
const pinned = ref(false)
const trash = ref(false)
const page = ref(1)
const debouncedSearch = refDebounced(search, 250)
watch([debouncedSearch, category, pinned, trash], () => {
	page.value = 1
})

const query = useQuery(computed(() => driveQuery({
	page: page.value,
	search: debouncedSearch.value,
	category: category.value,
	pinned: pinned.value,
	trash: trash.value,
	images: props.images,
})))
const files = computed(() => query.data.value?.files ?? [])
const categories = computed(() => query.data.value?.categories ?? [])
const total = computed(() => query.data.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
watch(() => query.data.value?.total, value => {
	if (value !== undefined) page.value = Math.min(page.value, Math.max(1, Math.ceil(value / PAGE_SIZE)))
})
const hasFilters = computed(() => Boolean(search.value || category.value || pinned.value))

function clearFilters() {
	search.value = ''
	category.value = ''
	pinned.value = false
	page.value = 1
}

function goToPage(target: number) {
	if (target >= 1 && target <= pageCount.value) page.value = target
}

const storedView = useStorage<DriveView | ''>('tcymc-drive-view', '')
const narrow = useMediaQuery('(max-width: 600px)')
const compact = useMediaQuery('(max-width: 480px)')
const view = computed<DriveView>(() => {
	if (storedView.value === 'grid' || storedView.value === 'list') return storedView.value
	return props.images || !narrow.value ? 'grid' : 'list'
})
const viewOptions = computed<{value: DriveView, label: string, icon: IconProp}[]>(() => [
	{
		value: 'grid',
		label: t('drive.grid'),
		icon: 'th',
	},
	{
		value: 'list',
		label: t('project.list.title'),
		icon: 'list',
	},
])

const numberFormat = computed(() => new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}))
const dayFormat = computed(() => new Intl.DateTimeFormat(locale.value, {dateStyle: 'medium'}))

function formatSize(bytes: number) {
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024
		unit++
	}
	return `${numberFormat.value.format(value)} ${SIZE_UNITS[unit]}`
}

function formatDay(value?: string) {
	const date = value ? new Date(value) : null
	// Go serialises a missing time as year 1, which is not a real upload or recycle date.
	return date && date.getTime() > 0 ? dayFormat.value.format(date) : ''
}

function cardDate(file: DriveEntry) {
	return trash.value ? file.trashed_at : file.file?.created
}

type UploadFailure = {file: File, reason: string}

const batchActive = ref(false)
const batchUploaded = ref(0)
const batchTotal = ref(0)
// Files of the last batch that did not reach Drive, with the reason, so they can be named and sent again.
const batchFailed = ref<UploadFailure[]>([])
const batchCancelled = ref(false)
// A drop while a batch runs is not queued; the page says so instead of silently ignoring it.
const dropRejected = ref(false)
let uploadController: AbortController | undefined
onBeforeUnmount(() => uploadController?.abort())
const upload = useUploadDriveMutation()
const change = useChangeDriveMutation()
const input = ref<HTMLInputElement | null>(null)
const root = ref<HTMLElement | null>(null)
const summary = ref<HTMLElement | null>(null)

const batchSummary = computed(() => batchCancelled.value
	? t('drive.uploadCancelled', {count: batchUploaded.value, total: batchTotal.value})
	: t('drive.uploadCount', {count: batchUploaded.value, total: batchTotal.value}))

// Leaving the page cancels the uploads that have not finished (the queue lives in this page), so ask first.
const {leaveTarget, stay: stayForUploads, discardAndLeave: leaveAndCancelUploads} = useUnsavedLeaveGuard(batchActive)

function focusLeaveStay() {
	document.querySelector<HTMLElement>('.drive-leave [data-leave-stay]')?.focus()
}

type ViewState = {search: string, category: string, pinned: boolean, trash: boolean}

function viewState(): ViewState {
	return {search: search.value, category: category.value, pinned: pinned.value, trash: trash.value}
}

function sameView(before: ViewState) {
	const now = viewState()
	return now.search === before.search && now.category === before.category && now.pinned === before.pinned && now.trash === before.trash
}

/** One upload; a failure is kept for the list below instead of a toast, a cancel still stops the queue. */
async function uploadOne(file: File, signal: AbortSignal, headers: Record<string, string>) {
	try {
		await upload.mutateAsync({file, signal, headers, quiet: true})
		return true
	} catch (cause) {
		if (signal.aborted || isRequestContextAbort(cause)) throw cause
		batchFailed.value = [...batchFailed.value, {file, reason: getErrorText(cause)}]
		return false
	}
}

async function uploadFiles(chosen: File[]) {
	if (batchActive.value || props.busy || !chosen.length) return
	const controller = new AbortController()
	uploadController = controller
	batchActive.value = true
	batchUploaded.value = 0
	batchTotal.value = chosen.length
	batchFailed.value = []
	batchCancelled.value = false
	dropRejected.value = false
	const before = viewState()
	let batch: ImageBatch | null = null
	try {
		// One image-format question for the whole selection. Cancelling it cancels the whole upload, as the
		// question's own Cancel says; nothing is uploaded behind the user's back.
		batch = await chooseImageBatch(chosen, controller.signal)
		const headers = batch?.headers() ?? {}
		if (batch) {
			await runUploadQueue(chosen, controller.signal,
				(file, signal) => uploadOne(file, signal, headers),
				uploaded => {
					if (uploaded) batchUploaded.value++
				},
			)
		}
		batchCancelled.value = batchUploaded.value + batchFailed.value.length < chosen.length
	} finally {
		batch?.release()
		batchActive.value = false
		if (input.value) input.value.value = ''
	}
	// Show the new files once, unless the user moved to other filters or the recycle bin meanwhile.
	if (batchUploaded.value && sameView(before)) {
		clearFilters()
		trash.value = false
	}
}

function retryFailedUploads() {
	void uploadFiles(batchFailed.value.map(failure => failure.file))
}

function uploadChosenFiles() {
	void uploadFiles(Array.from(input.value?.files ?? []))
}

// Only the page accepts drops: inside the picker the task page's own attachment drop zone stays in charge.
// The drop stays accepted during a batch (otherwise the browser would open the file instead of this page);
// the hint and the note say the files were not added.
const {isOverDropZone} = useDropZone(() => props.picker ? null : root.value, {
	checkValidity: items => Array.from(items).some(item => item.kind === 'file'),
	onDrop: dropped => {
		if (!dropped?.length) return
		if (batchActive.value) {
			dropRejected.value = true
			return
		}
		void uploadFiles(dropped)
	},
})

const selected = ref<DriveEntry | null>(null)
const name = ref('')
const editCategory = ref('')
const editPinned = ref(false)
// The values the edit fields were filled with, to tell the user's own changes from a refreshed file.
let seeded = {name: '', category: '', pinned: false}

function isTrashed(file: DriveEntry | null) {
	if (!file) return false
	// Go sends a missing time as year 1.
	return Boolean(file.purging) || (file.trashed_at ? new Date(file.trashed_at).getTime() > 0 : false)
}
// The dialog follows the file it shows, not the list behind it (an upload may switch that list).
const selectedTrashed = computed(() => isTrashed(selected.value))
const action = ref<DetailAction>('edit')
const confirmed = ref(false)
const confirmName = ref('')
const downloading = ref(false)
const pendingId = ref<number | null>(null)
const categoryListId = useId()
const confirmId = useId()
const usages = useQuery(computed(() => ({
	...driveUsagesQuery(selected.value?.file_id ?? 0),
	enabled: selected.value !== null,
	staleTime: 0,
})))
const usageCount = computed(() => usages.data.value?.length ?? 0)
// A draft belongs to a readable conversation that has no title yet. A sent chat reference without a title is
// usually a conversation the server could not read (it stays listed so the file is not released), and rarely one
// whose title was cleared; the label says both.
function usageLabel(usage: DriveUsage) {
	const kind = t(`drive.kinds.${usage.kind}`)
	const title = usage.title?.trim()
		|| (usage.kind === 'chat_draft' ? t('chat.untitled') : usage.kind === 'chat' ? t('drive.unreadableChat') : '')
	return title ? `${kind} · ${title}` : kind
}
const usagesReady = computed(() => !usages.isPending.value && !usages.isError.value)
// A failed scan of encrypted conversations is not a known use: say why the list is missing, the file stays.
const usagesError = computed(() => (usages.error.value as {detail?: string} | null)?.detail === 'drive_chat_unreadable'
	? t('drive.errors.drive_chat_unreadable')
	: t('drive.loadError'))
const canConfirm = computed(() => {
	if (!usagesReady.value) return false
	if (action.value === 'purge') return usageCount.value === 0 && confirmName.value === selected.value?.file?.name
	return usageCount.value === 0 || confirmed.value
})

function fieldsOf(file: DriveEntry) {
	return {name: file.file?.name ?? '', category: file.category, pinned: file.pinned}
}

function inspect(file: DriveEntry, mode: DetailAction = 'edit') {
	selected.value = file
	seeded = fieldsOf(file)
	name.value = seeded.name
	editCategory.value = seeded.category
	editPinned.value = seeded.pinned
	action.value = mode
	confirmed.value = false
	confirmName.value = ''
}

// After a refresh (another window changed the file), fields the user left alone take the new values, so a
// retry does not write the old ones back over the other change; the user's own edits stay.
function reseed(file: DriveEntry) {
	const fresh = fieldsOf(file)
	if (name.value === seeded.name) name.value = fresh.name
	if (editCategory.value === seeded.category) editCategory.value = fresh.category
	if (editPinned.value === seeded.pinned) editPinned.value = fresh.pinned
	seeded = fresh
	selected.value = file
}

// The card that opened the dialog is gone after a trash or purge; once the dialog has closed, keep keyboard
// focus in Drive instead of on <body> or the top of the page.
async function focusSummaryAfterDialog() {
	const deadline = performance.now() + 1000
	while (document.querySelector('dialog.drive-details-dialog') && performance.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 50))
	}
	const active = document.activeElement
	if (!active || !active.isConnected || active === document.body || active.id === 'main-content') summary.value?.focus()
}

function closeDetails() {
	if (!change.isPending.value) selected.value = null
}

function choose(file: DriveEntry) {
	if (!props.busy) emit('select', file)
}

function trashActionLabel(file: DriveEntry) {
	if (file.purging) return t('drive.retryPurge')
	return trash.value ? t('drive.restore') : t('drive.moveToTrash')
}

function trashAction(file: DriveEntry) {
	if (change.isPending.value) return
	if (trash.value && !file.purging) void restore(file)
	else inspect(file, file.purging ? 'purge' : 'trash')
}

async function restore(file: DriveEntry) {
	pendingId.value = file.file_id
	await change.mutateAsync({
		id: file.file_id,
		body: {
			revision: file.revision,
			action: 'restore',
			name: '',
			category: '',
			pinned: false,
			confirm: false,
			confirm_name: '',
		},
	}).catch(() => undefined)
	if (pendingId.value === file.file_id) pendingId.value = null
	// The restored card leaves the recycle bin list; keep keyboard focus inside the page instead of on <body>.
	await nextTick()
	if (!document.activeElement || document.activeElement === document.body) summary.value?.focus()
}

async function apply(mode: DriveChangeWritable['action']) {
	const file = selected.value
	if (!file) return
	const result = await change.mutateAsync({
		id: file.file_id,
		body: {
			revision: file.revision,
			action: mode,
			name: name.value,
			category: editCategory.value,
			pinned: editPinned.value,
			confirm: confirmed.value || mode === 'purge',
			confirm_name: confirmName.value,
		},
	}).catch(() => undefined)
	if (selected.value !== file) return
	if (result) {
		selected.value = null
		if (mode !== 'edit') await focusSummaryAfterDialog()
		return
	}
	const refreshed = files.value.find(f => f.file_id === file.file_id)
	if (refreshed) reseed(refreshed)
	else selected.value = null
	confirmed.value = false
	confirmName.value = ''
}

async function download(file: DriveEntry) {
	downloading.value = true
	try {
		const blob = await client.fetchQuery(driveBlobQuery(file.file_id))
		const url = URL.createObjectURL(blob)
		const link = document.createElement('a')
		link.href = url
		link.download = file.file?.name ?? 'file'
		link.click()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
	} catch (cause) {
		error(cause)
	} finally {
		downloading.value = false
	}
}
</script>

<style scoped lang="scss">
.drive-browser {
	--drive-field-height: max(2.25rem, var(--control-height));

	position: relative;
	inline-size: 100%;
	min-inline-size: 0;
	text-align: start;
}

.drive-top {
	display: grid;
	gap: var(--space-3);
	padding-block-end: var(--space-3);

	@media screen and (min-width: $tablet) {
		.drive-browser:not(.is-picker) & {
			position: sticky;
			inset-block-start: var(--header-height);
			z-index: var(--layer-sticky);
			padding-block-start: var(--space-2);
			background: var(--surface-app);
		}
	}
}

.drive-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);

	.button {
		min-block-size: var(--drive-field-height);
	}
}

.drive-search {
	position: relative;
	flex: 1 1 16rem;
	min-inline-size: 0;

	.input {
		padding-inline-start: calc(var(--space-3) * 2 + 1em);
	}
}

.drive-search-icon {
	position: absolute;
	inset-block-start: 50%;
	inset-inline-start: var(--space-3);
	transform: translateY(-50%);
	color: var(--text-tertiary);
	pointer-events: none;
}

.drive-category {
	flex: 1 1 10rem;
	min-inline-size: 0;
	max-inline-size: 14rem;

	select {
		inline-size: 100%;
	}
}

.drive-toggle {
	position: relative;
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	min-block-size: var(--drive-field-height);
	min-inline-size: var(--drive-field-height);
	padding-inline: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-secondary);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	white-space: nowrap;
	cursor: pointer;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-color: var(--border-strong);
		color: var(--text-primary);
	}

	&.is-active {
		border-color: hsla(var(--primary-hsl), .5);
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&:has(:focus-visible) {
		@include focus-ring;
	}
}

// Visually hidden but still focusable: the chip around it shows the state and the focus ring.
.drive-toggle-input {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	margin: 0;
	opacity: 0;
	pointer-events: none;
}

.drive-toolbar .drive-trash-toggle.is-active {
	border-color: hsla(var(--primary-hsl), .5);
	background-color: var(--surface-selected);
	color: var(--accent-text);
}

.drive-status {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-4);
}

.drive-summary {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.drive-view-toggle {
	display: inline-flex;
	gap: 1px;
	padding: 1px;
	border: 1px solid var(--border-default);
	border-radius: $radius;
	background: var(--surface);
}

.drive-view-option {
	display: inline-grid;
	place-items: center;
	inline-size: var(--control-height-sm);
	block-size: var(--control-height-sm);
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	cursor: pointer;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&[aria-pressed='true'] {
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.drive-body {
	display: grid;
	gap: var(--space-3);
}

.drive-note,
.drive-upload-status {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding: var(--space-2) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--primary);
	border-radius: var(--radius-md);
	background: var(--tint-info);
	color: var(--text-primary);
	font-size: var(--text-md);
}

.drive-note {
	flex-wrap: nowrap;
	align-items: baseline;
}

.drive-upload-failed {
	display: grid;
	justify-items: start;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-4) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-md);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-md);

	p,
	ul {
		margin: 0;
	}

	ul {
		display: grid;
		gap: var(--space-1);
		padding-inline-start: var(--space-4);
		list-style: disc;
	}
}

.drive-upload-failed-name {
	font-weight: var(--weight-medium);
	overflow-wrap: anywhere;
}

.drive-note-icon {
	flex: none;
	color: var(--accent-text);
}

.drive-upload-progress {
	flex: 1 1 8rem;
	block-size: .375rem;
	min-inline-size: 6rem;
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
		background: var(--primary);
	}

	&::-moz-progress-bar {
		background: var(--primary);
	}
}

.drive-files {
	container-type: inline-size;
	transition: opacity var(--motion-fast) var(--ease-standard);

	&.is-refreshing {
		opacity: .6;
	}

	&.is-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 8.75rem), 1fr));
		gap: var(--space-2);

		@media screen and (min-width: $tablet) {
			grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
			gap: var(--space-3);
		}
	}

	&.is-list {
		display: flex;
		flex-direction: column;
		padding: var(--space-1);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--elevation-1);
	}
}

.drive-card {
	min-inline-size: 0;
	transition: border-color var(--motion-fast) var(--ease-standard);
}

.drive-preview {
	display: grid;
	place-items: center;
	padding: 0;
	overflow: hidden;
	border: 0;
	background: var(--surface-sunken);
	cursor: pointer;
}

.drive-card-body {
	min-inline-size: 0;
}

.drive-card-name {
	display: -webkit-box;
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.drive-pin {
	color: var(--accent-text);
}

.drive-card-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	margin-block-start: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.drive-meta-separator {
	margin-inline-end: var(--space-2);
}

.drive-card-category {
	max-inline-size: 100%;
	overflow: hidden;
	padding-inline: var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-active);
	color: var(--text-secondary);
	font-size: var(--text-2xs);
	font-weight: var(--weight-medium);
	line-height: var(--leading-normal);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.drive-card-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-1);
}

.is-grid {
	.drive-card {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface);
		box-shadow: var(--elevation-1);

		&:hover {
			border-color: var(--border-strong);
		}

		&:has(:focus-visible) {
			border-color: var(--focus-ring-color);
		}
	}

	.drive-preview {
		--thumb-icon-size: var(--text-2xl);

		inline-size: 100%;
		aspect-ratio: 4 / 3;
		border-start-start-radius: calc(var(--radius-md) - 1px);
		border-start-end-radius: calc(var(--radius-md) - 1px);
	}

	.drive-card-body {
		flex: 1;
		padding: var(--space-2) var(--space-3) 0;
	}

	.drive-card-actions {
		padding: var(--space-1) var(--space-2) var(--space-2);
	}

	.drive-choose {
		flex: 1;
	}
}

.is-list {
	.drive-card {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		min-block-size: 3rem;
		padding-block: var(--space-1);
		padding-inline: var(--space-2) var(--space-1);
		border-radius: $radius;

		&:hover,
		&:has(:focus-visible) {
			background: var(--surface-hover);
		}

		& + .drive-card {
			margin-block-start: 1px;
		}
	}

	.drive-preview {
		--thumb-icon-size: var(--text-md);

		inline-size: 2.25rem;
		block-size: 2.25rem;
		border-radius: var(--radius-sm);
	}

	.drive-card-meta {
		margin-block-start: 0;
	}
}

@container (min-width: 36rem) {
	.is-list .drive-card-body {
		display: grid;
		grid-template-areas: 'name category size date';
		grid-template-columns: minmax(0, 1fr) minmax(0, 9rem) 5rem 7.5rem;
		align-items: center;
		gap: var(--space-3);
	}

	.is-list .drive-card-name {
		grid-area: name;
		-webkit-line-clamp: 1;
	}

	.is-list .drive-card-meta {
		display: contents;
		font-size: var(--text-sm);
	}

	.is-list .drive-card-category {
		grid-area: category;
		justify-self: start;
	}

	.is-list .drive-meta-size {
		grid-area: size;
		color: var(--text-tertiary);
		font-size: var(--text-sm);
		text-align: end;
	}

	.is-list .drive-meta-date {
		grid-area: date;
		color: var(--text-tertiary);
		font-size: var(--text-sm);
	}

	.is-list .drive-meta-separator {
		display: none;
	}
}

.drive-skeleton {
	display: grid;
	gap: var(--space-2);
}

.drive-skeleton-thumb,
.drive-skeleton-line {
	display: block;
	border-radius: var(--radius-sm);
	background: var(--surface-active);
}

.drive-skeleton-line {
	block-size: .625rem;
	inline-size: 80%;

	&.is-short {
		inline-size: 45%;
	}
}

.is-grid .drive-skeleton {
	padding-block-end: var(--space-3);
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);

	.drive-skeleton-thumb {
		aspect-ratio: 4 / 3;
		border-radius: 0;
	}

	.drive-skeleton-line {
		margin-inline: var(--space-3);
	}
}

.is-list .drive-skeleton {
	grid-template-columns: 2.25rem minmax(0, 1fr);
	align-items: center;
	min-block-size: 3rem;
	padding-inline: var(--space-2);

	.drive-skeleton-thumb {
		grid-row: span 2;
		block-size: 2.25rem;
	}
}

.drive-pagination {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: center;
	gap: var(--space-3);
	margin-block-start: var(--space-2);
}

.drive-page {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.drive-drop-hint {
	position: absolute;
	inset: 0;
	z-index: var(--layer-dropdown);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	border: 2px dashed var(--accent-text);
	border-radius: var(--radius-lg);
	background-color: color-mix(in srgb, var(--surface) 88%, transparent);
	background-image: linear-gradient(var(--surface-selected), var(--surface-selected));
	color: var(--accent-text);
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
	opacity: 0;
	pointer-events: none;
	transition: opacity var(--motion-fast) var(--ease-standard);

	.is-drop-target & {
		opacity: 1;
	}
}

// Details dialog: an opaque raised panel; the Modal itself only paints the scrim.
.drive-details {
	color: var(--text-primary);
	background: var(--surface-raised);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	box-shadow: var(--elevation-3);
	text-align: start;
	overflow-wrap: anywhere;

	.input {
		background: var(--surface-raised);
		color: var(--text-primary);

		&::placeholder {
			color: var(--text-tertiary);
			opacity: 1;
		}

		&:disabled {
			background: var(--surface-sunken);
			color: var(--text-secondary);
		}
	}
}

.drive-details-heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	padding-block: var(--space-2);
	padding-inline: var(--space-5) var(--space-2);
	border-block-end: 1px solid var(--border-subtle);

	h2 {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}
}

.drive-details-body {
	display: grid;
	gap: var(--space-5);
	padding: var(--space-5);

	@media screen and (min-width: $tablet) {
		grid-template-columns: minmax(12rem, 17rem) minmax(0, 1fr);
	}
}

.drive-details-file {
	display: grid;
	align-content: start;
	gap: var(--space-3);
}

.drive-detail-preview {
	--thumb-icon-size: calc(var(--text-2xl) * 2);

	display: grid;
	aspect-ratio: 4 / 3;
	max-block-size: 12rem;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);

	@media screen and (min-width: $tablet) {
		max-block-size: none;
	}

	:deep(img) {
		object-fit: contain;
	}
}

.drive-detail-meta {
	display: grid;
	gap: var(--space-1);
	margin: 0;
	font-size: var(--text-sm);

	> div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}

	dt {
		flex: none;
		color: var(--text-secondary);
	}

	dd {
		min-inline-size: 0;
		margin: 0;
		text-align: end;
		font-variant-numeric: tabular-nums;
	}
}

.drive-details-main {
	display: grid;
	align-content: start;
	gap: var(--space-4);
	min-inline-size: 0;
}

.drive-field {
	display: grid;
	gap: var(--space-1);
}

.drive-field-label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.drive-check {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	font-size: var(--text-md);
	cursor: pointer;

	input {
		flex: none;
	}
}

.drive-usages-section h3 {
	margin-block-end: var(--space-2);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
}

.drive-usages {
	max-block-size: 12rem;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	list-style: none;

	li {
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
	}

	li + li {
		border-block-start: 1px solid var(--border-subtle);
	}
}

.drive-muted {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.drive-confirm {
	display: grid;
	gap: var(--space-3);
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-md);
	background: var(--tint-warning);
	font-size: var(--text-md);

	&.is-danger {
		border-inline-start-color: var(--danger);
		background: var(--tint-danger);
	}
}

.drive-detail-actions {
	position: sticky;
	inset-block-end: 0;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-3) var(--space-5);
	border-block-start: 1px solid var(--border-subtle);
	border-end-start-radius: calc(var(--radius-lg) - 1px);
	border-end-end-radius: calc(var(--radius-lg) - 1px);
	background: var(--surface-raised);
}

.drive-leave-text {
	margin: 0;
	padding: var(--space-4) var(--space-5);
}

.drive-detail-actions-start,
.drive-detail-actions-end {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.drive-detail-actions-end {
	margin-inline-start: auto;
}

// Picker: the header and toolbar stay pinned inside the dialog's own scroller.
.is-picker {
	.drive-top {
		position: sticky;
		inset-block-start: 0;
		z-index: var(--layer-sticky);
		padding: var(--space-4) var(--space-5) var(--space-3);
		border-block-end: 1px solid var(--border-subtle);
		background: var(--surface-raised);
	}

	.drive-body {
		padding: var(--space-4) var(--space-5) var(--space-5);
	}

	.input,
	.select select,
	.drive-toggle,
	.drive-view-toggle {
		background-color: var(--surface-raised);
		color: var(--text-primary);
	}

	@media screen and (max-width: $tablet - 1px) {
		.drive-top,
		.drive-body {
			padding-inline: var(--space-4);
		}
	}
}

.drive-picker-heading {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);

	h2 {
		flex: 1 1 auto;
		margin: 0;
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}
}

.drive-busy {
	color: var(--accent-text);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);

	// Stays in the accessibility tree while empty so the status is announced when it fills.
	&:empty {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
}

.drive-picker-actions {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

// Wide modals flow on phones; keep an even gutter on both sides of the panels.
@media screen and (max-width: $tablet - 1px) {
	:global(.modal-dialog.drive-dialog .modal-container .modal-content.is-wide) {
		margin: var(--space-4) auto;
	}
}

// Both drive dialogs carry their own close button inside the panel.
:global(.modal-dialog.drive-dialog > .modal-container > .close) {
	display: none;
}
</style>
