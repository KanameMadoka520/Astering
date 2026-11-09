<script setup lang="ts">
import {computed, nextTick, ref, shallowRef, useId, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouter} from 'vue-router'
import {notesAccessDenied, useNoteSegments, useReceiveNoteTranscript} from '@/composables/useNotes'
import type {LiveNoteReceipt} from '@/client/queries/liveNotes'
import type {NoteSegment} from '@/client/queries/notes'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'
import {stageAronaDraftHandoff} from '@/helpers/aronaDraftHandoff'
import {selectedTranscript, transcriptTime, transcriptCapturedTime} from '@/helpers/notes/text'
import {useLiveNotePreferences} from '@/composables/useLiveNotePreferences'
import XButton from '@/components/input/Button.vue'
import Modal from '@/components/misc/Modal.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import LiveVoiceRecorder from './LiveVoiceRecorder.vue'

const props = defineProps<{noteId: number, noteTitle: string}>()
const emit = defineEmits<{append: [text: string], recording: [active: boolean]}>()
const {t, locale} = useI18n({useScope: 'global'})
const preferences = useLiveNotePreferences()
const captureLabel = (segment: NoteSegment) => transcriptCapturedTime(segment, preferences.timezone.value, locale.value)
const router = useRouter()
const owner = captureClientRequestContext()
const ids = useId()
const cursors = ref([0])
const page = ref(0)
const latestMode = ref(true)
const frozen = shallowRef<NoteSegment[]>()
const afterId = computed(() => latestMode.value ? -1 : cursors.value[page.value] ?? 0)
const query = useNoteSegments(() => props.noteId, afterId)
const receive = useReceiveNoteTranscript()
const selection = ref<number[]>([])
const selectedText = ref('')
const sourceRoot = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const handoffOpen = ref(false)
const handoff = ref('')
const handoffField = ref<HTMLTextAreaElement>()
const handoffEmpty = ref(false)
const preset = ref<'organize' | 'plan'>('organize')
const navigating = ref(false)
const navigationError = ref(false)
const added = ref(false)
const visibleSegments = computed(() => notesAccessDenied(query.error.value) ? [] : frozen.value ?? query.segments.value)
const source = computed(() => selectedText.value || selectedTranscript(visibleSegments.value, selection.value, preferences.timezone.value))
const allSelected = computed(() => visibleSegments.value.length > 0
	&& visibleSegments.value.every(segment => selection.value.includes(segment.id)))
const instructions = computed(() => t(`notes.arona.${preset.value}Prompt`))
watch(source, () => { added.value = false })
watch(handoff, text => { if (text.trim()) handoffEmpty.value = false })
function segmentSaved(receipt: LiveNoteReceipt) {
	if (isClientRequestContextCurrent(owner)) receive(props.noteId, receipt)
}
function recordingChanged(active: boolean) {
	if (isClientRequestContextCurrent(owner)) emit('recording', active)
}

watch(() => props.noteId, () => {
	cursors.value = [0]
	page.value = 0
	latestMode.value = true
	frozen.value = undefined
	selection.value = []
	selectedText.value = ''
	handoffOpen.value = false
})
watch(afterId, () => {
	selection.value = []
	selectedText.value = ''
	frozen.value = undefined
})
watch(query.error, cause => {
	if (notesAccessDenied(cause)) {
		frozen.value = undefined
		clearSelection()
	}
})
watch(() => visibleSegments.value.at(-1)?.id, async () => {
	if (!latestMode.value || frozen.value) return
	await nextTick()
	if (latestMode.value && !frozen.value && sourceRoot.value) sourceRoot.value.scrollTop = sourceRoot.value.scrollHeight
})

function pauseFollow() {
	if (isClientRequestContextCurrent(owner) && latestMode.value && !frozen.value && visibleSegments.value.length) {
		frozen.value = [...visibleSegments.value]
	}
}
async function showLatest() {
	if (!isClientRequestContextCurrent(owner)) return
	const id = props.noteId
	latestMode.value = true
	frozen.value = undefined
	clearSelection()
	await nextTick()
	if (isClientRequestContextCurrent(owner) && props.noteId === id && latestMode.value && !query.isFetching.value) await query.refetch()
}
async function showBeginning() {
	if (!isClientRequestContextCurrent(owner)) return
	const id = props.noteId
	latestMode.value = false
	cursors.value = [0]
	page.value = 0
	frozen.value = undefined
	clearSelection()
	await nextTick()
	if (isClientRequestContextCurrent(owner) && props.noteId === id && !latestMode.value) heading.value?.focus({preventScroll: true})
}

