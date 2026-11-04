<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {useDebounceFn} from '@vueuse/core'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {
	currentStorageData,
	storageSummaryQuery,
	storageFilesQuery,
	storageConversationsQuery,
	useStoragePreviewMutation,
	useStorageCleanupMutation,
	type CleanupProgress,
	type CleanupResult,
	type ScopedStorage,
	type StorageConversation,
	type StorageFile,
	type StoragePreview,
	type StorageSelection,
} from '@/client/queries/storage'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
	type ClientRequestContext,
} from '@/client/requestContext'
import {useAuthStore} from '@/stores/auth'
import {useTitle} from '@/composables/useTitle'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import XButton from '@/components/input/Button.vue'
import Modal from '@/components/misc/Modal.vue'
import StorageSummary from '@/components/storage/StorageSummary.vue'
import StorageFileDetails from '@/components/storage/StorageFileDetails.vue'

const {t, te, locale} = useI18n({useScope: 'global'})
defineOptions({name: 'PersonalStorage'})
useTitle(() => t('storage.title'))
const auth = useAuthStore()
const scope = computed(() => {
	void auth.session
	return {human: auth.authUser, context: captureClientRequestContext()}
})
const enabled = computed(() => scope.value.human && Boolean(scope.value.context.identity))
const summaryQuery = useQuery(computed(() => ({
	...storageSummaryQuery(scope.value.context),
	enabled: enabled.value,
})))
const tab = ref<'files' | 'conversations'>('files')
const page = ref(1)
const search = ref('')
const queryText = ref('')
const category = ref<'all' | 'images' | 'video' | 'audio' | 'documents' | 'other' | 'previews'>('all')
const fileScope = ref<'all' | 'active' | 'trash'>('all')
const chatScope = ref<'all' | 'active' | 'archived'>('all')
const fileSort = ref<'bytes' | 'preview_bytes' | 'created' | 'name'>('bytes')
const chatSort = ref<'bytes' | 'updated' | 'title'>('bytes')
const order = ref<'asc' | 'desc'>('desc')
const action = ref<'trash' | 'purge' | 'clear_previews'>('trash')
const applySearch = useDebounceFn(() => { queryText.value = search.value.trim() }, 300)
watch(search, applySearch)
const filesQuery = useQuery(computed(() => ({
	...storageFilesQuery({
		page: page.value,
		q: queryText.value,
		category: category.value,
		scope: fileScope.value,
		sort_by: fileSort.value,
		order_by: order.value,
	}, scope.value.context),
	enabled: enabled.value && tab.value === 'files',
})))
const chatsQuery = useQuery(computed(() => ({
	...storageConversationsQuery({
		page: page.value,
		q: queryText.value,
		scope: chatScope.value,
		sort_by: chatSort.value,
		order_by: order.value,
	}, scope.value.context),
	enabled: enabled.value && tab.value === 'conversations',
})))
function forbidden(cause: unknown) {
	const status = (cause as {status?: number} | null)?.status
	return status === 401 || status === 403
}
const summary = computed(() => forbidden(summaryQuery.error.value)
	? undefined : currentStorageData(summaryQuery.data.value))
const files = computed(() => forbidden(filesQuery.error.value)
	? undefined : currentStorageData(filesQuery.data.value))
const chats = computed(() => forbidden(chatsQuery.error.value)
	? undefined : currentStorageData(chatsQuery.data.value))
const activeQuery = computed(() => tab.value === 'files' ? filesQuery : chatsQuery)
const listing = computed(() => tab.value === 'files' ? files.value : chats.value)
const listBusy = computed(() => activeQuery.value.isFetching.value)
const listError = computed(() => activeQuery.value.isError.value)
const segments = computed(() => summary.value?.categories.map(item => ({
	key: item.id,
	bytes: item.bytes,
	count: item.count,
})) ?? [])
const selected = ref(new Map<string, StorageFile | StorageConversation>())
const expanded = ref(new Set<string>())
const heading = ref<HTMLElement>()
const dialogHeading = ref<HTMLElement>()
const progressHeading = ref<HTMLElement>()
const confirmationCheck = ref<HTMLInputElement>()
const preview = useStoragePreviewMutation()
const cleanup = useStorageCleanupMutation()
type CleanupDialog = {
	owner: ClientRequestContext,
	selections: StorageSelection[],
}
const dialog = ref<CleanupDialog | null>(null)
const previewSnapshot = ref<ScopedStorage<StoragePreview>>()
const currentPreview = computed(() => currentStorageData(previewSnapshot.value))
const eligible = computed(() => currentPreview.value?.items.filter(item => item.allowed && item.token) ?? [])
const stage = ref<'review' | 'confirm' | 'results'>('review')
const confirmed = ref(false)
const confirmText = ref('')
const dialogError = ref(false)
const progress = ref<CleanupProgress>({processed: 0, total: 0, results: []})
const results = computed(() => progress.value.results)
const completed = computed(() => results.value.filter(item => ['completed', 'already_done'].includes(item.status)).length)
const failed = computed(() => results.value.filter(item => !['completed', 'already_done'].includes(item.status)))
const freedBytes = computed(() => results.value.reduce((total, item) => total + item.freed_bytes, 0))
const permanent = computed(() => eligible.value.some(item => item.action === 'purge' || item.action === 'delete'))
const busy = computed(() => preview.isPending.value || cleanup.isPending.value)
const selectedBytes = computed(() => [...selected.value.values()].reduce((total, item) => {
	if (item.kind === 'conversation') return total + item.bytes
	return total + (action.value === 'clear_previews' ? item.preview_bytes : item.size)
}, 0))
let focusTimer: ReturnType<typeof setTimeout> | undefined
let previewController: AbortController | undefined

