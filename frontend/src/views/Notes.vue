<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {refDebounced, useMediaQuery} from '@vueuse/core'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useTitle} from '@/composables/useTitle'
import {useNote, useNotes, notesAccessDenied} from '@/composables/useNotes'
import {useCreateNote, useDeleteNote, type Note, type NoteSummary} from '@/client/queries/notes'
import {clampPage} from '@/client/queries/pagination'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'
import {formatDateShort} from '@/helpers/time/formatDate'
import {getHumanSize} from '@/helpers/getHumanSize'
import {useAuthStore} from '@/stores/auth'
import NoteEditor from '@/components/notes/NoteEditor.vue'
import NoteTranscripts from '@/components/notes/NoteTranscripts.vue'
import XButton from '@/components/input/Button.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Modal from '@/components/misc/Modal.vue'

defineOptions({name: 'PersonalNotes'})
const {t} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const noteId = computed(() => Number(route.params.noteId) || 0)
const search = ref('')
const debouncedSearch = refDebounced(search, 300)
const pinnedOnly = ref(false)
const page = ref(1)
const filters = computed(() => ({
	q: debouncedSearch.value.trim() || undefined,
	pinned: pinnedOnly.value || undefined,
}))
watch(filters, () => { page.value = 1 })
const library = useNotes(filters, page)
watch([library.data, library.isPlaceholderData], () => {
	page.value = clampPage(page.value, {
		data: library.data.value,
		isPlaceholderData: library.isPlaceholderData.value,
	})
})
const detail = useNote(noteId)
const note = detail.note
const editor = ref<InstanceType<typeof NoteEditor>>()
const editorNote = shallowRef<Note>()
const deletedDraft = ref(false)
const create = useCreateNote()
const remove = useDeleteNote()
const createError = ref(false)
const deleteTarget = ref<NoteSummary>()
const deleteError = ref(false)
const detailTab = ref<'article' | 'transcript'>('article')
const compact = useMediaQuery('(max-width: 900px)')
const articleTab = ref<HTMLButtonElement>()
const transcriptTab = ref<HTMLButtonElement>()
const appendNotice = ref(false)
const recordingNoteId = ref<number>()
let disposed = false
onBeforeUnmount(() => { disposed = true })
const sessionKey = computed(() => {
	void auth.session
	const context = captureClientRequestContext()
	return JSON.stringify([context.apiBaseUrl, auth.info?.id, context.identity?.type, context.authSessionEpoch])
})
watch(sessionKey, () => {
	editorNote.value = undefined
	deletedDraft.value = false
	search.value = ''
	pinnedOnly.value = false
	page.value = 1
	deleteTarget.value = undefined
	createError.value = false
	deleteError.value = false
	recordingNoteId.value = undefined
}, {flush: 'sync'})
watch(noteId, () => { detailTab.value = 'article'; appendNotice.value = false; recordingNoteId.value = undefined })
watch(note, value => {
	if (value) {
		editorNote.value = value
		deletedDraft.value = false
	} else if (value === null && editorNote.value?.id === noteId.value && editor.value?.hasUnsavedDraft()) {
		// Keep only this tab's unsaved draft after an acknowledged native deletion, never after an access error.
		deletedDraft.value = true
		detailTab.value = 'article'
		recordingNoteId.value = undefined
	} else {
		editorNote.value = undefined
		deletedDraft.value = false
	}
}, {immediate: true, flush: 'sync'})
useTitle(() => note.value?.title || t('notes.title'))

