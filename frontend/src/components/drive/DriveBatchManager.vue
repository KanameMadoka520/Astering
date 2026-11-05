<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {DriveEntry} from '@/client/queries/drive'
import {
	useDriveBatchChangeMutation,
	useDriveBatchPreviewMutation,
	DRIVE_BATCH_LIMIT,
	type DriveBatchAction,
	type DriveBatchResult,
	type DriveBatchRow,
} from '@/client/queries/driveBatch'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'
import Modal from '@/components/misc/Modal.vue'
import XButton from '@/components/input/Button.vue'

const props = defineProps<{
	files: DriveEntry[],
	selected: DriveEntry[],
	selecting: boolean,
	ready: boolean,
	trash: boolean,
	busy: boolean,
	scopeKey: string,
}>()
const emit = defineEmits<{
	'update:selected': [files: DriveEntry[]],
	'update:selecting': [selecting: boolean],
	'update:busy': [busy: boolean],
	'update:reviewing': [reviewing: boolean],
	inspect: [file: DriveEntry],
}>()
const {t, locale} = useI18n({useScope: 'global'})
const preview = useDriveBatchPreviewMutation()
const change = useDriveBatchChangeMutation()
const modal = ref(false)
const stage = ref<'scan' | 'review' | 'running' | 'results'>('review')
const operation = ref<DriveBatchAction>('pin')
const rows = ref<DriveBatchRow[]>([])
const results = ref<DriveBatchResult[]>([])
const scanned = ref(0)
const scanError = ref(false)
const confirmed = ref(false)
const category = ref('')
const heading = ref<HTMLElement>()
const actionBar = ref<HTMLElement>()
const active = computed(() => stage.value === 'running')
const selectableFiles = computed(() => props.files.filter(file => !file.purging).slice(0, DRIVE_BATCH_LIMIT))
const allSelected = computed(() => selectableFiles.value.length > 0
	&& selectableFiles.value.every(file => props.selected.some(selected => selected.file_id === file.file_id)))
const eligible = computed(() => rows.value.filter(row => row.allowed))
const completed = computed(() => results.value.filter(result => result.status === 'completed').length)
const resultById = computed(() => new Map(results.value.map(result => [result.id, result])))
const canExecute = computed(() => stage.value === 'review' && eligible.value.length > 0
	&& props.ready && !scanError.value && (operation.value !== 'trash' || confirmed.value)
	&& category.value.trim().length <= 120)
const number = (value: number) => new Intl.NumberFormat(locale.value).format(value)
let generation = 0
let disposed = false
let controller: AbortController | undefined
let reviewOwner: ClientRequestContext | undefined
watch(modal, value => emit('update:reviewing', value), {flush: 'sync'})

function current(run: number, scope: string) {
	return !disposed && generation === run && props.scopeKey === scope
}

function clearState() {
	generation++
	controller?.abort()
	modal.value = false
	stage.value = 'review'
	rows.value = []
	results.value = []
	confirmed.value = false
	reviewOwner = undefined
	scanError.value = false
	emit('update:busy', false)
}
watch(() => props.scopeKey, clearState, {flush: 'sync'})
onBeforeUnmount(() => {
	disposed = true
	generation++
	controller?.abort()
})

function toggleMode() {
	if (active.value || props.busy || (!props.selecting && !props.ready)) return
	emit('update:selected', [])
	emit('update:selecting', !props.selecting)
}

function selectPage() {
	if (!props.ready || props.busy || active.value) return
	emit('update:selected', allSelected.value ? [] : selectableFiles.value.map(file => ({
		...file,
		file: file.file ? {...file.file} : undefined,
	})))
}

async function open(action: DriveBatchAction) {
	if (!props.selected.length || !props.ready || props.busy || active.value) return
	const files = props.selected.map(file => ({...file, file: file.file ? {...file.file} : undefined}))
	const run = ++generation
	const scope = props.scopeKey
	const isActive = () => current(run, scope)
	reviewOwner = captureClientRequestContext()
	controller = new AbortController()
	operation.value = action
	category.value = ''
	rows.value = []
	results.value = []
	confirmed.value = false
	scanError.value = false
	scanned.value = 0
	stage.value = 'scan'
	modal.value = true
	try {
		const data = await preview.mutateAsync({
			files,
			action,
			owner: reviewOwner,
			isActive,
			signal: controller.signal,
			onProgress: count => { if (isActive()) scanned.value = count },
		})
		if (!isActive()) return
		rows.value = data
		stage.value = 'review'
	} catch {
		if (!isActive()) return
		if (!reviewOwner || !isClientRequestContextCurrent(reviewOwner)) {
			clearState()
			emit('update:selected', [])
			emit('update:selecting', false)
			return
		}
		scanError.value = true
		stage.value = 'review'
	}
}

