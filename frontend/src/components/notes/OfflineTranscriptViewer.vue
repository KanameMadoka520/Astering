<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import type {OfflineTranscriptPage} from '@/composables/useOfflineNoteSync'
import {transcriptCapturedTime} from '@/helpers/notes/text'
import Modal from '@/components/misc/Modal.vue'
import XButton from '@/components/input/Button.vue'

const props = defineProps<{
	page?: OfflineTranscriptPage,
	busy: boolean,
	failed: boolean,
	timezone: string,
}>()
const emit = defineEmits<{close: [], load: [cursor: string]}>()
const {t, locale} = useI18n({useScope: 'global'})
const history = ref([''])
const copied = ref(false)
const copyFailed = ref(false)
const source = computed(() => (props.page?.entries ?? []).map(row => {
	const time = transcriptCapturedTime({captured_at: row.captured_at, timezone: props.timezone}, props.timezone, locale.value)
	return `${time ? `[${time}] ` : ''}${row.text}`
}).join('\n\n'))

function move(next: boolean) {
	if (props.busy || props.failed) return
	if (next) {
		if (!props.page?.has_more) return
		if (!props.page.next_cursor) return
		history.value.push(props.page.next_cursor)
	} else {
		if (history.value.length < 2) return
		history.value.pop()
	}
	copied.value = false
	emit('load', history.value[history.value.length - 1])
}
async function copy() {
	if (props.busy || !source.value) return
	try {
		await navigator.clipboard.writeText(source.value)
		copied.value = true
		copyFailed.value = false
	} catch {
		copyFailed.value = true
	}
}
</script>

<template>
	<Modal
		variant="sheet"
		:title="t('liveNotes.viewPending')"
		@close="emit('close')"
	>
		<div class="offline-transcripts">
			<p>{{ t('liveNotes.pendingHelp') }}</p>
			<p
				v-if="busy"
				role="status"
			>
				{{ t('liveNotes.pendingLoading') }}
			</p>
			<div
				v-if="failed"
				role="alert"
			>
				<p>{{ t('liveNotes.offlineActionFailed') }}</p>
				<XButton
					variant="secondary"
					@click="emit('load', history[history.length - 1])"
				>
					{{ t('misc.retry') }}
				</XButton>
			</div>
			<ol
				v-if="page?.entries.length"
				:aria-busy="busy"
			>
				<li
					v-for="row in page.entries"
					:key="row.client_id"
				>
					<div class="offline-transcripts__meta">
						<span>{{ t('liveNotes.targetNote', {id: row.note_id}) }}</span>
						<time
							v-if="row.captured_at"
							:datetime="row.captured_at"
						>{{ transcriptCapturedTime({captured_at: row.captured_at, timezone}, timezone, locale) }}</time>
					</div>
					<p>{{ row.text }}</p>
				</li>
			</ol>
			<p v-else-if="!busy && !failed">
				{{ t('liveNotes.pendingEmpty') }}
			</p>
			<div class="offline-transcripts__actions">
				<XButton
					variant="secondary"
					:aria-disabled="busy || failed || history.length < 2"
					@click="move(false)"
				>
					{{ t('notes.transcript.earlier') }}
				</XButton>
				<XButton
					variant="secondary"
					:aria-disabled="busy || failed || !page?.has_more"
					@click="move(true)"
				>
					{{ t('notes.transcript.later') }}
				</XButton>
				<XButton
					:aria-disabled="busy || !source"
					@click="copy"
				>
					{{ t(copied ? 'liveNotes.copied' : 'liveNotes.copyPendingPage') }}
				</XButton>
			</div>
			<p
				v-if="copyFailed"
				role="alert"
			>
				{{ t('liveNotes.copyFailed') }}
			</p>
		</div>
	</Modal>
</template>

<style scoped lang="scss">
.offline-transcripts {
	min-inline-size: 0;
	font-size: .9rem;
	line-height: 1.65;

	ol {
		padding: 0;
		list-style: none;
	}

	li {
		padding-block: .75rem;
		border-block-end: 1px solid var(--border-subtle);
	}

	li p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	&__meta {
		display: flex;
		flex-wrap: wrap;
		gap: .4rem 1rem;
		color: var(--text-secondary);
		font-size: .8rem;
	}

	&__actions {
		display: flex;
		flex-wrap: wrap;
		gap: .5rem;
		margin-block-start: 1rem;
	}

	&__actions :deep(.button) {
		min-block-size: 2.75rem;
	}
}
</style>
