<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, useId, watch} from 'vue'
import {onBeforeRouteLeave, onBeforeRouteUpdate} from 'vue-router'
import {useEventListener} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {ApiError} from '@/client/problem'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {useUpdateNote, type Note, type NoteText} from '@/client/queries/notes'
import XButton from '@/components/input/Button.vue'
import Modal from '@/components/misc/Modal.vue'
import MarkdownBlock from '@/components/ai/timeline/MarkdownBlock.vue'
import {sameNoteText, noteExportFilename} from '@/helpers/notes/text'
import {downloadCompassFile} from '@/helpers/compass/exportMarkdown'
import {formatDateShort} from '@/helpers/time/formatDate'

const props = defineProps<{
	note: Note
	reload: () => Promise<Note | undefined>
}>()
const {t} = useI18n({useScope: 'global'})
const ids = useId()
const owner = captureClientRequestContext()
// This keyed editor owns a draft; background refreshes are reconciled instead of binding over new typing.
function initialDraft() { return props.note }
const initial = initialDraft()
const baseline = ref(initial)
const title = ref(initial.title)
const content = ref(initial.content)
const pinned = ref(initial.pinned)
const preview = ref(false)
const bodyField = ref<HTMLTextAreaElement>()
const failure = ref('')
const conflict = ref(false)
const latest = ref<Note>()
const comparing = ref(false)
const loadingLatest = ref(false)
const update = useUpdateNote()
const writing = computed<Readonly<NoteText>>(() => ({
	title: title.value,
	content: content.value,
	pinned: pinned.value,
}))
const dirty = computed(() => !sameNoteText(writing.value, baseline.value))
const status = computed(() => {
	if (conflict.value) return t('notes.save.conflict')
	if (failure.value) return t('notes.save.failed')
	if (update.isPending.value) return t('notes.save.saving')
	return dirty.value ? t('notes.save.unsaved') : t('notes.save.saved')
})
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let acknowledgedLeave = false
let acceptedLeaveDraft: Readonly<NoteText> | undefined
function current() {
	return !disposed && isClientRequestContextCurrent(owner)
}
function schedule() {
	clearTimeout(timer)
	if (!current() || !dirty.value || failure.value || conflict.value || update.isPending.value) return
	timer = setTimeout(() => { void save() }, 1200)
}
watch(writing, schedule, {deep: true})
watch(update.isPending, pending => { if (!pending) schedule() })

function adopt(note: Note) {
	baseline.value = note
	title.value = note.title
	content.value = note.content
	pinned.value = note.pinned
	failure.value = ''
	conflict.value = false
	latest.value = undefined
}

watch(() => props.note, note => {
	if (!current() || update.isPending.value || note.revision <= baseline.value.revision) return
	if (dirty.value) {
		conflict.value = true
		latest.value = note
		clearTimeout(timer)
	} else adopt(note)
})

async function save() {
	clearTimeout(timer)
	if (!current() || update.isPending.value || conflict.value || !dirty.value) return
	if (!title.value.trim()) {
		failure.value = t('notes.titleRequired')
		return
	}
	if ([...title.value.trim()].length > 250 || /[\n\r\0]/.test(title.value)) {
		failure.value = t('notes.titleTooLong')
		return
	}
	if (new TextEncoder().encode(content.value).byteLength > 8 * 1024 * 1024) {
		failure.value = t('notes.articleTooLarge')
		return
	}
	const draft = writing.value
	const submitted = {
		...draft,
		title: draft.title.trim(),
	}
	failure.value = ''
	try {
		const saved = await update.mutateAsync({
			...submitted,
			id: props.note.id,
			expected_revision: baseline.value.revision,
		})
		if (!current()) return
		if (sameNoteText(writing.value, draft)) adopt(saved)
		else baseline.value = saved
	} catch (cause) {
		if (!current() || isRequestContextAbort(cause)) return
		if (cause instanceof ApiError && cause.status === 409) conflict.value = true
		else failure.value = t('notes.save.error')
	} finally {
		if (current()) schedule()
	}
}