async function createNote() {
	if (create.isPending.value) return
	if (editor.value && !editor.value.mayLeave()) return
	const owner = captureClientRequestContext()
	const origin = route.fullPath
	createError.value = false
	try {
		const created = await create.mutateAsync({title: t('notes.defaultTitle'), content: '', pinned: false})
		if (!disposed && isClientRequestContextCurrent(owner) && route.fullPath === origin) {
			await router.push({name: 'notes.detail', params: {noteId: created.id}})
		}
	} catch (cause) {
		if (!disposed && route.fullPath === origin && isClientRequestContextCurrent(owner) && !isRequestContextAbort(cause)) {
			createError.value = true
		}
	}
}
async function reloadNote(): Promise<Note | undefined> {
	const id = noteId.value
	const result = await detail.refetch()
	if (result.error) throw result.error
	return id === noteId.value ? result.data : undefined
}
function askDelete() {
	if (!note.value || remove.isPending.value) return
	deleteError.value = false
	deleteTarget.value = note.value
}
async function deleteNote() {
	const target = deleteTarget.value
	if (!target || remove.isPending.value) return
	const owner = captureClientRequestContext()
	deleteError.value = false
	try {
		await remove.mutateAsync(target.id)
		if (disposed || !isClientRequestContextCurrent(owner)) return
		if (deleteTarget.value?.id === target.id) deleteTarget.value = undefined
		if (noteId.value === target.id) {
			editor.value?.acknowledgeDelete()
			await router.replace({name: 'notes'})
		}
	} catch (cause) {
		if (isClientRequestContextCurrent(owner) && deleteTarget.value?.id === target.id && !isRequestContextAbort(cause)) {
			deleteError.value = true
		}
	}
}
function changePage(forward: boolean) {
	if (library.isFetching.value) return
	const next = page.value + (forward ? 1 : -1)
	if (next >= 1 && next <= (library.data.value?.total_pages ?? 1)) page.value = next
}
async function tabKeys(event: KeyboardEvent) {
	if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
	event.preventDefault()
	detailTab.value = event.key === 'Home' ? 'article' : event.key === 'End' ? 'transcript'
		: detailTab.value === 'article' ? 'transcript' : 'article'
	await nextTick()
	;(detailTab.value === 'article' ? articleTab.value : transcriptTab.value)?.focus()
}
async function appendTranscript(text: string) {
	const id = noteId.value
	const owner = captureClientRequestContext()
	const target = editor.value
	detailTab.value = 'article'
	await nextTick()
	if (disposed || !isClientRequestContextCurrent(owner) || noteId.value !== id || editor.value !== target) return
	await target?.appendTranscript(text)
	if (!disposed && isClientRequestContextCurrent(owner) && noteId.value === id) appendNotice.value = true
}
function setRecording(id: number, active: boolean) {
	if (active && noteId.value === id) recordingNoteId.value = id
	else if (recordingNoteId.value === id) recordingNoteId.value = undefined
}
async function showRecording() {
	detailTab.value = 'transcript'
	await nextTick()
	transcriptTab.value?.focus()
}
async function closeDeletedDraft() {
	if (!deletedDraft.value || (editor.value && !editor.value.mayLeave())) return
	editorNote.value = undefined
	deletedDraft.value = false
	await router.replace({name: 'notes'})
}
</script>

