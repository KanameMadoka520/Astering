<template>
	<div
		class="compass-actions d-print-none"
		role="group"
		:aria-label="t('compass.actions.label')"
	>
		<BaseButton
			v-if="canEdit"
			class="compass-tool"
			:to="{name: 'compass.entry.edit', params: {entryId: entry.id}}"
		>
			<Icon
				icon="pen"
				aria-hidden="true"
			/>
			<span class="compass-tool__label">{{ t('compass.actions.edit') }}</span>
		</BaseButton>

		<BaseButton
			v-if="canPin"
			class="compass-tool"
			:class="{'is-pressed': entry.pinned}"
			:aria-pressed="entry.pinned"
			:aria-disabled="busy !== null"
			:title="entry.pinned ? t('compass.actions.unpinHint') : t('compass.actions.pinHint')"
			@click="togglePin"
		>
			<Icon
				icon="thumbtack"
				aria-hidden="true"
			/>
			<span class="compass-tool__label">{{ t('compass.actions.pin') }}</span>
		</BaseButton>

		<BaseButton
			class="compass-tool"
			:to="{name: 'compass.entry.history', params: {entryId: entry.id}}"
		>
			<Icon
				icon="history"
				aria-hidden="true"
			/>
			<span class="compass-tool__label">{{ t('compass.actions.history') }}</span>
		</BaseButton>

		<Dropdown>
			<template #trigger="{toggleOpen, open}">
				<BaseButton
					ref="exportTrigger"
					class="compass-tool"
					:aria-expanded="open"
					:aria-busy="exporting !== null || undefined"
					@click="toggleOpen"
				>
					<Icon
						icon="download"
						aria-hidden="true"
					/>
					<span class="compass-tool__label">{{ t('compass.actions.export') }}</span>
				</BaseButton>
			</template>
			<template #default="{close}">
				<template v-if="imageIds.length > 0">
					<DropdownItem
						icon="download"
						:aria-disabled="exporting !== null"
						@click="downloadBundle(close)"
					>
						{{ t('compass.actions.downloadWithImages') }}
					</DropdownItem>
					<DropdownItem
						icon="download"
						@click="downloadMarkdown(close)"
					>
						{{ t('compass.actions.downloadMarkdownOnly') }}
					</DropdownItem>
				</template>
				<DropdownItem
					v-else
					icon="download"
					@click="downloadMarkdown(close)"
				>
					{{ t('compass.actions.downloadMarkdown') }}
				</DropdownItem>
				<DropdownItem
					icon="print"
					@click="printEntry(close)"
				>
					{{ t('compass.actions.print') }}
				</DropdownItem>
			</template>
		</Dropdown>
		<span
			v-if="exporting"
			class="compass-actions__status"
		>
			<span role="status">{{ exportLabel }}</span>
			<button
				type="button"
				class="compass-actions__link"
				@click="cancelExport"
			>
				{{ t('misc.cancel') }}
			</button>
		</span>
		<span
			v-if="printing !== 'idle'"
			class="compass-actions__status"
		>
			<span role="status">{{ printLabel }}</span>
			<template v-if="printing === 'pending'">
				<button
					type="button"
					class="compass-actions__link"
					@click="preparePrint"
				>
					{{ t('compass.actions.printRetry') }}
				</button>
				<button
					type="button"
					class="compass-actions__link"
					@click="printing = 'idle'"
				>
					{{ t('misc.cancel') }}
				</button>
			</template>
		</span>

		<CompassReadingSettings
			:prefs="prefs"
			@update="change => emit('updatePrefs', change)"
		/>

		<Dropdown v-if="canWrite">
			<template #trigger="{toggleOpen, open}">
				<BaseButton
					ref="moreTrigger"
					class="compass-tool compass-tool--icon"
					:aria-expanded="open"
					@click="toggleOpen"
				>
					<Icon
						icon="ellipsis-h"
						aria-hidden="true"
					/>
					<span class="is-sr-only">{{ t('compass.actions.more') }}</span>
				</BaseButton>
			</template>
			<template #default="{close}">
				<DropdownItem
					v-if="entry.state === 'active'"
					icon="archive"
					:aria-disabled="busy !== null"
					@click="fromMenu(close, () => setState('archived'))"
				>
					{{ t('compass.actions.archive') }}
				</DropdownItem>
				<DropdownItem
					v-else-if="entry.state === 'archived'"
					icon="book-open"
					:aria-disabled="busy !== null"
					@click="fromMenu(close, () => setState('active'))"
				>
					{{ t('compass.actions.unarchive') }}
				</DropdownItem>
				<DropdownItem
					v-if="entry.state !== 'trashed'"
					icon="trash-alt"
					:aria-disabled="busy !== null"
					@click="fromMenu(close, requestTrash)"
				>
					{{ t('compass.actions.trash') }}
				</DropdownItem>
				<template v-else>
					<DropdownItem
						icon="undo"
						:aria-disabled="busy !== null"
						@click="fromMenu(close, () => setState('active'))"
					>
						{{ t('compass.actions.restore') }}
					</DropdownItem>
					<DropdownItem
						v-if="canAdmin"
						icon="trash-alt"
						class="has-text-danger"
						:aria-disabled="busy !== null"
						@click="fromMenu(close, requestDelete)"
					>
						{{ t('compass.actions.deletePermanently') }}
					</DropdownItem>
				</template>
			</template>
		</Dropdown>

		<Modal
			:enabled="trashConfirmOpen"
			:loading="busy === 'trash'"
			@close="cancelTrash"
			@submit="confirmTrash"
		>
			<template #header>
				<span>{{ t('compass.actions.trashConfirmTitle') }}</span>
			</template>
			<template #text>
				<p class="compass-actions__entry-title">
					{{ entry.title }}
				</p>
				<p>
					{{ entry.pinned ? t('compass.actions.trashConfirmPinned') : t('compass.actions.trashConfirmText') }}
				</p>
			</template>
		</Modal>

		<CompassPermanentDeleteDialog
			:enabled="deleteDialogOpen"
			:entry-title="entry.title"
			:loading="busy === 'delete'"
			@close="closeDelete"
			@confirm="confirmDelete"
		/>
	</div>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, useTemplateRef} from 'vue'