function captureSelection() {
	if (!isClientRequestContextCurrent(owner)) return
	pauseFollow()
	const selected = window.getSelection()
	const root = sourceRoot.value
	if (!root || !selected?.anchorNode || !selected.focusNode) return
	if (!root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return
	selectedText.value = selected.toString().trim()
}
function selectPage() {
	if (!isClientRequestContextCurrent(owner)) return
	pauseFollow()
	selection.value = allSelected.value ? [] : visibleSegments.value.map(segment => segment.id)
	selectedText.value = ''
}
function clearSelection() {
	selection.value = []
	selectedText.value = ''
}
function segmentSelectionChanged() {
	pauseFollow()
	selectedText.value = ''
}
function appendToArticle() {
	if (!isClientRequestContextCurrent(owner) || !source.value.trim() || added.value) return
	emit('append', source.value)
	added.value = true
}
async function changePage(forward: boolean) {
	if (latestMode.value || query.isFetching.value) return
	if (forward) {
		if (!query.data.value?.has_more) return
		cursors.value = [...cursors.value.slice(0, page.value + 1), query.data.value.next_cursor]
		page.value++
	} else {
		if (page.value === 0) return
		page.value--
	}
	await nextTick()
	heading.value?.focus({preventScroll: true})
}
function openHandoff() {
	if (!isClientRequestContextCurrent(owner) || !source.value.trim()) return
	handoff.value = source.value
	handoffEmpty.value = false
	navigationError.value = false
	handoffOpen.value = true
}
async function sendToArona() {
	if (!isClientRequestContextCurrent(owner) || navigating.value) return
	if (!handoff.value.trim()) {
		handoffEmpty.value = true
		await nextTick()
		if (isClientRequestContextCurrent(owner) && handoffOpen.value) handoffField.value?.focus()
		return
	}
	navigating.value = true
	navigationError.value = false
	const text = [
		instructions.value,
		t('notes.arona.sourceLabel', {title: props.noteTitle, id: props.noteId}),
		`[${t('notes.arona.sourceLink')}](/notes/${props.noteId})`,
		handoff.value,
	].join('\n\n')
	try {
		const notesDraft = stageAronaDraftHandoff(text)
		const failure = await router.push({name: 'tcy-ai', query: {notesDraft}})
		if (isClientRequestContextCurrent(owner) && !failure) handoffOpen.value = false
	} catch (cause) {
		if (isClientRequestContextCurrent(owner) && !isRequestContextAbort(cause)) navigationError.value = true
	} finally {
		if (isClientRequestContextCurrent(owner)) navigating.value = false
	}
}
</script>

<template>
	<section
		class="note-transcripts"
		:aria-labelledby="`${ids}-title`"
	>
		<header class="note-transcripts__header">
			<div>
				<h2
					:id="`${ids}-title`"
					ref="heading"
					tabindex="-1"
				>
					{{ t('notes.transcript.title') }}
				</h2>
				<p>{{ t('notes.transcript.help') }}</p>
			</div>
		</header>
		<LiveVoiceRecorder
			:note-id="noteId"
			@segment="segmentSaved"
			@active="recordingChanged"
		/>
		<div class="note-transcripts__browsing">
			<button
				type="button"
				:aria-pressed="latestMode"
				@click="showLatest"
			>
				{{ t('notes.transcript.latest') }}
			</button>
			<button
				type="button"
				:aria-pressed="!latestMode"
				@click="showBeginning"
			>
				{{ t('notes.transcript.beginning') }}
			</button>
		</div>
		<p
			v-if="latestMode"
			class="note-transcripts__follow-status"
			role="status"
		>
			<strong>{{ t(frozen ? 'notes.transcript.paused' : 'notes.transcript.following') }}</strong>
			<span>{{ t('notes.transcript.pauseHelp') }}</span>
		</p>
		<div
			v-if="latestMode && query.data.value?.incomplete"
			class="note-transcripts__selected-text"
			role="status"
		>
			<p>{{ t('notes.transcript.incomplete') }}</p>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-disabled="query.isFetching.value"
				@click="showLatest"
			>
				{{ t('notes.transcript.refreshLatest') }}
			</XButton>
		</div>
		<LoadError
			v-if="query.isError.value"
			:message="t('notes.transcript.loadFailed')"
			:retry="query.refetch"
		/>
		<p
			v-if="query.isPending.value"
			role="status"
		>
			{{ t('notes.transcript.loading') }}
		</p>
		<template v-else-if="visibleSegments.length">
			<div class="note-transcripts__selection">
				<button
					type="button"
					:aria-pressed="allSelected"
					@click="selectPage"
				>
					{{ t('notes.transcript.selectPage') }}
				</button>
				<button
					v-if="source"
					type="button"
					@click="clearSelection"
				>
					{{ t('notes.transcript.clearSelection') }}
				</button>
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-disabled="!source.trim() || added"
					@click="appendToArticle"
				>
					{{ t('notes.transcript.append') }}
				</XButton>
				<XButton
					:shadow="false"
					:aria-disabled="!source.trim()"
					@click="openHandoff"
				>
					<Icon icon="comments" /> {{ t('notes.arona.open') }}
				</XButton>
			</div>
			<p
				v-if="added"
				class="note-transcripts__selected-text"
				role="status"
			>
				{{ t('notes.transcript.added') }}
			</p>
			<p
				v-if="selectedText"
				class="note-transcripts__selected-text"
				role="status"
			>
				{{ t('notes.transcript.textSelected', {n: selectedText.length}) }}
			</p>
			<ol
				ref="sourceRoot"
				class="note-transcripts__list"
				:class="{'note-transcripts__list--latest': latestMode}"
				tabindex="0"
				:aria-label="t('notes.transcript.title')"
				@pointerdown="pauseFollow"
				@wheel.passive="pauseFollow"
				@focusin="pauseFollow"
				@pointerup="captureSelection"
				@keyup="captureSelection"
			>
				<li
					v-for="segment in visibleSegments"
					:key="segment.id"
					class="note-transcript"
				>
					<label class="note-transcript__check">
						<input
							v-model="selection"
							type="checkbox"
							:value="segment.id"
							:aria-label="t('notes.transcript.selectSegment', {time: transcriptTime(segment.start_ms)})"
							@change="segmentSelectionChanged"
						>
					</label>
					<div class="note-transcript__content">
						<div class="note-transcript__meta">
							<span :title="segment.timing_estimated ? t('notes.transcript.estimatedTiming') : undefined">
								{{ segment.timing_estimated ? '≈ ' : '' }}{{ transcriptTime(segment.start_ms) }}–{{ transcriptTime(segment.end_ms) }}
							</span>
							<time
								v-if="captureLabel(segment)"
								:datetime="segment.captured_at ?? undefined"
								:title="t('notes.transcript.captureClock', {zone: preferences.timezone.value})"
							>{{ captureLabel(segment) }}</time>
							<span v-else>{{ t('notes.transcript.captureUnknown') }}</span>
						</div>
						<p>{{ segment.text }}</p>
						<small
							v-if="segment.append_to_article && !segment.article_appended"
							role="status"
						>{{ t('notes.transcript.articleFull') }}</small>
					</div>
				</li>
			</ol>
		</template>
		<p
			v-else-if="!query.isError.value"
			class="note-transcripts__empty"
		>
			{{ t('notes.transcript.empty') }}
		</p>
		<nav
			v-if="!latestMode && (page > 0 || query.data.value?.has_more)"
			class="note-transcripts__pagination"
			:aria-label="t('notes.transcript.pagination')"
		>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-disabled="page === 0 || query.isFetching.value"
				@click="changePage(false)"
			>
				{{ t('notes.transcript.earlier') }}
			</XButton>
			<span>{{ t('notes.page', {page: page + 1}) }}</span>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-disabled="!query.data.value?.has_more || query.isFetching.value"
				@click="changePage(true)"
			>
				{{ t('notes.transcript.later') }}
			</XButton>
		</nav>
		<Modal
			v-if="handoffOpen"
			wide
			:confirm-label="t('notes.arona.continue')"
			:loading="navigating"
			@close="handoffOpen = false"
			@submit="sendToArona"
		>
			<template #header>
				{{ t('notes.arona.title') }}
			</template>
			<template #text>
				<p>{{ t('notes.arona.help') }}</p>
				<p>{{ t('notes.arona.toolsHelp') }}</p>
				<label :for="`${ids}-preset`">{{ t('notes.arona.preset') }}</label>
				<select
					:id="`${ids}-preset`"
					v-model="preset"
					class="input"
				>
					<option value="organize">
						{{ t('notes.arona.organize') }}
					</option>
					<option value="plan">
						{{ t('notes.arona.plan') }}
					</option>
				</select>
				<p class="note-transcripts__instruction">
					{{ instructions }}
				</p>
				<label :for="`${ids}-handoff`">{{ t('notes.arona.source') }}</label>
				<textarea
					:id="`${ids}-handoff`"
					ref="handoffField"
					v-model="handoff"
					class="textarea note-transcripts__handoff"
					:aria-invalid="handoffEmpty || undefined"
					:aria-describedby="handoffEmpty ? `${ids}-empty` : undefined"
				/>
				<p
					v-if="handoffEmpty"
					:id="`${ids}-empty`"
					role="alert"
				>
					{{ t('notes.arona.emptySource') }}
				</p>
				<p
					v-if="navigationError"
					role="alert"
				>
					{{ t('notes.arona.navigationFailed') }}
				</p>
			</template>
		</Modal>
	</section>
</template>

<style scoped lang="scss">
.note-transcripts {
	display: flex;
	min-inline-size: 0;
	flex-direction: column;
	gap: var(--space-4);
}

.note-transcripts__header h2 {
	margin: 0;
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
}

.note-transcripts__header p, .note-transcripts__empty {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.note-transcripts__selection, .note-transcripts__pagination, .note-transcripts__browsing {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.note-transcripts__selection > button, .note-transcripts__browsing > button {
	min-block-size: 44px;
	border: 0;
	background: transparent;
	color: var(--link);
	cursor: pointer;
}

.note-transcripts__browsing > button[aria-pressed='true'] {
	border-radius: var(--radius-sm);
	background: var(--tint-primary);
	font-weight: var(--weight-semibold);
}

.note-transcripts__selection > .button {
	margin-inline-start: auto;
}

.note-transcripts__selected-text {
	padding: var(--space-2);
	border-radius: var(--radius-sm);
	background: var(--tint-primary);
	font-size: var(--text-sm);
}

.note-transcripts__follow-status {
	display: grid;
	gap: var(--space-1);
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.note-transcripts__follow-status strong {
	min-block-size: 1.5em;
	line-height: 1.5;
}

.note-transcripts__list {
	margin: 0;
	padding: 0;
	list-style: none;
}

.note-transcripts__list--latest {
	max-block-size: min(60dvh, 42rem);
	overflow-y: auto;
	overscroll-behavior-y: contain;
	scrollbar-gutter: stable;
}

.note-transcript {
	display: flex;
	gap: var(--space-2);
	padding-block: var(--space-3);
	border-block-end: 1px solid var(--border-subtle);
}

.note-transcript__check {
	display: grid;
	flex: 0 0 44px;
	align-self: flex-start;
	min-block-size: 44px;
	place-items: center;
	cursor: pointer;
}

.note-transcript__check input {
	inline-size: 18px;
	block-size: 18px;
}

.note-transcript__content {
	min-inline-size: 0;
	flex: 1;
}

.note-transcript__content p {
	margin-block-start: var(--space-2);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	line-height: 1.75;
}

.note-transcript__meta {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.note-transcripts__pagination {
	justify-content: space-between;
	font-size: var(--text-sm);
}

.note-transcripts__instruction {
	padding: var(--space-3);
	background: var(--surface-sunken);
	font-size: var(--text-sm);
}

.note-transcripts__handoff {
	min-block-size: 15rem;
	margin-block: var(--space-2) var(--space-4);
}

@media (width <= 600px) {
	.note-transcripts__selection > .button {
		inline-size: 100%;
		margin-inline-start: 0;
	}
}
</style>