async function execute() {
	if (!canExecute.value || active.value || !props.ready || !reviewOwner) return
	const run = generation
	const scope = props.scopeKey
	const isActive = () => current(run, scope)
	stage.value = 'running'
	emit('update:busy', true)
	try {
		const data = await change.mutateAsync({
			rows: rows.value,
			action: operation.value,
			category: category.value,
			owner: reviewOwner,
			isActive,
			onProgress: progress => { if (isActive()) results.value = progress },
		})
		if (!isActive()) return
		results.value = data
		stage.value = 'results'
		emit('update:selected', [])
	} catch {
		if (!isActive()) return
		if (!isClientRequestContextCurrent(reviewOwner)) {
			clearState()
			emit('update:selected', [])
			emit('update:selecting', false)
			return
		}
		// A rejected orchestration request is not evidence that the underlying writes were rolled back.
		results.value = eligible.value.map(row => resultById.value.get(row.file.file_id) ?? {
			id: row.file.file_id,
			status: 'unknown',
			reason: 'unknown',
		})
		stage.value = 'results'
		emit('update:selected', [])
	} finally {
		if (isActive()) emit('update:busy', false)
	}
}

async function close() {
	if (active.value) return
	clearState()
	await nextTick()
	actionBar.value?.focus({preventScroll: true})
}

async function inspect(row: DriveBatchRow) {
	if (active.value) return
	await close()
	emit('inspect', row.file)
}

function usageLabel(usage: NonNullable<DriveBatchRow['usages']>[number]) {
	if (usage.restricted) return t('drive.restricted')
	const kind = t(`drive.kinds.${usage.kind}`)
	return usage.title?.trim() ? `${kind} · ${usage.title}` : kind
}

function status(row: DriveBatchRow) {
	const result = resultById.value.get(row.file.file_id)
	if (result) return t(`drive.batch.status.${result.status}`)
	if (!row.allowed) return t('drive.batch.status.blocked')
	return t(stage.value === 'running' ? 'drive.batch.status.waiting' : 'drive.batch.status.ready')
}
</script>