import {useI18n} from 'vue-i18n'
import BaseButton from '@/components/base/BaseButton.vue'
import CompassPermanentDeleteDialog from '@/components/compass/base/CompassPermanentDeleteDialog.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'
import Icon from '@/components/misc/Icon'
import Modal from '@/components/misc/Modal.vue'
import type {CompassEntry} from '@/client/queries/compass'
import {buildCompassBundle} from '@/helpers/compass/exportBundle'
import {
	compassEntryToMarkdown,
	compassExportBaseName,
	compassMarkdownFilename,
	downloadCompassFile,
	downloadCompassMarkdown,
} from '@/helpers/compass/exportMarkdown'
import {compassImageIds} from '@/helpers/compass/images'
import {pendingCompassImages, waitForCompassImages} from '@/helpers/compass/imageUrls'
import {isRequestContextAbort} from '@/client/requestContext'
import {ZipTooLargeError} from '@/helpers/zipStore'
import {error, success} from '@/message'
import type {CompassReadingPrefs} from '@/helpers/compass/storage'
import CompassReadingSettings from './CompassReadingSettings.vue'
import {useCompassEntryCommands} from './useCompassEntryCommands'

const props = defineProps<{
	entry: CompassEntry
	prefs: CompassReadingPrefs
}>()

const emit = defineEmits<{
	updatePrefs: [change: Partial<CompassReadingPrefs>]
}>()

const {t} = useI18n({useScope: 'global'})

const {
	busy,
	canWrite,
	canAdmin,
	trashConfirmOpen,
	deleteDialogOpen,
	setPinned,
	setState,
	requestTrash,
	cancelTrash,
	confirmTrash,
	requestDelete,
	closeDelete,
	confirmDelete,
} = useCompassEntryCommands()

const moreTrigger = useTemplateRef<InstanceType<typeof BaseButton>>('moreTrigger')
const exportTrigger = useTemplateRef<InstanceType<typeof BaseButton>>('exportTrigger')

const canEdit = computed(() => canWrite.value && props.entry.state !== 'trashed')
const canPin = computed(() => canWrite.value && props.entry.state === 'active')

function togglePin() {
	if (busy.value !== null) return
	setPinned(!props.entry.pinned)
}

// Focus goes back to the menu button first, so a dialog opened from the menu returns it there
// and a finished write leaves it on a control that still exists.
function fromMenu(close: () => void, action: () => unknown) {
	close()
	moreTrigger.value?.focus()
	if (busy.value !== null) return
	action()
}

const imageIds = computed(() => compassImageIds(props.entry.content))
const exporting = ref<{done: number, total: number} | null>(null)
let exportController: AbortController | null = null

const exportLabel = computed(() => exporting.value
	? t('compass.actions.exportingImages', {done: exporting.value.done, total: exporting.value.total})
	: '')

// The hidden menu would take focus with it; it goes back to the menu button.
function downloadMarkdown(close: () => void) {
	close()
	exportTrigger.value?.focus()
	// Without the files, pictures keep their references and the file says so at the top.
	const note = imageIds.value.length > 0 ? t('compass.export.referencesNote') : undefined
	downloadCompassMarkdown(compassEntryToMarkdown(props.entry, undefined, note), compassMarkdownFilename(props.entry.title))
}