<template>
	<div
		class="notes-page"
		:class="{'notes-page--detail': noteId > 0}"
	>
		<header class="notes-page__header">
			<div>
				<h1><Icon icon="book-open" /> {{ t('notes.title') }}</h1>
				<p>{{ t('notes.subtitle') }}</p>
			</div>
			<XButton
				icon="plus"
				:shadow="false"
				:loading="create.isPending.value"
				:aria-disabled="create.isPending.value"
				@click="createNote"
			>
				{{ t('notes.new') }}
			</XButton>
		</header>
		<LoadError
			v-if="createError"
			:message="t('notes.createFailed')"
			:retry="library.refetch"
		/>
		<div class="notes-page__layout">
			<aside
				class="notes-library"
				:aria-label="t('notes.library')"
			>
				<div class="notes-library__filters">
					<label
						for="notes-search"
						class="is-sr-only"
					>{{ t('notes.search') }}</label>
					<input
						id="notes-search"
						v-model="search"
						class="input"
						type="search"
						:placeholder="t('notes.search')"
					>
					<label class="notes-library__pinned"><input
						v-model="pinnedOnly"
						type="checkbox"
					> {{ t('notes.pinnedOnly') }}</label>
				</div>
				<LoadError
					v-if="library.isError.value"
					:message="t('notes.listFailed')"
					:retry="library.refetch"
				/>
				<p
					v-if="library.isPending.value"
					class="notes-library__empty"
					role="status"
				>
					{{ t('notes.loading') }}
				</p>
				<p
					v-else-if="!library.notes.value.length && !library.isError.value"
					class="notes-library__empty"
				>
					{{ filters.q || filters.pinned ? t('notes.noResults') : t('notes.empty') }}
				</p>
				<ul
					v-else
					class="notes-library__list"
					:aria-busy="library.isFetching.value"
				>
					<li
						v-for="entry in library.notes.value"
						:key="entry.id"
					>
						<RouterLink
							:to="{name: 'notes.detail', params: {noteId: entry.id}}"
							class="note-row"
							:class="{'is-selected': entry.id === noteId}"
							:aria-current="entry.id === noteId ? 'page' : undefined"
						>
							<strong><Icon
								v-if="entry.pinned"
								icon="thumbtack"
								:aria-label="t('notes.pinned')"
							/> {{ entry.title }}</strong>
							<p v-if="entry.excerpt">
								{{ entry.excerpt }}
							</p>
							<div class="note-row__meta">
								<time
									v-if="entry.updated"
									:datetime="entry.updated"
								>{{ formatDateShort(entry.updated) }}</time>
								<span v-if="entry.segment_count"><Icon icon="microphone" /> {{ entry.segment_count }}</span>
							</div>
						</RouterLink>
					</li>
				</ul>
				<nav
					v-if="(library.data.value?.total_pages ?? 0) > 1"
					class="notes-library__pagination"
					:aria-label="t('notes.pagination')"
				>
					<XButton
						variant="tertiary"
						:shadow="false"
						:aria-disabled="page <= 1 || library.isFetching.value"
						@click="changePage(false)"
					>
						{{ t('misc.previous') }}
					</XButton>
					<span>{{ t('notes.page', {page}) }}</span>
					<XButton
						variant="tertiary"
						:shadow="false"
						:aria-disabled="page >= (library.data.value?.total_pages ?? 1) || library.isFetching.value"
						@click="changePage(true)"
					>
						{{ t('misc.next') }}
					</XButton>
				</nav>
			</aside>
			<main
				class="notes-workspace"
				:aria-label="t('notes.workspace')"
			>
				<div
					v-if="noteId > 0"
					class="notes-workspace__top"
				>
					<RouterLink
						class="notes-workspace__back"
						:to="{name: 'notes'}"
					>
						<Icon icon="arrow-left" /> {{ t('notes.back') }}
					</RouterLink>
					<XButton
						v-if="note"
						variant="tertiary"
						:shadow="false"
						icon="trash-alt"
						:aria-disabled="remove.isPending.value"
						@click="askDelete"
					>
						{{ t('misc.delete') }}
					</XButton>
				</div>
				<div
					v-if="!noteId"
					class="notes-welcome"
				>
					<Icon
						icon="book-open"
						aria-hidden="true"
					/>
					<h2>{{ t('notes.welcome') }}</h2>
					<p>{{ t('notes.welcomeHelp') }}</p>
					<XButton
						icon="plus"
						:shadow="false"
						:aria-disabled="create.isPending.value"
						@click="createNote"
					>
						{{ t('notes.new') }}
					</XButton>
				</div>
				<template v-else>
					<LoadError
						v-if="detail.isError.value"
						:message="t(notesAccessDenied(detail.error.value) ? 'notes.unavailable' : 'notes.detailFailed')"
						:retry="detail.refetch"
					/>
					<p
						v-if="detail.isPending.value"
						role="status"
					>
						{{ t('notes.loading') }}
					</p>
					<template v-if="editorNote">
						<XButton
							v-if="deletedDraft"
							variant="tertiary"
							:shadow="false"
							@click="closeDeletedDraft"
						>
							{{ t('notes.deletedDraft.close') }}
						</XButton>
						<div
							v-if="!deletedDraft"
							class="notes-workspace__tabs"
						>
							<div
								v-if="compact"
								role="tablist"
								:aria-label="t('notes.workspace')"
								@keydown="tabKeys"
							>
								<button
									id="note-article-tab"
									ref="articleTab"
									type="button"
									role="tab"
									:tabindex="detailTab === 'article' ? 0 : -1"
									:aria-selected="detailTab === 'article'"
									aria-controls="note-article-panel"
									@click="detailTab = 'article'"
								>
									{{ t('notes.article') }}
								</button>
								<button
									id="note-transcript-tab"
									ref="transcriptTab"
									type="button"
									role="tab"
									:tabindex="detailTab === 'transcript' ? 0 : -1"
									:aria-selected="detailTab === 'transcript'"
									aria-controls="note-transcript-panel"
									@click="detailTab = 'transcript'"
								>
									{{ t('notes.transcript.title') }} <span>{{ editorNote.segment_count }}</span>
								</button>
							</div>
							<button
								v-if="recordingNoteId === editorNote.id"
								type="button"
								class="notes-workspace__recording"
								@click="showRecording"
							>
								<Icon icon="microphone" /> {{ t('notes.recordingIndicator') }}
							</button>
							<span class="notes-workspace__size">{{ getHumanSize(editorNote.content_bytes + editorNote.transcript_bytes) }}</span>
						</div>
						<p
							v-if="appendNotice"
							class="notes-workspace__append-notice"
							role="status"
						>
							{{ t('notes.transcript.added') }}
						</p>
						<div
							id="note-article-panel"
							class="notes-workspace__article"
							:class="{'is-mobile-hidden': detailTab !== 'article'}"
							:role="compact && !deletedDraft ? 'tabpanel' : undefined"
							:aria-labelledby="compact && !deletedDraft ? 'note-article-tab' : undefined"
						>
							<NoteEditor
								:key="`${sessionKey}:${editorNote.id}`"
								ref="editor"
								:note="editorNote"
								:deleted="deletedDraft"
								:reload="reloadNote"
							/>
						</div>
						<div
							v-if="!deletedDraft"
							id="note-transcript-panel"
							class="notes-workspace__transcript"
							:class="{'is-mobile-hidden': detailTab !== 'transcript'}"
							:role="compact ? 'tabpanel' : undefined"
							:aria-labelledby="compact ? 'note-transcript-tab' : undefined"
						>
							<NoteTranscripts
								:key="`${sessionKey}:${editorNote.id}`"
								:note-id="editorNote.id"
								:note-title="editorNote.title"
								@append="appendTranscript"
								@recording="setRecording(editorNote.id, $event)"
							/>
						</div>
					</template>
				</template>
			</main>
		</div>
		<Modal
			v-if="deleteTarget"
			danger
			:loading="remove.isPending.value"
			:confirm-label="t('notes.delete.confirm')"
			@close="deleteTarget = undefined"
			@submit="deleteNote"
		>
			<template #header>
				{{ t('notes.delete.title') }}
			</template>
			<template #text>
				<p>{{ t('notes.delete.help', {title: deleteTarget.title}) }}</p>
				<p
					v-if="deleteError"
					role="alert"
				>
					{{ t('notes.delete.failed') }}
				</p>
			</template>
		</Modal>
	</div>