<template>
	<div
		ref="actionBar"
		class="drive-batch"
		tabindex="-1"
		:aria-label="t('drive.batch.manage')"
	>
		<div class="drive-batch__selection">
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-pressed="selecting"
				:aria-disabled="busy || (!selecting && !ready) || undefined"
				@click="toggleMode"
			>
				{{ t(selecting ? 'drive.batch.exit' : 'drive.batch.enter') }}
			</XButton>
			<template v-if="selecting">
				<strong role="status">{{ t('drive.batch.selected', {count: number(selected.length)}) }}</strong>
				<XButton
					variant="tertiary"
					:shadow="false"
					:aria-disabled="!ready || busy || !selectableFiles.length || undefined"
					@click="selectPage"
				>
					{{ t(allSelected ? 'drive.batch.clear' : 'drive.batch.selectPage') }}
				</XButton>
			</template>
		</div>
		<template v-if="selecting">
			<p class="drive-batch__hint">
				{{ t('drive.batch.pageHint') }}
			</p>
			<div
				class="drive-batch__actions"
				role="group"
				:aria-label="t('drive.batch.actionsLabel')"
			>
				<XButton
					v-for="action in (trash ? (['restore'] as const) : (['pin', 'unpin', 'category', 'trash'] as const))"
					:key="action"
					variant="secondary"
					:shadow="false"
					:aria-disabled="!selected.length || !ready || busy || undefined"
					@click="open(action)"
				>
					{{ t(`drive.batch.actions.${action}`) }}
				</XButton>
			</div>
			<p
				v-if="trash"
				class="drive-batch__hint"
			>
				{{ t('drive.batch.purgeHint') }}
			</p>
		</template>
		<Modal
			class="drive-batch-dialog"
			:enabled="modal"
			:loading="active"
			:wide="true"
			:aria-label="t('drive.batch.review')"
			@close="close"
			@opened="heading?.focus({preventScroll: true})"
		>
			<div
				class="drive-batch-review"
				:data-stage="stage"
			>
				<header>
					<h2
						ref="heading"
						tabindex="-1"
					>
						{{ t('drive.batch.review') }}
					</h2>
					<p>{{ t(`drive.batch.actions.${operation}`) }}</p>
				</header>
				<p
					v-if="stage === 'scan'"
					role="status"
				>
					{{ t('drive.batch.scanning', {count: number(scanned), total: number(selected.length)}) }}
				</p>
				<p
					v-if="scanError"
					role="alert"
				>
					{{ t('drive.batch.scanFailed') }}
				</p>
				<template v-if="stage === 'review' && !scanError">
					<p>{{ t('drive.batch.reviewCount', {count: number(eligible.length), total: number(rows.length)}) }}</p>
					<label
						v-if="operation === 'category'"
						class="drive-batch-category"
					>
						<span>{{ t('drive.category') }}</span>
						<input
							v-model="category"
							class="input"
							maxlength="120"
							:aria-label="t('drive.category')"
							:placeholder="t('drive.categoryHint')"
						>
						<small>{{ t('drive.batch.categoryHint') }}</small>
					</label>
					<p
						v-if="operation === 'trash'"
						class="drive-batch__hint"
					>
						{{ t('drive.batch.trashHint') }}
					</p>
				</template>
				<template v-if="stage === 'running' || stage === 'results'">
					<p role="status">
						{{ t('drive.batch.progress', {
							count: number(results.length), total: number(eligible.length), completed: number(completed),
						}) }}
					</p>
					<progress
						v-if="stage === 'running'"
						:value="results.length"
						:max="Math.max(1, eligible.length)"
						:aria-label="t('drive.batch.progressLabel')"
					/>
					<p
						v-if="stage === 'results'"
						class="drive-batch__hint"
					>
						{{ t('drive.batch.resultsHint') }}
					</p>
				</template>
				<ul
					v-if="rows.length"
					class="drive-batch-review__files"
				>
					<li
						v-for="row in rows"
						:key="row.file.file_id"
						:data-file-id="row.file.file_id"
					>
						<div class="drive-batch-review__row">
							<strong>{{ row.file.file?.name }}</strong>
							<span>{{ status(row) }}</span>
						</div>
						<p
							v-if="resultById.get(row.file.file_id)?.reason || row.reason"
							class="drive-batch__hint"
						>
							{{ t(`drive.batch.reasons.${resultById.get(row.file.file_id)?.reason || row.reason}`) }}
						</p>
						<details v-if="row.usages.length">
							<summary>{{ t('drive.usedIn') }} · {{ number(row.usages.length) }}</summary>
							<ul>
								<li
									v-for="(usage, index) in row.usages"
									:key="index"
								>
									{{ usageLabel(usage) }}
								</li>
							</ul>
						</details>
						<XButton
							v-if="row.reason || resultById.get(row.file.file_id)?.reason"
							variant="tertiary"
							:shadow="false"
							:aria-disabled="active || undefined"
							@click="inspect(row)"
						>
							{{ t('drive.details') }}
						</XButton>
					</li>
				</ul>
				<label
					v-if="stage === 'review' && operation === 'trash' && eligible.length"
					class="drive-batch-confirm"
				>
					<input
						v-model="confirmed"
						type="checkbox"
					>
					<span>{{ t('drive.batch.confirmTrash', {count: number(eligible.length)}, eligible.length) }}</span>
				</label>
				<footer>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="active || undefined"
						@click="close"
					>
						{{ t(stage === 'results' ? 'misc.close' : 'misc.cancel') }}
					</XButton>
					<XButton
						v-if="stage === 'review' && !scanError"
						:shadow="false"
						:danger="operation === 'trash'"
						:aria-disabled="!canExecute || undefined"
						@click="execute"
					>
						{{ t('drive.batch.apply') }}
					</XButton>
				</footer>
			</div>
		</Modal>
	</div>
</template>

<style scoped lang="scss">
.drive-batch {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
	padding-block: var(--space-2);
}

.drive-batch__selection,
.drive-batch__actions,
.drive-batch-review__row,
.drive-batch-review footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.drive-batch__selection strong,
.drive-batch-review__row span {
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.drive-batch__hint,
.drive-batch-category small {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

.drive-batch-review {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	color: var(--text-primary);
	box-shadow: var(--elevation-3);
	text-align: start;

	h2 {
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
	}

	progress {
		inline-size: 100%;
		block-size: .5rem;
		accent-color: var(--primary);
	}

	footer {
		justify-content: flex-end;
	}
}

.drive-batch-review__files {
	display: grid;
	gap: var(--space-2);
	max-block-size: 45dvh;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	list-style: none;

	> li {
		min-inline-size: 0;
		padding: var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
	}

	strong {
		flex: 1 1 12rem;
		min-inline-size: 0;
		overflow-wrap: anywhere;
	}

	details {
		margin-block: var(--space-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	summary {
		cursor: pointer;
	}

	details ul {
		margin-block-start: var(--space-1);
		padding-inline-start: var(--space-4);
		list-style: disc;
	}
}

.drive-batch-category {
	display: grid;
	gap: var(--space-1);

	.input {
		background: var(--surface-raised);
		color: var(--text-primary);
	}
}

.drive-batch-confirm {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--tint-danger);
	line-height: var(--leading-normal);

	input {
		flex: none;
		margin-block-start: .25rem;
	}
}

@media (pointer: coarse) {
	.drive-batch :deep(.button),
	.drive-batch-review :deep(.button),
	.drive-batch-review summary {
		min-block-size: var(--target-min);
	}
}

@media screen and (max-width: $tablet - 1px) {
	:global(.modal-dialog.drive-batch-dialog .modal-container .modal-content.is-wide) {
		margin: var(--space-4) auto;
	}
}
</style>
