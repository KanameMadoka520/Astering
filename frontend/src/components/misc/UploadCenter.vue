<script setup lang="ts">
import {computed, watch, ref, nextTick, onBeforeUnmount, onMounted, useId} from 'vue'
import UploadProgressRow from './UploadProgressRow.vue'
import {useI18n} from 'vue-i18n'
import {imagePrompt, uploads, uploadsExpanded, type ImageChoice} from '@/helpers/uploadTransport'
const {t} = useI18n({useScope: 'global'})
const dialog = ref<HTMLDialogElement>()
const mode = ref<'original' | 'webp'>('original')
const quality = ref(.85)
const maxSide = ref(2560)
let restoreFocus: HTMLElement | null = null
let collapseTimer: ReturnType<typeof setTimeout> | undefined
// Rows a caller tracks itself (the chat composer's tray) stay out of this panel, which would cover that tray on phones.
const rows = computed(() => uploads.value.filter(row => !row.scoped))
watch(() => rows.value.map(row => `${row.id}:${row.stage}`).join(','), () => {
	clearTimeout(collapseTimer)
	if (rows.value.some(row => !['done', 'error', 'cancelled'].includes(row.stage))) {
		uploadsExpanded.value = true
	} else if (rows.value.length && !rows.value.some(row => row.stage === 'error')) {
		collapseTimer = setTimeout(() => {uploadsExpanded.value = false}, 2500)
	}
})
onBeforeUnmount(() => clearTimeout(collapseTimer))
const rowsId = useId()
const activeCount = () => rows.value.filter(row => !['done', 'error', 'cancelled'].includes(row.stage)).length
// Open modal dialogs sit in the top layer; the panel follows them so task uploads stay visible.
const portal = ref<string | HTMLElement>('body')
let dialogObserver: MutationObserver | undefined
function syncPortal() {
	const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog.modal-dialog[open]')
	portal.value = dialogs.item(dialogs.length - 1) ?? 'body'
}
onMounted(() => {
	syncPortal()
	dialogObserver = new MutationObserver(syncPortal)
	dialogObserver.observe(document.body, {
		attributes: true,
		attributeFilter: ['open'],
		childList: true,
		subtree: true,
	})
})
onBeforeUnmount(() => dialogObserver?.disconnect())
const inDialog = computed(() => portal.value !== 'body')
// A dialog shows its own result, and its footer actions must stay reachable: once the uploads in it
// are done and the panel has collapsed, it steps aside until the dialog closes. Failures stay.
const visible = computed(() => rows.value.length > 0 && !(inDialog.value && !uploadsExpanded.value
	&& rows.value.every(row => row.stage === 'done' || row.stage === 'cancelled')))
watch(imagePrompt, async prompt => {
	if (prompt) { mode.value = 'original'; restoreFocus = document.activeElement as HTMLElement; await nextTick(); dialog.value?.showModal() }
	else { dialog.value?.close(); restoreFocus?.focus() }
})
function finish(accepted: boolean) {
	imagePrompt.value?.resolve(accepted ? {mode: mode.value, quality: quality.value, maxSide: maxSide.value} satisfies ImageChoice : null)
}
function size(bytes: number) { return (bytes / 1024 / 1024).toFixed(2) + ' MiB' }
</script>