</template>

<style scoped lang="scss">
.notes-page {
	max-inline-size: 100rem;
	margin-inline: auto;
}

.notes-page__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-4);
	margin-block-end: var(--space-5);
}

.notes-page__header h1 {
	margin: 0 0 var(--space-2);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
}

.notes-page__header h1 .icon {
	color: var(--primary);
}

.notes-page__header p {
	margin: 0;
	color: var(--text-secondary);
}

.notes-page__layout {
	display: grid;
	grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr);
	gap: var(--space-5);
	align-items: start;
}

.notes-library {
	position: sticky;
	inset-block-start: var(--space-4);
	min-inline-size: 0;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
}

.notes-library__filters {
	display: grid;
	gap: var(--space-2);
	padding: var(--space-3);
	border-block-end: 1px solid var(--border-subtle);
}

.notes-library__pinned {
	display: flex;
	min-block-size: 44px;
	align-items: center;
	gap: var(--space-2);
	font-size: var(--text-sm);
	cursor: pointer;
}

.notes-library__list {
	max-block-size: calc(100dvh - 21rem);
	min-block-size: 12rem;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
}

.notes-library__empty {
	padding: var(--space-5);
	color: var(--text-secondary);
	line-height: 1.7;
}

.note-row {
	display: block;
	padding: var(--space-4);
	border-block-end: 1px solid var(--border-subtle);
	color: var(--text-primary);
}