watch([tab, queryText, category, fileScope, chatScope, fileSort, chatSort, order, action], () => {
	page.value = 1
	selected.value = new Map()
	expanded.value = new Set()
})
watch(page, () => { expanded.value = new Set() })
watch(listing, value => {
	if (value?.page === page.value && page.value > Math.max(1, value.total_pages)) {
		page.value = Math.max(1, value.total_pages)
	}
})
watch(() => JSON.stringify(scope.value.context), () => {
	previewController?.abort()
	selected.value = new Map()
	expanded.value = new Set()
	dialog.value = null
	previewSnapshot.value = undefined
	progress.value = {processed: 0, total: 0, results: []}
	search.value = ''
	queryText.value = ''
	page.value = 1
})
onBeforeUnmount(() => {
	clearTimeout(focusTimer)
	previewController?.abort()
})

function number(value: number) { return new Intl.NumberFormat(locale.value).format(value) }
function bytes(value: number) {
	if (!value) return '0 B'
	const index = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
	const amount = new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}).format(value / 1024 ** index)
	return `${amount} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`
}
function date(value: string) {
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? t('storage.unknownDate') : new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(parsed)
}
function itemKey(item: {kind: string, id: string}) { return `${item.kind}:${item.id}` }
function reason(value: string) {
	return te(`storage.reasons.${value}`) ? t(`storage.reasons.${value}`) : t('storage.reasonOther', {code: value || 'unknown'})
}
function selectable(item: StorageFile | StorageConversation) {
	if (item.kind === 'conversation') return !item.running && !item.compacting
	if (action.value === 'clear_previews') return item.preview_bytes > 0
	return action.value === 'purge' ? item.can_purge : item.can_trash
}
function toggle(item: StorageFile | StorageConversation) {
	if (busy.value || !selectable(item)) return
	const next = new Map(selected.value)
	const key = itemKey(item)
	if (next.has(key)) next.delete(key)
	else if (next.size < 50) next.set(key, item)
	selected.value = next
}
function toggleExpanded(id: string) {
	const next = new Set(expanded.value)
	if (next.has(id)) next.delete(id)
	else next.add(id)
	expanded.value = next
}
function suggestion(value: 'trash' | 'previews' | 'large' | 'conversations') {
	if (busy.value) return
	tab.value = value === 'conversations' ? 'conversations' : 'files'
	search.value = ''
	queryText.value = ''
	category.value = value === 'previews' ? 'previews' : 'all'
	fileScope.value = value === 'trash' ? 'trash' : 'all'
	action.value = value === 'previews' ? 'clear_previews' : value === 'trash' ? 'purge' : 'trash'
	fileSort.value = value === 'previews' ? 'preview_bytes' : 'bytes'
	chatSort.value = 'bytes'
	order.value = 'desc'
	void nextTick(() => heading.value?.focus({preventScroll: true}))
}
async function refresh() {
	if (listBusy.value || summaryQuery.isFetching.value || busy.value) return
	await Promise.all([summaryQuery.refetch(), activeQuery.value.refetch()])
}
function changePage(delta: number) {
	if (listBusy.value || !listing.value) return
	const target = page.value + delta
	if (target > 0 && target <= listing.value.total_pages) page.value = target
}
function selections(items: Array<StorageFile | StorageConversation>): StorageSelection[] {
	return items.map(item => ({
		kind: item.kind,
		id: item.id,
		revision: item.revision,
		action: item.kind === 'conversation' ? 'delete' : action.value,
	}))
}
async function requestPreview(target: CleanupDialog) {
	if (busy.value || !isClientRequestContextCurrent(target.owner)) return
	previewSnapshot.value = undefined
	dialogError.value = false
	stage.value = 'review'
	confirmed.value = false
	confirmText.value = ''
	void nextTick(() => { if (dialog.value === target) dialogHeading.value?.focus({preventScroll: true}) })
	const controller = new AbortController()
	previewController = controller
	try {
		const value = await preview.mutateAsync({items: target.selections, owner: target.owner, signal: controller.signal})
		if (dialog.value === target && isClientRequestContextCurrent(target.owner)) previewSnapshot.value = value
	} catch (cause) {
		if (!isRequestContextAbort(cause) && dialog.value === target) dialogError.value = true
	} finally {
		if (previewController === controller) previewController = undefined
	}
}
function review() {
	if (busy.value || !selected.value.size) return
	const target = {owner: scope.value.context, selections: selections([...selected.value.values()])}
	dialog.value = target
	void requestPreview(dialog.value)
}
async function execute() {
	const target = dialog.value
	if (!target || busy.value || !eligible.value.length || !isClientRequestContextCurrent(target.owner)) return
	if (permanent.value && (stage.value !== 'confirm' || !confirmed.value || confirmText.value !== 'DELETE')) return
	const items = [...eligible.value]
	stage.value = 'results'
	progress.value = {processed: 0, total: items.length, results: []}
	dialogError.value = false
	void nextTick(() => { if (dialog.value === target) progressHeading.value?.focus({preventScroll: true}) })
	try {
		await cleanup.mutateAsync({
			items,
			owner: target.owner,
			onProgress: value => {
				if (dialog.value === target && isClientRequestContextCurrent(target.owner)) progress.value = value
			},
		})
		if (dialog.value !== target || !isClientRequestContextCurrent(target.owner)) return
		const next = new Map(selected.value)
		for (const item of results.value) {
			if (['completed', 'already_done'].includes(item.status)) next.delete(itemKey(item))
		}
		selected.value = next
	} catch (cause) {
		if (!isRequestContextAbort(cause) && dialog.value === target) dialogError.value = true
	}
}
function proceed() {
	if (busy.value || !eligible.value.length) return
	if (permanent.value) {
		stage.value = 'confirm'
		void nextTick(() => confirmationCheck.value?.focus({preventScroll: true}))
	}
	else void execute()
}
function backToReview() {
	if (busy.value) return
	stage.value = 'review'
	confirmed.value = false
	confirmText.value = ''
	void nextTick(() => dialogHeading.value?.focus({preventScroll: true}))
}
function reviewFailed() {
	const target = dialog.value
	if (!target || busy.value) return
	const keys = new Set(failed.value.map(itemKey))
	target.selections = target.selections.filter(item => keys.has(itemKey(item)))
	if (target.selections.length) void requestPreview(target)
}
function closeDialog() {
	if (cleanup.isPending.value) return
	previewController?.abort()
	const owner = dialog.value?.owner
	dialog.value = null
	clearTimeout(focusTimer)
	focusTimer = setTimeout(() => {
		if (owner && isClientRequestContextCurrent(owner)
			&& (!document.activeElement || document.activeElement === document.body
				|| document.activeElement.id === 'main-content')) heading.value?.focus()
	}, 180)
}
function resultLabel(item: CleanupResult) { return t(`storage.statuses.${item.status}`) }
</script>