async function compare() {
	if (loadingLatest.value || !current()) return
	loadingLatest.value = true
	try {
		const note = await props.reload()
		if (current() && note) {
			latest.value = note
			comparing.value = true
		}
	} catch (cause) {
		if (current() && !isRequestContextAbort(cause)) failure.value = t('notes.save.latestFailed')
	} finally {
		if (current()) loadingLatest.value = false
	}
}

function keepDraft() {
	if (!latest.value || !current()) return
	baseline.value = latest.value
	conflict.value = false
	comparing.value = false
	// Rebasing is explicit, and writing the draft over that revision requires a separate Save click.
	failure.value = t('notes.save.rebased')
}
function useServerVersion() {
	if (!latest.value || !current()) return
	adopt(latest.value)
	comparing.value = false
}

function exportArticle(extension: 'md' | 'txt') {
	if (!current()) return
	const heading = title.value.replace(/\s*\n\s*/g, ' ')
	const text = extension === 'md' ? `# ${heading}\n\n${content.value}\n` : `${heading}\n\n${content.value}\n`
	downloadCompassFile(new Blob([text], {type: 'text/plain;charset=utf-8'}), noteExportFilename(title.value, extension))
}

function mayLeave() {
	if (acknowledgedLeave || !current() || !dirty.value) return true
	const draft = writing.value
	if (acceptedLeaveDraft && sameNoteText(acceptedLeaveDraft, draft)) return true
	const accepted = window.confirm(t('notes.save.leaveConfirm'))
	if (accepted) acceptedLeaveDraft = draft
	return accepted
}
onBeforeRouteLeave(mayLeave)
onBeforeRouteUpdate(to => Number(to.params.noteId) === props.note.id || mayLeave())
useEventListener(window, 'beforeunload', event => {
	if (current() && dirty.value && !acknowledgedLeave) event.preventDefault()
})
onBeforeUnmount(() => {
	disposed = true
	clearTimeout(timer)
})
function shortcut(event: KeyboardEvent) {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
		event.preventDefault()
		void save()
	}
}
async function appendTranscript(text: string) {
	if (!current() || !text.trim()) return
	preview.value = false
	content.value = [content.value.trimEnd(), text].filter(Boolean).join('\n\n')
	await nextTick()
	bodyField.value?.focus()
}
defineExpose({mayLeave, appendTranscript, acknowledgeDelete: () => { acknowledgedLeave = true }})
</script>

