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
				<DropdownItem
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
import {computed, nextTick, useTemplateRef} from 'vue'
import {useI18n} from 'vue-i18n'
import BaseButton from '@/components/base/BaseButton.vue'
import CompassPermanentDeleteDialog from '@/components/compass/base/CompassPermanentDeleteDialog.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'
import Icon from '@/components/misc/Icon'
import Modal from '@/components/misc/Modal.vue'
import type {CompassEntry} from '@/client/queries/compass'
import {
	compassEntryToMarkdown,
	compassMarkdownFilename,
	downloadCompassMarkdown,
} from '@/helpers/compass/exportMarkdown'
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

// The hidden menu would take focus with it; it goes back to the menu button.
function downloadMarkdown(close: () => void) {
	close()
	exportTrigger.value?.focus()
	downloadCompassMarkdown(compassEntryToMarkdown(props.entry), compassMarkdownFilename(props.entry.title))
}

async function printEntry(close: () => void) {
	close()
	exportTrigger.value?.focus()
	// The menu must be gone before the print snapshot is taken.
	await nextTick()
	window.print()
}
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

.compass-actions__entry-title {
	margin-block-end: var(--space-2);
	color: var(--text-strong);
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;
}
</style>