<template>
	<div
		class="storage-page"
		data-cy="storage-page"
	>
		<PageHeader
			:title="t('storage.title')"
			:description="t('storage.intro')"
		>
			<template #actions>
				<XButton
					variant="secondary"
					icon="redo"
					:shadow="false"
					:aria-disabled="listBusy || summaryQuery.isFetching.value || busy"
					@click="refresh"
				>
					{{ t('storage.refresh') }}
				</XButton>
			</template>
		</PageHeader>
		<LoadError
			v-if="summaryQuery.isError.value"
			:message="t('storage.loadFailed')"
			:retry="refresh"
		/>
		<p
			v-else-if="!summary"
			class="storage-loading"
			role="status"
		>
			{{ t('storage.scanning') }}
		</p>
		<StorageSummary
			v-if="summary"
			:total-bytes="summary.total_bytes"
			:complete="summary.complete"
			:as-of="summary.as_of"
			:segments="segments"
			:trash-bytes="summary.trash_bytes"
			:trash-count="summary.trash_count"
			:preview-bytes="summary.preview_bytes"
			:conversation-bytes="summary.conversation_bytes"
			:conversation-count="summary.conversation_count"
			:busy="busy"
			@filter="suggestion"
		/>
		<section
			class="storage-inventory"
			:aria-labelledby="'storage-inventory-heading'"
		>
			<header class="storage-inventory__header">
				<h2
					id="storage-inventory-heading"
					ref="heading"
					tabindex="-1"
				>
					{{ t('storage.inventory') }}
				</h2>
				<div
					class="storage-tabs"
					role="group"
					:aria-label="t('storage.inventoryType')"
				>
					<XButton
						v-for="value in (['files', 'conversations'] as const)"
						:key="value"
						variant="tertiary"
						:shadow="false"
						:aria-pressed="tab === value"
						:aria-disabled="busy"
						@click="!busy && (tab = value)"
					>
						{{ t(`storage.tabs.${value}`) }}
					</XButton>
				</div>
			</header>
			<form
				class="storage-filters"
				@submit.prevent
			>
				<label class="storage-search">
					<span>{{ t('storage.search') }}</span>
					<input
						v-model="search"
						class="input"
						type="search"
						maxlength="250"
						:placeholder="t(tab === 'files' ? 'storage.searchFiles' : 'storage.searchChats')"
						:readonly="busy"
					>
				</label>
				<template v-if="tab === 'files'">
					<label>
						<span>{{ t('storage.fileType') }}</span>
						<select
							v-model="category"
							:aria-label="t('storage.fileType')"
						>
							<option
								v-for="value in ['all', 'images', 'video', 'audio', 'documents', 'other', 'previews']"
								:key="value"
								:value="value"
							>{{ t(`storage.fileTypes.${value}`) }}</option>
						</select>
					</label>
					<label>
						<span>{{ t('storage.location') }}</span>
						<select
							v-model="fileScope"
							:aria-label="t('storage.location')"
						>
							<option
								v-for="value in ['all', 'active', 'trash']"
								:key="value"
								:value="value"
							>{{ t(`storage.fileScopes.${value}`) }}</option>
						</select>
					</label>
					<label>
						<span>{{ t('storage.sort') }}</span>
						<select
							v-model="fileSort"
							:aria-label="t('storage.sort')"
						>
							<option
								v-for="value in ['bytes', 'preview_bytes', 'created', 'name']"
								:key="value"
								:value="value"
							>{{ t(`storage.sorts.${value}`) }}</option>
						</select>
					</label>
				</template>
				<template v-else>
					<label>
						<span>{{ t('storage.location') }}</span>
						<select
							v-model="chatScope"
							:aria-label="t('storage.location')"
						>
							<option
								v-for="value in ['all', 'active', 'archived']"
								:key="value"
								:value="value"
							>{{ t(`storage.scopes.${value}`) }}</option>
						</select>
					</label>
					<label>
						<span>{{ t('storage.sort') }}</span>
						<select
							v-model="chatSort"
							:aria-label="t('storage.sort')"
						>
							<option
								v-for="value in ['bytes', 'updated', 'title']"
								:key="value"
								:value="value"
							>{{ t(`storage.sorts.${value}`) }}</option>
						</select>
					</label>
				</template>
				<label>
					<span>{{ t('storage.order') }}</span>
					<select
						v-model="order"
						:aria-label="t('storage.order')"
					>
						<option value="desc">{{ t('storage.desc') }}</option>
						<option value="asc">{{ t('storage.asc') }}</option>
					</select>
				</label>
			</form>
			<div
				v-if="tab === 'files'"
				class="storage-action-choice"
			>
				<label>
					<span>{{ t('storage.cleanupAction') }}</span>
					<select
						v-model="action"
						:aria-label="t('storage.cleanupAction')"
					>
						<option
							v-for="value in (['trash', 'purge', 'clear_previews'] as const)"
							:key="value"
							:value="value"
						>{{ t(`storage.actions.${value}`) }}</option>
					</select>
				</label>
				<p>{{ t(`storage.actionHints.${action}`) }}</p>
			</div>
			<p
				v-else
				class="storage-inventory__note"
			>
				{{ t('storage.chatDeleteHint') }}
			</p>
			<div
				class="storage-list-status"
				role="status"
				aria-live="polite"
			>
				<span v-if="listBusy">{{ t('storage.loadingItems') }}</span>
				<span v-else-if="listing">{{ t('storage.listCount', {count: number(listing.total)}) }}</span>
				<span>{{ t('storage.selectionHint') }}</span>
			</div>
			<p
				v-if="listing && !listing.complete"
				class="storage-inventory__note"
				role="status"
			>
				{{ t('storage.listIncomplete') }}
			</p>
			<LoadError
				v-if="listError"
				:message="t('storage.listFailed')"
				:retry="() => activeQuery.refetch()"
			/>
			<p
				v-if="listing && !listing.items.length && !listBusy"
				class="storage-empty"
			>
				{{ t('storage.empty') }}
			</p>
			<ul
				v-if="tab === 'files' && files"
				class="storage-items"
				data-cy="storage-files"
				:aria-busy="listBusy"
			>
				<li
					v-for="file in files.items"
					:key="`${JSON.stringify(scope.context)}:${file.id}`"
					class="storage-item"
				>
					<div class="storage-item__row">
						<label
							class="storage-item__select"
							:class="{'is-unavailable': !selectable(file)}"
						>
							<input
								type="checkbox"
								:checked="selected.has(itemKey(file))"
								:aria-label="t('storage.selectItem', {name: file.name})"
								:aria-disabled="busy || !selectable(file) || (selected.size >= 50 && !selected.has(itemKey(file)))"
								@click.prevent="toggle(file)"
							>
						</label>
						<span
							class="storage-item__icon"
							aria-hidden="true"
						>
							<Icon :icon="file.mime.startsWith('image/') ? 'file-image' : file.mime === 'application/pdf' ? 'file-pdf' : 'file'" />
						</span>
						<div class="storage-item__main">
							<strong>{{ file.name }}</strong>
							<span>
								<time :datetime="file.created">{{ date(file.created) }}</time> · {{ file.mime || t('storage.unknownType') }}</span>
							<div class="storage-badges">
								<span v-if="file.trash">{{ t('storage.inTrash') }}</span>
								<span v-if="file.pinned">{{ t('drive.pin') }}</span>
								<span v-if="!file.in_drive">{{ t('storage.protected') }}</span>
								<span v-if="!file.storage_complete">{{ t('storage.incompleteShort') }}</span>
							</div>
						</div>
						<div class="storage-item__size">
							<strong>{{ bytes(file.size) }}</strong>
							<small v-if="file.preview_bytes">{{ t('storage.previewSize', {size: bytes(file.preview_bytes)}) }}</small>
						</div>
						<XButton
							variant="tertiary"
							:shadow="false"
							icon="chevron-down"
							:aria-expanded="expanded.has(file.id)"
							:aria-label="t('storage.inspectItem', {name: file.name})"
							@click="toggleExpanded(file.id)"
						/>
					</div>
					<StorageFileDetails
						v-if="expanded.has(file.id)"
						:file="file"
						:owner="scope.context"
					/>
				</li>
			</ul>
			<ul
				v-if="tab === 'conversations' && chats"
				class="storage-items"
				data-cy="storage-conversations"
				:aria-busy="listBusy"
			>
				<li
					v-for="chat in chats.items"
					:key="chat.id"
					class="storage-item"
				>
					<div class="storage-item__row">
						<label
							class="storage-item__select"
							:class="{'is-unavailable': !selectable(chat)}"
						>
							<input
								type="checkbox"
								:checked="selected.has(itemKey(chat))"
								:aria-label="t('storage.selectItem', {name: chat.title || t('chat.untitled')})"
								:aria-disabled="busy || !selectable(chat) || (selected.size >= 50 && !selected.has(itemKey(chat)))"
								@click.prevent="toggle(chat)"
							>
						</label>
						<span
							class="storage-item__icon"
							aria-hidden="true"
						>
							<Icon :icon="['far', 'comments']" />
						</span>
						<div class="storage-item__main">
							<RouterLink :to="chat.url || {name: 'tcy-ai', query: {chat: chat.id}}">
								{{ chat.title || t('chat.untitled') }}
							</RouterLink>
							<span>
								<time :datetime="chat.updated">{{ date(chat.updated) }}</time> · {{ t('storage.attachmentCount', {count: number(chat.attachment_count)}) }}</span>
							<div class="storage-badges">
								<span
									v-if="chat.running || chat.compacting"
									class="is-working"
								>{{ t(chat.compacting ? 'storage.compacting' : 'storage.running') }}</span>
								<span v-if="chat.archived">{{ t('storage.archived') }}</span>
								<span v-if="chat.pinned">{{ t('storage.pinned') }}</span>
							</div>
						</div>
						<div class="storage-item__size">
							<strong>{{ bytes(chat.bytes) }}</strong>
							<small>{{ t('storage.recordOnly') }}</small>
						</div>
					</div>
				</li>
			</ul>
			<footer
				v-if="listing"
				class="storage-pagination"
			>
				<span>{{ t('storage.page', {page: number(listing.page), total: number(Math.max(1, listing.total_pages))}) }}</span>
				<div>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="listBusy || page <= 1"
						@click="changePage(-1)"
					>
						{{ t('storage.previous') }}
					</XButton>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="listBusy || page >= listing.total_pages"
						@click="changePage(1)"
					>
						{{ t('storage.next') }}
					</XButton>
				</div>
			</footer>
		</section>
		<details class="storage-accounting">
			<summary>{{ t('storage.accounting') }}</summary>
			<p
				v-for="key in ['ownership', 'originals', 'previews', 'ai', 'excluded', 'safety']"
				:key="key"
			>
				{{ t(`storage.accountingNotes.${key}`) }}
			</p>
		</details>
		<div
			v-if="selected.size"
			class="storage-selection"
			role="region"
			:aria-label="t('storage.selection')"
		>
			<div>
				<strong>{{ t('storage.selected', {count: number(selected.size)}) }}</strong>
				<small>{{ t('storage.selectedSize', {size: bytes(selectedBytes)}) }}</small>
			</div>
			<XButton
				variant="tertiary"
				:shadow="false"
				:aria-disabled="busy"
				@click="!busy && (selected = new Map())"
			>
				{{ t('storage.clearSelection') }}
			</XButton>
			<XButton
				:shadow="false"
				:aria-disabled="busy"
				@click="review"
			>
				{{ t('storage.reviewCleanup') }}
			</XButton>
		</div>
		<Modal
			class="storage-cleanup-modal"
			:enabled="dialog !== null"
			:wide="true"
			:loading="cleanup.isPending.value"
			:aria-label="t('storage.reviewCleanup')"
			data-cy="storage-cleanup-dialog"
			@close="closeDialog"
			@opened="dialogHeading?.focus({preventScroll: true})"
		>
			<div class="storage-cleanup">
				<header>
					<h2
						ref="dialogHeading"
						tabindex="-1"
					>
						{{ t(stage === 'results' ? 'storage.cleanupResults' : stage === 'confirm' ? 'storage.finalConfirmation' : 'storage.reviewCleanup') }}
					</h2>
					<p>{{ t('storage.cleanupBoundary') }}</p>
				</header>
				<p
					v-if="preview.isPending.value"
					role="status"
				>
					{{ t('storage.previewing') }}
				</p>
				<LoadError
					v-if="dialogError"
					:message="t('storage.cleanupRequestFailed')"
					:retry="dialog && stage !== 'results' ? () => requestPreview(dialog!) : undefined"
				/>
				<template v-if="stage === 'review' && currentPreview">
					<div class="storage-cleanup__estimate">
						<span>{{ t('storage.estimatedRelease') }}</span>
						<strong>{{ bytes(currentPreview.expected_freed_bytes) }}</strong>
						<small>{{ t('storage.estimateHint') }}</small>
					</div>
					<p>{{ t('storage.reviewCount', {allowed: number(eligible.length), total: number(currentPreview.items.length)}) }}</p>
					<p class="storage-cleanup__warning">
						{{ t('storage.validUntil', {time: date(currentPreview.expires_at)}) }}
					</p>
					<ul class="storage-review-items">
						<li
							v-for="item in currentPreview.items"
							:key="itemKey(item)"
						>
							<div>
								<strong>{{ item.name }}</strong>
								<span>{{ t(`storage.actions.${item.action}`) }} · {{ bytes(item.expected_freed_bytes) }}</span>
							</div>
							<span :class="item.allowed ? 'storage-allowed' : 'storage-blocked'">{{ item.allowed ? t('storage.ready') : reason(item.reason) }}</span>
							<ul v-if="item.usages.length">
								<li
									v-for="(usage, index) in item.usages"
									:key="index"
								>
									<span v-if="usage.restricted || !usage.url">{{ usage.restricted ? t('drive.restricted') : t(`drive.kinds.${usage.kind}`) }}</span>
									<RouterLink
										v-else
										:to="usage.url"
										@click="closeDialog"
									>
										{{ t(`drive.kinds.${usage.kind}`) }}<span v-if="usage.title"> · {{ usage.title }}</span>
									</RouterLink>
								</li>
							</ul>
						</li>
					</ul>
					<p class="storage-cleanup__warning">
						{{ t('storage.blockedHint') }}
					</p>
				</template>
				<div
					v-if="stage === 'confirm'"
					class="storage-final-confirm"
				>
					<p>{{ t('storage.permanentWarning') }}</p>
					<label class="storage-confirm-check">
						<input
							ref="confirmationCheck"
							v-model="confirmed"
							type="checkbox"
						>
						<span>{{ t('storage.confirmPermanent', {count: number(eligible.length)}) }}</span>
					</label>
					<label class="storage-confirm-input">
						<span>{{ t('storage.typeDelete') }}</span>
						<input
							v-model="confirmText"
							class="input"
							autocomplete="off"
							spellcheck="false"
							placeholder="DELETE"
						>
					</label>
				</div>
				<div
					v-if="stage === 'results'"
					data-cy="storage-results"
				>
					<p
						ref="progressHeading"
						class="storage-cleanup__progress"
						tabindex="-1"
						role="status"
						aria-live="polite"
					>
						{{ t(cleanup.isPending.value ? 'storage.processing' : 'storage.processed', {done: number(progress.processed), total: number(progress.total)}) }}
					</p>
					<progress
						:value="progress.processed"
						:max="Math.max(1, progress.total)"
						:aria-label="t('storage.processingProgress')"
					/>
					<p>{{ t('storage.resultSummary', {count: number(completed), size: bytes(freedBytes)}) }}</p>
					<p
						v-if="results.some(item => !item.bytes_complete)"
						class="storage-cleanup__warning"
					>
						{{ t('storage.releaseIncomplete') }}
					</p>
					<ul class="storage-review-items">
						<li
							v-for="item in results"
							:key="itemKey(item)"
						>
							<div>
								<strong>{{ item.name }}</strong>
								<span>{{ bytes(item.freed_bytes) }}</span>
							</div>
							<span :class="['completed', 'already_done'].includes(item.status) ? 'storage-allowed' : 'storage-blocked'">{{ resultLabel(item) }}</span>
							<p v-if="!['completed', 'already_done'].includes(item.status)">
								{{ reason(item.reason) }}
							</p>
						</li>
					</ul>
				</div>
				<footer class="storage-cleanup__actions">
					<XButton
						v-if="stage === 'review' && currentPreview"
						variant="tertiary"
						:shadow="false"
						:aria-disabled="busy"
						@click="dialog && requestPreview(dialog)"
					>
						{{ t('storage.reviewAgain') }}
					</XButton>
					<XButton
						v-if="stage === 'confirm'"
						variant="tertiary"
						:shadow="false"
						:aria-disabled="busy"
						@click="backToReview"
					>
						{{ t('storage.backToReview') }}
					</XButton>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="cleanup.isPending.value"
						@click="closeDialog"
					>
						{{ t(stage === 'results' ? 'misc.close' : 'misc.cancel') }}
					</XButton>
					<XButton
						v-if="stage === 'review' && currentPreview"
						:shadow="false"
						:danger="permanent"
						:aria-disabled="busy || !eligible.length"
						@click="proceed"
					>
						{{ t(permanent ? 'storage.continueToConfirm' : 'storage.confirmCleanup') }}
					</XButton>
					<XButton
						v-if="stage === 'confirm'"
						danger
						:shadow="false"
						:aria-disabled="busy || !confirmed || confirmText !== 'DELETE'"
						@click="execute"
					>
						{{ t('storage.actions.delete') }}
					</XButton>
					<XButton
						v-if="stage === 'results' && failed.length && !busy"
						:shadow="false"
						@click="reviewFailed"
					>
						{{ t('storage.reviewAgain') }}
					</XButton>
				</footer>
			</div>
		</Modal>
	</div>