.note-row:hover, .note-row.is-selected {
	background: var(--tint-primary);
}

.note-row strong {
	display: block;
	overflow-wrap: anywhere;
}

.note-row strong .icon {
	color: var(--primary);
}

.note-row p {
	display: -webkit-box;
	margin-block: var(--space-2);
	overflow: hidden;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	overflow-wrap: anywhere;
}

.note-row__meta {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-2);
	margin-block-start: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.notes-library__pagination {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: var(--space-2);
	font-size: var(--text-sm);
}

.notes-workspace {
	display: grid;
	min-inline-size: 0;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-4);
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
}

.notes-workspace__top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
}

.notes-workspace__back {
	display: inline-flex;
	min-block-size: 44px;
	align-items: center;
	gap: var(--space-2);
}

.notes-workspace__tabs {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	border-block-end: 1px solid var(--border-subtle);
}

.notes-workspace__tabs button {
	min-block-size: 44px;
	padding-inline: var(--space-3);
	border: 0;
	border-block-end: 2px solid transparent;
	background: transparent;
	color: var(--text-secondary);
	cursor: pointer;
}

.notes-workspace__tabs button[aria-selected='true'] {
	border-block-end-color: var(--primary);
	color: var(--primary);
	font-weight: var(--weight-semibold);
}

.notes-workspace__tabs button span {
	margin-inline-start: var(--space-1);
	font-size: var(--text-sm);
}

.notes-workspace__tabs .notes-workspace__recording {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--primary);
}

.notes-workspace__size {
	margin-inline-start: auto;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.notes-workspace__append-notice {
	grid-column: 1 / -1;
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--tint-primary);
	font-size: var(--text-sm);
}

.notes-workspace__transcript {
	padding-block-start: var(--space-5);
	border-block-start: 1px solid var(--border-subtle);
}

.notes-welcome {
	display: grid;
	min-block-size: 28rem;
	align-content: center;
	justify-items: center;
	gap: var(--space-4);
	text-align: center;
}

.notes-welcome > .icon {
	color: var(--primary);
	font-size: 2.5rem;
}

.notes-welcome p {
	max-inline-size: 28rem;
	color: var(--text-secondary);
	line-height: 1.8;
}

@media (width >= 1500px) {
	.notes-workspace:has(.notes-workspace__article) {
		grid-template-columns: minmax(0, 1.3fr) minmax(20rem, 1fr);
	}
	.notes-workspace__top, .notes-workspace__tabs {
		grid-column: 1 / -1;
	}
	.notes-workspace__transcript {
		padding-block-start: 0;
		padding-inline-start: var(--space-5);
		border-block-start: 0;
		border-inline-start: 1px solid var(--border-subtle);
	}
}

@media (width <= 900px) {
	.notes-page__layout {
		grid-template-columns: minmax(0, 1fr);
	}
	.notes-library {
		position: static;
	}
	.notes-library__list {
		max-block-size: none;
	}
	.notes-page:not(.notes-page--detail) .notes-workspace, .notes-page--detail .notes-library {
		display: none;
	}
	.notes-workspace {
		padding: var(--space-4);
	}
	.notes-workspace__transcript {
		padding-block-start: 0;
		border: 0;
	}
	.is-mobile-hidden {
		display: none;
	}
}

@media (width <= 420px) {
	.notes-page__header p {
		font-size: var(--text-sm);
	}
	.notes-page__header .button {
		inline-size: 100%;
	}
	.notes-workspace {
		padding: var(--space-3);
	}
}
</style>