<template>
	<section
		class="note-editor"
		@keydown="shortcut"
	>
		<div class="note-editor__toolbar">
			<span
				class="note-editor__status"
				role="status"
				:class="{'has-error': failure || conflict}"
			>
				<Icon :icon="failure || conflict ? 'exclamation-circle' : dirty ? 'pen' : 'check'" />
				{{ status }}
			</span>
			<div class="note-editor__actions">
				<XButton
					variant="tertiary"
					:shadow="false"
					:aria-pressed="pinned"
					@click="pinned = !pinned"
				>
					<Icon icon="thumbtack" /> {{ pinned ? t('notes.unpin') : t('notes.pin') }}
				</XButton>
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-pressed="preview"
					@click="preview = !preview"
				>
					{{ preview ? t('notes.edit') : t('notes.preview') }}
				</XButton>
				<XButton
					:shadow="false"
					:loading="update.isPending.value"
					:aria-disabled="update.isPending.value || !dirty || conflict"
					@click="save"
				>
					{{ t('misc.save') }}
				</XButton>
			</div>
		</div>
		<div
			v-if="conflict"
			class="note-editor__notice"
			role="alert"
		>
			<p>{{ t('notes.save.conflictHelp') }}</p>
			<XButton
				variant="secondary"
				:shadow="false"
				:loading="loadingLatest"
				@click="compare"
			>
				{{ t('notes.save.reviewLatest') }}
			</XButton>
		</div>
		<p
			v-if="failure"
			class="note-editor__notice"
			role="alert"
		>
			{{ failure }}
		</p>
		<label
			:for="`${ids}-title`"
			class="is-sr-only"
		>{{ t('notes.titleLabel') }}</label>
		<input
			:id="`${ids}-title`"
			v-model="title"
			class="note-editor__title"
			:placeholder="t('notes.titlePlaceholder')"
			autocomplete="off"
		>
		<div
			v-if="preview"
			class="note-editor__preview"
			:aria-label="t('notes.preview')"
		>
			<MarkdownBlock
				v-if="content.trim()"
				:source="content"
			/>
			<p
				v-else
				class="note-editor__muted"
			>
				{{ t('notes.emptyArticle') }}
			</p>
		</div>
		<template v-else>
			<label
				:for="`${ids}-body`"
				class="is-sr-only"
			>{{ t('notes.articleLabel') }}</label>
			<textarea
				:id="`${ids}-body`"
				ref="bodyField"
				v-model="content"
				class="note-editor__body"
				:placeholder="t('notes.articlePlaceholder')"
				spellcheck="true"
			/>
		</template>
		<footer class="note-editor__footer">
			<span>{{ t('notes.markdownHelp') }}</span>
			<span v-if="baseline.updated">{{ t('notes.updatedAt', {date: formatDateShort(baseline.updated)}) }}</span>
			<div class="note-editor__exports">
				<button
					type="button"
					@click="exportArticle('md')"
				>
					{{ t('notes.exportMarkdown') }}
				</button>
				<button
					type="button"
					@click="exportArticle('txt')"
				>
					{{ t('notes.exportText') }}
				</button>
			</div>
		</footer>
		<Modal
			v-if="comparing && latest"
			wide
			:confirm-label="t('notes.save.keepDraft')"
			@close="comparing = false"
			@submit="keepDraft"
		>
			<template #header>
				{{ t('notes.save.compareTitle') }}
			</template>
			<template #text>
				<p>{{ t('notes.save.compareHelp') }}</p>
				<div class="note-compare">
					<section><h3>{{ t('notes.save.yourDraft') }}</h3><strong>{{ title }}</strong><pre>{{ content }}</pre></section>
					<section><h3>{{ t('notes.save.serverVersion') }}</h3><strong>{{ latest.title }}</strong><pre>{{ latest.content }}</pre></section>
				</div>
				<div class="note-compare__actions">
					<XButton
						variant="secondary"
						:shadow="false"
						@click="useServerVersion"
					>
						{{ t('notes.save.useServer') }}
					</XButton>
				</div>
			</template>
		</Modal>
	</section>
</template>

<style scoped lang="scss">
.note-editor {
	display: flex;
	min-inline-size: 0;
	flex-direction: column;
	gap: var(--space-4);
}

.note-editor__toolbar, .note-editor__actions, .note-editor__footer, .note-editor__exports {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.note-editor__toolbar {
	justify-content: space-between;
}

.note-editor__status {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.note-editor__status.has-error {
	color: var(--danger-text);
}

.note-editor__notice {
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--tint-warning);
}

.note-editor__title {
	inline-size: 100%;
	min-inline-size: 0;
	padding: var(--space-2) 0;
	border: 0;
	border-block-end: 1px solid var(--border-subtle);
	background: transparent;
	color: var(--text-primary);
	font-size: clamp(1.35rem, 2vw, 1.85rem);
	font-weight: var(--weight-semibold);
}

.note-editor__body {
	inline-size: 100%;
	min-block-size: 24rem;
	padding: var(--space-3);
	resize: vertical;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	color: var(--text-primary);
	font-family: var(--font-mono);
	font-size: var(--text-md);
	line-height: 1.8;
}

.note-editor__preview {
	min-block-size: 24rem;
	padding: var(--space-3);
	overflow-wrap: anywhere;
}

.note-editor__footer {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.note-editor__exports {
	margin-inline-start: auto;
}

.note-editor__exports button {
	min-block-size: 44px;
	border: 0;
	background: transparent;
	color: var(--link);
	cursor: pointer;
}

.note-editor__muted {
	color: var(--text-secondary);
}

.note-compare {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-4);
}

.note-compare pre {
	max-block-size: 40vh;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.note-compare__actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-3);
}

@media (width <= 600px) {
	.note-editor__toolbar {
		align-items: flex-start;
	}
	.note-editor__actions {
		inline-size: 100%;
	}
	.note-editor__body, .note-editor__preview {
		min-block-size: 45dvh;
	}
	.note-compare {
		grid-template-columns: 1fr;
	}
}
</style>