/** The entry's Markdown and its pictures as one ZIP. */
async function downloadBundle(close: () => void) {
	close()
	exportTrigger.value?.focus()
	if (exporting.value !== null) return
	const entry = props.entry
	const controller = new AbortController()
	exportController = controller
	exporting.value = {done: 0, total: imageIds.value.length}
	try {
		const bundle = await buildCompassBundle({
			spaceId: entry.space_id,
			baseName: compassExportBaseName(entry.title),
			imageIds: compassImageIds(entry.content),
			markdown: images => compassEntryToMarkdown(entry, images),
			missing: image => image.alt
				? t('compass.export.imageMissingNamed', {alt: image.alt})
				: t('compass.export.imageMissing'),
			signal: controller.signal,
			onProgress: (done, total) => {
				if (exportController === controller) exporting.value = {done, total}
			},
		})
		if (controller.signal.aborted) return
		downloadCompassFile(bundle.blob, bundle.filename)
		if (bundle.missing > 0) {
			error(new Error(t('compass.export.imagesMissing', {n: bundle.missing}, bundle.missing)))
		} else {
			success(new Error(t('compass.actions.exported', {file: bundle.filename})))
		}
	} catch (cause) {
		if (controller.signal.aborted || isRequestContextAbort(cause)) return
		error(cause instanceof ZipTooLargeError ? new Error(t('compass.export.tooLarge')) : cause)
	} finally {
		if (exportController === controller) {
			exportController = null
			exporting.value = null
		}
	}
}

function cancelExport() {
	exportController?.abort()
	exportController = null
	exporting.value = null
}

// Printing waits for the pictures; when some are still loading after the wait it says so and lets the
// reader try again, rather than putting empty frames on paper. Failed pictures print as their notice.
const printing = ref<'idle' | 'waiting' | 'pending'>('idle')
const printPending = ref(0)
let unmounted = false

const printLabel = computed(() => printing.value === 'pending'
	? t('compass.actions.printPending', {n: printPending.value}, printPending.value)
	: t('compass.actions.printPreparing'))

async function preparePrint() {
	if (printing.value === 'waiting') return
	// The menu must be gone before the print snapshot is taken.
	await nextTick()
	if (pendingCompassImages(document) > 0) {
		printing.value = 'waiting'
		const ready = await waitForCompassImages(document)
		if (unmounted) return
		if (!ready) {
			printPending.value = pendingCompassImages(document)
			printing.value = 'pending'
			return
		}
	}
	printing.value = 'idle'
	await nextTick()
	window.print()
}

function printEntry(close: () => void) {
	close()
	exportTrigger.value?.focus()
	void preparePrint()
}

onBeforeUnmount(() => {
	unmounted = true
	exportController?.abort()
})
</script>

<style lang="scss" scoped>
.compass-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-1);
	min-inline-size: 0;

	// Shared with CompassReadingSettings' trigger, which renders inside this toolbar.
	:deep(.compass-tool) {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		min-block-size: var(--control-height);
		min-inline-size: var(--control-height);
		padding-inline: var(--space-3);
		border: 1px solid transparent;
		border-radius: $radius;
		color: var(--compass-ink-soft);
		font-size: var(--text-md);
		font-weight: var(--weight-medium);
		line-height: 1.2;
		white-space: nowrap;
		text-decoration: none;
		transition:
			background-color var(--motion-fast) var(--ease-standard),
			border-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);

		svg {
			flex: none;
			inline-size: 1em;
			block-size: 1em;
		}

		&:hover {
			background-color: var(--surface-hover);
			color: var(--compass-ink);
		}

		&:focus-visible {
			@include focus-ring;
		}

		&[aria-expanded='true'] {
			background-color: var(--surface-active);
			color: var(--compass-ink);
		}

		&.is-pressed {
			border-color: var(--compass-accent);
			background-color: var(--compass-accent-tint);
			color: var(--compass-accent);
		}

		&[aria-disabled='true'] {
			cursor: progress;
			opacity: .6;
		}

		@media (pointer: coarse) {
			min-block-size: max(var(--control-height), var(--target-min));
			min-inline-size: max(var(--control-height), var(--target-min));
		}
	}

	:deep(.compass-tool--icon) {
		padding-inline: var(--space-2);
	}

	// Phones keep the icons; the names stay in the accessibility tree.
	@include mobile {
		justify-content: flex-start;

		:deep(.compass-tool) {
			padding-inline: var(--space-2);
		}

		:deep(.compass-tool__label) {
			position: absolute;
			inline-size: 1px;
			block-size: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
}

.compass-actions__status {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.compass-actions__link {
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--compass-accent);
	font: inherit;
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-actions__entry-title {
	margin-block-end: var(--space-2);
	color: var(--text-strong);
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;
}
</style>