</template>

<style scoped lang="scss">
.storage-page {
	min-inline-size: 0;
	padding-block-end: 5rem;
}
.storage-loading, .storage-empty {
	padding: 2rem 1rem;
	color: var(--text-secondary);
	text-align: center;
}
.storage-inventory {
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: 1.25rem;
	background: var(--surface-raised);
}
.storage-inventory__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding: 1.25rem;
}
.storage-inventory__header h2 {
	margin: 0;
	font-size: var(--text-lg);
}
.storage-tabs {
	display: flex;
	gap: .25rem;
	padding: .25rem;
	border-radius: .75rem;
	background: var(--surface-sunken);
}
.storage-tabs :deep(.button) {
	border-radius: .55rem;
	color: var(--text-secondary);
}
.storage-tabs :deep([aria-pressed='true']) {
	background: var(--surface-raised);
	color: var(--primary);
	box-shadow: 0 1px 4px #0000000a;
}
.storage-filters {
	display: flex;
	flex-wrap: wrap;
	gap: .75rem;
	padding: 0 1.25rem 1rem;
}
.storage-filters label, .storage-action-choice label {
	display: grid;
	flex: 1 1 7rem;
	gap: .3rem;
	min-inline-size: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-filters label.storage-search {
	flex-basis: 15rem;
}
.storage-filters input, .storage-filters select, .storage-action-choice select {
	min-inline-size: 0;
	inline-size: 100%;
	min-block-size: 2.75rem;
	padding: .5rem .65rem;
	border: 1px solid var(--border-subtle);
	border-radius: .6rem;
	background: var(--surface-raised);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-sm);
}
.storage-action-choice {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: .75rem 1.25rem;
	margin-inline: 1.25rem;
	padding: 1rem;
	border-radius: .75rem;
	background: var(--surface-sunken);
}
.storage-action-choice label {
	flex: 0 1 14rem;
}
.storage-action-choice p {
	flex: 1 1 14rem;
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-inventory__note {
	padding-inline: 1.25rem;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-list-status {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: .4rem 1rem;
	min-block-size: 3rem;
	padding: 1rem 1.25rem;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-items {
	margin: 0;
	padding: 0;
	list-style: none;
}
.storage-item {
	border-block-start: 1px solid var(--border-subtle);
}
.storage-item__row {
	display: flex;
	align-items: center;
	gap: .85rem;
	padding: .8rem 1rem .8rem .5rem;
}
.storage-item__select {
	display: grid;
	flex: none;
	place-items: center;
	inline-size: 2.75rem;
	block-size: 2.75rem;
	cursor: pointer;
}
.storage-item__select input, .storage-confirm-check input {
	inline-size: 1.1rem;
	block-size: 1.1rem;
	accent-color: var(--primary);
	cursor: pointer;
}
.storage-item__select.is-unavailable {
	opacity: .35;
	cursor: not-allowed;
}
.storage-item__icon {
	display: grid;
	flex: none;
	place-items: center;
	inline-size: 2.75rem;
	block-size: 2.75rem;
	border-radius: .75rem;
	background: var(--surface-sunken);
	color: var(--primary);
	font-size: var(--text-lg);
}
.storage-item__main {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: .2rem;
	min-inline-size: 0;
}
.storage-item__main > strong, .storage-item__main > a {
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-weight: 600;
	overflow-wrap: anywhere;
}
.storage-item__main > span {
	color: var(--text-secondary);
	font-size: var(--text-xs);
	overflow-wrap: anywhere;
}
.storage-item__size {
	display: flex;
	flex: none;
	flex-direction: column;
	gap: .2rem;
	max-inline-size: 10rem;
	text-align: end;
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}
.storage-item__size small {
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-badges {
	display: flex;
	flex-wrap: wrap;
	gap: .3rem;
}
.storage-badges span {
	padding: .1rem .4rem;
	border-radius: .3rem;
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-badges .is-working {
	color: var(--primary);
}
.storage-pagination {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: .75rem;
	padding: 1rem 1.25rem;
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-pagination > div {
	display: flex;
	gap: .5rem;
}
.storage-accounting {
	margin-block-start: 1rem;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-accounting summary {
	display: flex;
	align-items: center;
	min-block-size: 2.75rem;
	cursor: pointer;
}
.storage-accounting p {
	margin-block: .75rem;
}
.storage-selection {
	position: sticky;
	z-index: 5;
	inset-block-end: max(1rem, env(safe-area-inset-bottom));
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: .5rem 1rem;
	margin-block-start: 1rem;
	padding: .9rem 1rem;
	border: 1px solid var(--border-subtle);
	border-radius: 1rem;
	background: var(--surface-raised);
	box-shadow: 0 8px 30px #00000014;
}
.storage-selection > div {
	display: flex;
	flex: 1 1 10rem;
	flex-direction: column;
	gap: .2rem;
}
.storage-selection strong {
	font-size: var(--text-sm);
}
.storage-selection small {
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-page :deep(.button) {
	min-block-size: 2.75rem;
}
.storage-cleanup {
	inline-size: 100%;
	max-inline-size: 48rem;
	padding: clamp(1rem, 3vw, 1.75rem);
	border: 1px solid var(--border-subtle);
	border-radius: 1.25rem;
	background: var(--surface-raised);
	color: var(--text-primary);
}
.storage-cleanup header h2 {
	margin: 0;
	font-size: var(--text-xl);
}
.storage-cleanup header p, .storage-cleanup__warning {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-cleanup__estimate {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: .4rem 1rem;
	margin-block: 1.25rem;
	padding: 1rem;
	border-radius: .75rem;
	background: var(--surface-sunken);
}
.storage-cleanup__estimate strong {
	font-size: var(--text-xl);
	font-variant-numeric: tabular-nums;
}
.storage-cleanup__estimate small {
	flex-basis: 100%;
	color: var(--text-secondary);
}
.storage-review-items {
	margin: 1rem 0;
	padding: 0;
	list-style: none;
}
.storage-review-items > li {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	justify-content: space-between;
	gap: .5rem 1rem;
	padding-block: .85rem;
	border-block-end: 1px solid var(--border-subtle);
	font-size: var(--text-sm);
}
.storage-review-items > li > div {
	display: flex;
	flex: 1 1 10rem;
	flex-direction: column;
	gap: .25rem;
	min-inline-size: 0;
}
.storage-review-items strong {
	overflow-wrap: anywhere;
}
.storage-review-items div span {
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.storage-review-items > li > ul, .storage-review-items > li > p {
	flex-basis: 100%;
	margin: 0;
	overflow-wrap: anywhere;
}
.storage-review-items > li > span {
	max-inline-size: 24rem;
	overflow-wrap: anywhere;
}
.storage-allowed {
	color: var(--success);
}
.storage-blocked {
	color: var(--danger-text);
}
.storage-cleanup__actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: .75rem;
	margin-block-start: 1.5rem;
}
.storage-confirm-check {
	display: flex;
	align-items: flex-start;
	gap: .75rem;
	padding-block: .75rem;
}
.storage-confirm-check input {
	flex: none;
	margin-block-start: .2rem;
}
.storage-confirm-input {
	display: grid;
	gap: .5rem;
	margin-block-start: 1rem;
}
.storage-confirm-input input {
	min-block-size: 2.75rem;
}
.storage-cleanup progress {
	inline-size: 100%;
	accent-color: var(--primary);
}
.storage-cleanup__progress {
	font-weight: 600;
}
@media (width <= 768px) {
	.storage-inventory__header {
		padding: 1rem;
	}
	.storage-filters {
		padding-inline: 1rem;
	}
	.storage-action-choice {
		margin-inline: 1rem;
	}
	.storage-item__row {
		flex-wrap: wrap;
		gap: .5rem;
		padding: .65rem .65rem .65rem .25rem;
	}
	.storage-item__icon {
		display: none;
	}
	.storage-item__main {
		flex-basis: calc(100% - 6rem);
	}
	.storage-item__size {
		flex: 1;
		max-inline-size: none;
		margin-inline-start: 3.25rem;
		text-align: start;
	}
	.storage-pagination {
		padding-inline: 1rem;
	}
	.storage-selection {
		inset-block-end: calc(5rem + env(safe-area-inset-bottom));
	}
}
@media (prefers-reduced-motion: reduce) {
	.storage-page :deep(*) {
		scroll-behavior: auto;
	}
}
</style>