<template>
	<dialog
		ref="dialog"
		class="image-upload-dialog"
		:aria-label="t('flow.imageChoice')"
		@cancel.prevent="finish(false)"
	>
		<h2>{{ t('flow.imageChoice') }}</h2>
		<p>{{ t('flow.imageNote') }}</p>
		<p
			v-if="(imagePrompt?.files.length ?? 0) > 1"
			class="image-batch-note"
		>
			{{ t('flow.imageBatchNote', {count: imagePrompt?.files.length}) }}
		</p>
		<ul>
			<li
				v-for="(file, index) in imagePrompt?.files"
				:key="index"
			>
				{{ file.name }} · {{ size(file.size) }}
			</li>
		</ul>
		<label class="image-choice"><input
			v-model="mode"
			type="radio"
			value="original"
			name="image-format"
		>{{ t('flow.original') }}</label>
		<label class="image-choice"><input
			v-model="mode"
			type="radio"
			value="webp"
			name="image-format"
		>{{ t('flow.webp') }}</label>
		<div
			v-if="mode === 'webp'"
			class="image-options"
		>
			<label>{{ t('flow.quality') }} · {{ Math.round(quality * 100) }}%<input
				v-model.number="quality"
				type="range"
				min="0.6"
				max="1"
				step="0.05"
			></label>
			<label>{{ t('flow.maxSide') }}<select v-model.number="maxSide"><option :value="1280">1280 px</option><option :value="2560">2560 px</option><option :value="4096">4096 px</option><option :value="0">{{ t('flow.keepSize') }}</option></select></label>
			<p>{{ t('flow.animationKept') }}</p>
		</div>
		<footer>
			<XButton
				variant="secondary"
				@click="finish(false)"
			>
				{{ t('misc.cancel') }}
			</XButton><XButton @click="finish(true)">
				{{ t('flow.startUpload') }}
			</XButton>
		</footer>
	</dialog>
	<Teleport :to="portal">
		<aside
			v-if="visible"
			class="upload-center d-print-none"
			:class="{'is-in-dialog': inDialog}"
			:aria-label="t('flow.uploads')"
		>
			<button
				type="button"
				class="upload-center-heading"
				:aria-expanded="uploadsExpanded"
				:aria-controls="uploadsExpanded ? rowsId : undefined"
				@click="uploadsExpanded = !uploadsExpanded"
			>
				<span class="upload-center-title">{{ t('flow.uploads') }}</span>
				<span class="upload-center-count">{{ activeCount() }}</span>
				<Icon
					icon="chevron-down"
					class="upload-center-chevron"
					:class="{'is-expanded': uploadsExpanded}"
					aria-hidden="true"
				/>
			</button>
			<div
				v-if="uploadsExpanded"
				:id="rowsId"
				class="upload-rows"
			>
				<UploadProgressRow
					v-for="row in rows"
					:key="row.id"
					:row="row"
				/>
				<button
					type="button"
					class="clear-uploads"
					@click="uploads = uploads.filter(row => row.scoped || !['done','error','cancelled'].includes(row.stage))"
				>
					{{ t('flow.clearFinished') }}
				</button>
			</div>
		</aside>
	</Teleport>
</template>

<style scoped lang="scss">
.image-upload-dialog {
	inline-size: min(92vw, 32rem);
	max-block-size: 90dvh;
	padding: var(--space-6);
	overflow: auto;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	&::backdrop {
		background: var(--scrim);
	}

	h2 {
		margin-block-end: var(--space-2);
		font-size: var(--text-lg);
	}

	p,
	li {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	ul {
		margin-block: var(--space-2) var(--space-3);
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		margin-block-start: var(--space-5);
	}
}

.image-choice {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-block: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	cursor: pointer;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
	}

	&:has(input:checked) {
		border-color: var(--primary);
		background-color: var(--surface-selected);
	}

}

.image-options label {
	display: grid;
	gap: var(--space-2);
	margin-block: var(--space-3);
	font-size: var(--text-sm);
}

// Bottom-end dock: the panel stacks above the Arona launcher whenever the launcher is on screen.
.upload-center {
	position: fixed;
	inset-inline-end: var(--dock-inset-inline);
	inset-block-end: var(--dock-inset-block);
	z-index: var(--layer-floating);
	inline-size: min(22rem, calc(100vw - 2 * var(--dock-inset-inline)));
	overflow: hidden;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	:root:has(.arona-launcher) & {
		inset-block-end: calc(var(--dock-inset-block) + var(--dock-launcher-size) + var(--space-3));
	}

	// Dialog footers put their actions at the end, and the launcher sits behind the dialog.
	&.is-in-dialog,
	:root:has(.arona-launcher) &.is-in-dialog {
		inset-inline-start: var(--dock-inset-inline);
		inset-inline-end: auto;
		inset-block-end: var(--dock-inset-block);
	}
}

.upload-center-heading {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	inline-size: 100%;
	min-block-size: var(--nav-row-height);
	padding: var(--space-2) var(--space-3);
	border: 0;
	background: var(--surface-sunken);
	color: inherit;
	font: inherit;
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	text-align: start;
	cursor: pointer;

	&:hover {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
	}
}

.upload-center-title {
	flex: 1 1 auto;
	min-inline-size: 0;
}

.upload-center-count {
	min-inline-size: 1.25rem;
	padding-inline: var(--space-1);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	text-align: center;
}

.upload-center-chevron {
	color: var(--text-secondary);
	transition: transform var(--motion-fast) var(--ease-standard);

	&.is-expanded {
		transform: rotate(180deg);
	}
}

.upload-rows {
	max-block-size: 35dvh;
	overflow: auto;
	overscroll-behavior: contain;
	padding: var(--space-1) var(--space-3) var(--space-2);
}

.clear-uploads {
	padding: var(--space-1) 0;
	border: 0;
	background: transparent;
	color: var(--accent-text);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}
}
</style>
